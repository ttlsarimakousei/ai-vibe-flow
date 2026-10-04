'use strict';
/*
 * 假 redis：认 ttls-redis 的客户端会发的那几条命令。数据在内存里，分库（0 到 15）。
 * key 和值按字节存（内部用 latin1 的字符串表示字节），二进制的 key 不会被弄坏。
 * 用法：node fake-redis.js <端口> [口令] [--many <N>] [--slow-scan <毫秒>]
 *   --many N         0 号库里另外放 N 个 bulk:<序号> 的 key（测库很大的时候遍历看不完）
 *   --slow-scan MS   每一轮 SCAN 先等这么久再回（测遍历按时间收尾）
 * 启动时自带几条数据（0 号库）：
 *   str:1 = 你好        hash:1 = { a: 1, 名字: 张三 }     list:1 = [x, y]     set:1 = {m}     zset:1 = [{one,1},{two,2}]
 *   many:0 … many:249（用来测游标遍历）
 *   ttl:1 = 会过期的（30 分钟后过期）
 *   big:list = 1200 个元素       big:str = 10 万个字节
 *   一个二进制的 key（Java 序列化的开头 ac ed 00 05）= 二进制的值
 * 3 号库：only:db3 = 3
 */
const net = require('net');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const plain = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const PORT = Number(plain[0]) || 16379;
const PASSWORD = plain[1] || '';
const MANY = Number(flag('--many')) || 0;
const SLOW_SCAN = Number(flag('--slow-scan')) || 0;

const B = (s) => Buffer.from(String(s), 'utf8').toString('latin1');     // 文字 → 字节（内部表示）
const dbs = new Map();
const db = (n) => { if (!dbs.has(n)) dbs.set(n, new Map()); return dbs.get(n); };
const put = (n, k, t, v, exp) => db(n).set(B(k), { t, v: Array.isArray(v) ? v.map(B) : B(v), exp: exp || 0 });
put(0, 'str:1', 'string', '你好');
put(0, 'hash:1', 'hash', ['a', '1', '名字', '张三']);
put(0, 'list:1', 'list', ['x', 'y']);
put(0, 'set:1', 'set', ['m']);
put(0, 'zset:1', 'zset', ['one', '1', 'two', '2']);
put(0, 'stream:1', 'stream', []);
for (let i = 0; i < 250; i++) put(0, 'many:' + i, 'string', String(i));
put(0, 'ttl:1', 'string', '会过期的', Date.now() + 30 * 60000);
put(0, 'big:list', 'list', Array.from({ length: 1200 }, (x, i) => 'e' + i));
put(0, 'big:str', 'string', 'x'.repeat(100000));
db(0).set(Buffer.from([0xac, 0xed, 0x00, 0x05, 0x74, 0x00, 0x03, 0x6b, 0x65, 0x79]).toString('latin1'), { t: 'string', v: Buffer.from([0xac, 0xed, 0x00, 0x05, 0xff, 0xfe]).toString('latin1'), exp: 0 });
for (let i = 0; i < MANY; i++) put(0, 'bulk:' + i, 'string', '1');
put(3, 'only:db3', 'string', '3');

const bytes = (s) => Buffer.from(String(s), 'latin1');
const bulk = (s) => (s === null ? Buffer.from('$-1\r\n') : Buffer.concat([Buffer.from('$' + bytes(s).length + '\r\n'), bytes(s), Buffer.from('\r\n')]));
const arr = (a) => Buffer.concat([Buffer.from('*' + a.length + '\r\n')].concat(a.map((x) => (Array.isArray(x) ? arr(x) : bulk(x)))));
const text = (s) => Buffer.from(s + '\r\n');
const glob = (p) => new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]') + '$');

function parse(buf) {
  // 只认客户端发的那种：数组里全是批量字符串
  if (!buf.length || buf[0] !== 0x2a) return null;
  let p = buf.indexOf('\r\n');
  if (p < 0) return null;
  const n = Number(buf.slice(1, p).toString());
  let at = p + 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (at >= buf.length || buf[at] !== 0x24) return null;
    p = buf.indexOf('\r\n', at);
    if (p < 0) return null;
    const len = Number(buf.slice(at + 1, p).toString());
    if (buf.length < p + 2 + len + 2) return null;
    out.push(buf.slice(p + 2, p + 2 + len).toString('latin1'));
    at = p + 2 + len + 2;
  }
  return { args: out, rest: buf.slice(at) };
}

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let authed = !PASSWORD;
  let cur = 0;
  let busy = Promise.resolve();
  sock.on('error', () => {});
  const live = (m, k) => { const e = m.get(k); if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return null; } return e || null; };
  const optOf = (a, name, def) => { const i = a.findIndex((x) => new RegExp('^' + name + '$', 'i').test(x)); return i >= 0 ? a[i + 1] : def; };
  const page = (list, a, step) => {
    const start = Number(a[0]) || 0;
    const count = (Number(optOf(a, 'count', 10)) || 10) * step;
    const next = start + count >= list.length ? 0 : start + count;
    return { slice: list.slice(start, start + count), next };
  };
  const handle = async (cmd, a) => {
    const c = String(cmd || '').toUpperCase();
    if (c === 'AUTH') {
      const pw = a.length > 1 ? a[1] : a[0];
      if (!PASSWORD) return text('-ERR Client sent AUTH, but no password is set');
      if (pw === B(PASSWORD)) { authed = true; return text('+OK'); }
      return text('-WRONGPASS invalid username-password pair or user is disabled.');
    }
    if (!authed) return text('-NOAUTH Authentication required.');
    const m = db(cur);
    const e = a.length ? live(m, a[0]) : null;
    if (c === 'PING') return text('+PONG');
    if (c === 'SELECT') { const n = Number(a[0]); if (!(n >= 0 && n <= 15)) return text('-ERR DB index is out of range'); cur = n; return text('+OK'); }
    if (c === 'INFO') return bulk('# Server\r\nredis_version:7.0.0-fake\r\n');
    if (c === 'DBSIZE') return text(':' + m.size);
    if (c === 'TYPE') return text('+' + (e ? e.t : 'none'));
    if (c === 'GET') return bulk(e ? e.v : null);
    if (c === 'STRLEN') return text(':' + (e ? bytes(e.v).length : 0));
    if (c === 'GETRANGE') return bulk(e ? bytes(e.v).subarray(Number(a[1]), Number(a[2]) + 1).toString('latin1') : '');
    if (c === 'SET') {
      const px = Number(optOf(a.slice(2), 'px', 0)) || 0;
      m.set(a[0], { t: 'string', v: a[1], exp: px ? Date.now() + px : 0 });
      return text('+OK');
    }
    if (c === 'DEL') { let n = 0; for (const k of a) if (live(m, k) && m.delete(k)) n++; return text(':' + n); }
    if (c === 'TTL') return text(':' + (!e ? -2 : !e.exp ? -1 : Math.round((e.exp - Date.now()) / 1000)));
    if (c === 'PTTL') return text(':' + (!e ? -2 : !e.exp ? -1 : e.exp - Date.now()));
    if (c === 'HLEN' || c === 'ZCARD') return text(':' + (e ? e.v.length / 2 : 0));
    if (c === 'LLEN' || c === 'SCARD') return text(':' + (e ? e.v.length : 0));
    if (c === 'HGETALL' || c === 'SMEMBERS') return arr(e ? e.v : []);
    if (c === 'LRANGE') { const to = Number(a[2]); return arr(e ? e.v.slice(Number(a[1]), to < 0 ? undefined : to + 1) : []); }
    if (c === 'ZRANGE') { const to = Number(a[2]); return arr(e ? e.v.slice(Number(a[1]) * 2, to < 0 ? undefined : (to + 1) * 2) : []); }
    if (c === 'HSCAN' || c === 'SSCAN') { const r = page(e ? e.v : [], a.slice(1), c === 'HSCAN' ? 2 : 1); return Buffer.concat([Buffer.from('*2\r\n'), bulk(String(r.next)), arr(r.slice)]); }
    if (c === 'SCAN') {
      if (SLOW_SCAN) await new Promise((r) => setTimeout(r, SLOW_SCAN));
      const pat = glob(optOf(a, 'match', '*'));
      const r = page([...m.keys()], a, 1);
      return Buffer.concat([Buffer.from('*2\r\n'), bulk(String(r.next)), arr(r.slice.filter((k) => pat.test(k)))]);
    }
    return text('-ERR unknown command `' + cmd + '`');
  };
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = parse(buf);
      if (!r) break;
      buf = r.rest;
      const [cmd, ...a] = r.args;
      // 一条一条按顺序回
      busy = busy.then(() => handle(cmd, a)).then((out) => { try { sock.write(out); } catch (e) { /* 对面关了 */ } });
    }
  });
}).listen(PORT, '127.0.0.1', () => process.stdout.write('READY ' + PORT + '\n'));
