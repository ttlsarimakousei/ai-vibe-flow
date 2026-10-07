#!/usr/bin/env node
/**
 * redis 直连客户端（零依赖，只用 Node 自带的 net、dns）。ttls-redis 技能用。
 *
 * 用法：node redis.js [--conn <连接名>] [--project <项目目录>] [--config <配置文件>] <子命令> [参数...]
 *   子命令：conns | ping | info | get <key> | keys <pattern> | ttl <key> | set <key> <value> | del <key...>
 *   --conn 这几个选项写在哪都认。别的以 -- 开头的参数一律不收（不会被当成 key）。
 *   get、keys 可以加 --limit <N>：最多取多少个元素 / key。get 字符串可以加 --full：不截。
 *   set 的值可以不走命令行：--value-file <文件>，或者 --value-stdin（从标准输入读）。
 *   key 不是合法的 UTF-8（Java 序列化写进去的）时，输出成 hex:<十六进制>；get、ttl、del 的 key 也可以这么给。
 *
 * 连接信息从配置文件里按连接名取，**不从命令行传**：命令行会进会话记录和进程列表，口令不能放在那里。
 * 配置文件 <项目>/.vibe/redis.json（vibe-kit 后台自动探索会写，只写开发环境的）：
 *   { "connections": { "dev": { "host": "127.0.0.1", "port": 6379, "password": "", "db": 0 } } }
 * 口令可以写明文、${ENV:变量名}、${FILE:路径}。
 * 以前的位置 <项目>/.claude/project.local.json 的 redis 段照样认（连接名算 main）。
 *
 * 输出（stdout，单行 JSON）：
 *   成功 {"ok":true,"data":<结果>[,"truncated":bool,…][,"exists":false][,"deleted":N]}
 *   失败 {"ok":false,"code":"<错误码>","error":"<说明>"}
 *
 * 错误码：NO_CONFIG | NO_CONN | CONN_REFUSED | NET_UNREACHABLE | HOST_UNRESOLVED | CONN_LOST | TIMEOUT | CMD_TIMEOUT
 *        | AUTH_FAILED | REDIS_ERROR | UNSUPPORTED_TYPE | UNSUPPORTED_MODE | BLOCKED | BAD_ARGS | UNKNOWN
 *
 * 退出码：0 做完了（含 ok:false 的业务失败）；1 参数错误、内部异常；3 被拦下（全自动模式下的写操作）
 *
 * 安全：不提供 FLUSHALL / FLUSHDB / CONFIG 这类清库、改配置的子命令（脚本做不到）。
 *      全自动模式（用户不在：开关开着、这个会话又在走 OpenSpec 流程）下 set、del 不做，留给用户。
 *      一条命令在一个连接里做完：先认证、切库，确认成功了才发后面的命令。
 *      （以前是一起发出去：切库失败的时候，写命令照样在 0 号库里执行了。）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const path = require('path');

const TOOL = 'ttls-redis';
const CONNECT_TIMEOUT_MS = 3000;    // 连接超时：连不上的很快知道
const COMMAND_TIMEOUT_MS = 5000;    // 一条命令多久没有回话算超时
const SCAN_COUNT = 1000;            // 遍历时每一轮让服务器看多少个 key
const SCAN_BUDGET_MS = 3000;        // 遍历最多花多久
const KEYS_LIMIT = 1000;            // keys 默认最多返回多少个
const ITEMS_LIMIT = 500;            // get 一个列表、集合、哈希默认最多取多少个元素
const LIMIT_MAX = 10000;
const STRING_BYTES = 64 * 1024;     // get 一个字符串默认最多取多少字节
const STRING_BYTES_FULL = 8 * 1024 * 1024;

// ---------- vibe-kit：开关、用量 ----------
function kitDir() {
  const cands = [path.join(__dirname, '..', '..', '..', 'vibe-kit')];
  if (process.env.CLAUDE_CONFIG_DIR) cands.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'vibe-kit'));
  cands.push(path.join(os.homedir(), '.claude', 'vibe-kit'));
  for (const c of cands) { try { if (fs.statSync(c).isDirectory()) return path.resolve(c); } catch (e) { /* 不在 */ } }
  return '';
}
/**
 * 这条命令是不是在全自动模式下跑的（用户不在）。只认配置页打开的（封条里记着）。
 * 全自动模式只在走 OpenSpec 流程的会话里算数：跑命令之前套件的钩子留了一张条子（state/tool-flow.json，按当前目录记，
 * 两分钟内有效），条子说这个会话不在流程里（用户在），就不算。没有条子（钩子没经过）按用户不在算
 */
function autoMode() {
  const kit = kitDir();
  if (!kit) return false;
  const cfg = readJson(path.join(kit, 'config.json'));
  const seal = readJson(path.join(kit, 'state', 'config-seal.json'));
  if (!(cfg && cfg.autoMode === true && !(seal && seal.autoMode === false))) return false;
  const t = readJson(path.join(kit, 'state', 'tool-flow.json'));
  const rec = t && t.byCwd && t.byCwd[path.resolve(process.cwd()).split(path.sep).join('/').toLowerCase()];
  const age = rec ? Date.now() - Number(rec.at) : -1;
  if (rec && age >= 0 && age <= 120000) return rec.auto === true;
  return true;
}
function readJson(file) {
  try { let t = fs.readFileSync(file, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; }
}
/** 记一条用量（或者工具自己的毛病）。只记命令、耗时、错误的类别：key、值、地址、口令一概不记 */
function record(rec) {
  const kit = kitDir();
  if (!kit) return;
  try {
    const dir = path.join(kit, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tool-usage.jsonl'), JSON.stringify(Object.assign({ tool: TOOL, at: Date.now() }, rec)) + '\n');
  } catch (e) { /* 记不上不影响正事 */ }
}

// ---------- 配置 ----------
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function findConfig(start, explicit) {
  if (explicit) return fs.existsSync(explicit) ? { file: path.resolve(explicit), kind: 'vibe' } : null;
  const hit = (dir) => {
    const a = path.join(dir, '.vibe', 'redis.json');
    if (fs.existsSync(a)) return { file: a, kind: 'vibe' };
    const b = path.join(dir, '.claude', 'project.local.json');
    const j = fs.existsSync(b) ? readJson(b) : null;
    if (j && isObj(j.redis)) return { file: b, kind: 'legacy' };
    return null;
  };
  // 当前目录，再往上（在子模块里开的会话），到仓库根或者 5 层为止。
  // 当前目录自己就是仓库根的不往上找：上面是别的项目，用了它的配置就连到别人的 redis 上去了
  let d = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const h = hit(d);
    if (h) return h;
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // 往下（人在壳子上，配置在里面的后端下）：最多 3 层，找到好几份就不猜
  const below = [];
  const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '.claude', '.vibe']);
  const walk = (dir, depth) => {
    if (depth > 3 || below.length > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name[0] === '.') continue;
      const sub = path.join(dir, e.name);
      const h = hit(sub);
      if (h) { below.push(h); continue; }
      walk(sub, depth + 1);
    }
  };
  walk(path.resolve(start), 1);
  if (below.length === 1) return below[0];
  if (below.length > 1) return { many: below.map((b) => b.file) };
  return null;
}
function resolvePassword(raw) {
  const s = String(raw == null ? '' : raw);
  const m = /^\$\{(ENV|FILE):(.+)\}$/.exec(s.trim());
  if (!m) return s;
  if (m[1] === 'ENV') {
    const v = process.env[m[2].trim()];
    if (v == null) throw mkErr('NO_CONFIG', '口令要从环境变量 ' + m[2].trim() + ' 取，但这个变量没有值');
    return v;
  }
  try { return fs.readFileSync(m[2].trim().replace(/^~(?=[\\/])/, os.homedir()), 'utf8').split(/\r?\n/)[0].trim(); } catch (e) { throw mkErr('NO_CONFIG', '口令文件读不了：' + m[2].trim()); }
}
function loadConnections(start, explicit) {
  const c = findConfig(start, explicit);
  if (!c) throw mkErr('NO_CONFIG', '找不到 redis 的连接配置。vibe-kit 后台探索项目时会自动写（只写开发环境的）；要手工配，由用户建 ' + path.join(path.resolve(start), '.vibe', 'redis.json') + '：{"connections":{"dev":{"host":"127.0.0.1","port":6379,"password":"","db":0}}}。测试、生产环境的 redis 不要自己往里配');
  if (c.many) throw mkErr('NO_CONFIG', '子目录里有好几份配置，不知道该用哪个：' + c.many.join('、') + '。用 --project 指到某个项目');
  const j = readJson(c.file);
  if (!j) throw mkErr('NO_CONFIG', '配置文件读不了（不是合法的 JSON）：' + c.file);
  const conns = {};
  if (c.kind === 'legacy') conns.main = j.redis;
  else if (isObj(j.connections)) for (const k of Object.keys(j.connections)) if (isObj(j.connections[k])) conns[k] = j.connections[k];
  if (!Object.keys(conns).length) throw mkErr('NO_CONFIG', '配置文件里一个连接都没有：' + c.file);
  return { file: c.file, conns };
}
function pickConn(all, name) {
  const names = Object.keys(all.conns);
  if (!name) {
    if (names.length === 1) return Object.assign({ name: names[0] }, all.conns[names[0]]);
    throw mkErr('NO_CONN', '配置里有 ' + names.length + ' 个连接，要用 --conn 指定：' + names.join('、'));
  }
  if (!all.conns[name]) throw mkErr('NO_CONN', '没有叫 ' + name + ' 的连接。配置里有：' + names.join('、'));
  return Object.assign({ name }, all.conns[name]);
}

// ---------- 协议：编码 ----------
/** 一条命令编码成字节。参数可以是字符串、数字，也可以是 Buffer（二进制的 key） */
function encodeCommand(args) {
  const parts = [Buffer.from('*' + args.length + '\r\n')];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from('$' + b.length + '\r\n'), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

class RedisError extends Error {}

// ---------- 协议：解码 ----------
/**
 * 一边收一边解。解到一半的状态留着（数组收了几个元素），下一块数据来了接着解：
 * 几十兆的列表分成几百块到达，不会每来一块就从头再解一遍。
 * 批量字符串解出来是 Buffer（可能是二进制的），要不要当文字看由上层定。
 */
class Parser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pos = 0;
    this.stack = [];        // 正在收的数组：{ arr, need }
    this.out = [];          // 解完的回复
    this.pending = [];      // 在等一个很长的批量字符串：先把数据块攒着，够了再拼
    this.pendingLen = 0;
    this.want = 0;          // 从 pos 起至少还要多少字节才解得下去
  }

  push(chunk) {
    if (this.want && this.buf.length - this.pos + this.pendingLen + chunk.length < this.want) {
      this.pending.push(chunk);
      this.pendingLen += chunk.length;
      return;
    }
    const rest = this.pos ? this.buf.subarray(this.pos) : this.buf;
    this.buf = Buffer.concat([rest].concat(this.pending, [chunk]));
    this.pos = 0;
    this.pending = [];
    this.pendingLen = 0;
    this.want = 0;
    this.run();
  }

  give(v) {
    while (this.stack.length) {
      const top = this.stack[this.stack.length - 1];
      top.arr.push(v);
      if (top.arr.length < top.need) return;
      this.stack.pop();
      v = top.arr;
    }
    this.out.push(v);
  }

  run() {
    for (;;) {
      if (this.pos >= this.buf.length) return;
      const nl = this.buf.indexOf('\r\n', this.pos);
      if (nl < 0) return;
      const type = this.buf[this.pos];
      const line = this.buf.toString('utf8', this.pos + 1, nl);
      const next = nl + 2;
      if (type === 0x2b) { this.pos = next; this.give(line); continue; }                    // + 简单字符串
      if (type === 0x2d) { this.pos = next; this.give(new RedisError(line)); continue; }    // - 错误
      if (type === 0x3a) { this.pos = next; this.give(Number(line)); continue; }            // : 整数
      if (type === 0x24) {                                                                  // $ 批量字符串
        const len = Number(line);
        if (len < 0) { this.pos = next; this.give(null); continue; }
        if (this.buf.length < next + len + 2) { this.want = next + len + 2 - this.pos; return; }
        const v = Buffer.from(this.buf.subarray(next, next + len));
        this.pos = next + len + 2;
        this.give(v);
        continue;
      }
      if (type === 0x2a) {                                                                  // * 数组
        const n = Number(line);
        this.pos = next;
        if (n < 0) this.give(null);
        else if (n === 0) this.give([]);
        else this.stack.push({ arr: [], need: n });
        continue;
      }
      throw new Error('不认识的回复类型：' + String.fromCharCode(type));
    }
  }
}
/** 以前的接口（一次解一条，解不全返回 null），留着给用到它的地方 */
function parseReply(buf) {
  const p = new Parser();
  p.push(buf);
  if (!p.out.length) return null;
  const used = p.pos;
  return { value: p.out[0], rest: p.buf.subarray(used) };
}

function mkErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function mapSocketError(e) {
  const c = e && e.code;
  if (c === 'ECONNREFUSED') return mkErr('CONN_REFUSED', `连接被拒绝（${e.address}:${e.port}）：redis 没起，或者端口不对`);
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return mkErr('HOST_UNRESOLVED', `主机名解析不了（${e.hostname || ''}）`);
  if (c === 'ENETUNREACH' || c === 'EHOSTUNREACH' || c === 'EACCES' || c === 'EADDRNOTAVAIL') return mkErr('NET_UNREACHABLE', '网络不通（' + c + '）：VPN 没连，或者地址是别的网段的');
  if (c === 'ECONNRESET' || c === 'EPIPE') return mkErr('CONN_LOST', '连接中断');
  if (c === 'ETIMEDOUT') return mkErr('TIMEOUT', '连接超时');
  return mkErr('UNKNOWN', `没归类的网络错误 ${c || ''}: ${e && e.message}`);
}

// ---------- 连接：一个连接里一条一条地发，上一条回了再发下一条 ----------
function open(conn) {
  return new Promise((resolve, reject) => {
    const parser = new Parser();
    let waiting = null;         // { resolve, reject, timer }
    let dead = null;
    let opened = false;

    const fail = (err) => {
      if (dead) return;
      dead = err;
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      sock.destroy();
      if (waiting) { clearTimeout(waiting.timer); const w = waiting; waiting = null; w.reject(err); }
      if (!opened) reject(err);
    };

    // lookup 钩子：主机名解析不了的直接报出来（不然会被连接超时抢先报成超时）
    const sock = net.connect({
      host: conn.host,
      port: conn.port,
      lookup: (hostname, opts, cb) => dns.lookup(hostname, opts, (err, addr, fam) => {
        if (err) return fail(mapSocketError(Object.assign(err, { hostname })));
        cb(err, addr, fam);
      }),
    });
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => fail(mkErr('TIMEOUT', `连接超时（${CONNECT_TIMEOUT_MS} 毫秒连不上）：地址是别的机器、网络不通，或者被防火墙挡了`)));

    const session = {
      send(cmd, timeoutMs) {
        return new Promise((res, rej) => {
          if (dead) return rej(dead);
          if (waiting) return rej(new Error('上一条命令还没回'));
          const ms = timeoutMs || COMMAND_TIMEOUT_MS;
          waiting = { resolve: res, reject: rej, timer: setTimeout(() => fail(mkErr('CMD_TIMEOUT', `命令 ${Math.round(ms / 1000)} 秒没有回话：要取的值太大，或者服务器正忙`)), ms) };
          sock.write(encodeCommand(cmd));
        });
      },
      /** 发一条，回的是错误就抛出来 */
      async call(cmd, timeoutMs) {
        const r = await session.send(cmd, timeoutMs);
        if (r instanceof RedisError) throw mkErr(/NOAUTH|NOPERM/i.test(r.message) ? 'AUTH_FAILED' : 'REDIS_ERROR', r.message);
        return r;
      },
      close() { if (!dead) { dead = mkErr('CONN_LOST', '连接已经关了'); sock.removeAllListeners('error'); sock.on('error', () => {}); sock.destroy(); } },
    };

    sock.on('data', (chunk) => {
      try { parser.push(chunk); } catch (e) { return fail(mkErr('REDIS_ERROR', e.message)); }
      while (parser.out.length && waiting) {
        const w = waiting;
        waiting = null;
        clearTimeout(w.timer);
        w.resolve(parser.out.shift());
      }
    });
    sock.on('error', (e) => fail(mapSocketError(e)));
    sock.on('close', () => fail(mkErr('CONN_LOST', '连接被关掉了，回话没收全')));

    sock.on('connect', async () => {
      sock.setTimeout(0);     // 连上了：后面按每条命令算超时
      try {
        // 先认证、切库，都成了才算连好。有一步不成，后面的命令一条都不发
        if (conn.password) {
          const r = await session.send(conn.username ? ['AUTH', conn.username, conn.password] : ['AUTH', conn.password]);
          if (r instanceof RedisError) throw mkErr('AUTH_FAILED', /without any password|no password is set/i.test(r.message) ? '这个 redis 没有设口令，连接配置里却写了口令：把配置里的口令去掉（' + r.message + '）' : r.message);
        }
        if (conn.db != null && Number(conn.db) !== 0) {
          const r = await session.send(['SELECT', conn.db]);
          if (r instanceof RedisError) throw mkErr(/NOAUTH/i.test(r.message) ? 'AUTH_FAILED' : 'REDIS_ERROR', '切不到 ' + conn.db + ' 号库：' + r.message);
        }
        opened = true;
        resolve(session);
      } catch (e) { fail(e.code ? e : mkErr('UNKNOWN', String(e && e.message))); }
    });
  });
}

// ---------- 值和 key 的文字、二进制 ----------
/** 回复里的一个值给人看：是合法的 UTF-8 就当文字；不是（Java 序列化的 key、压缩过的值）就写成 hex:… */
function show(v, flags) {
  if (v === null || v === undefined) return null;
  if (!Buffer.isBuffer(v)) return v;
  const s = v.toString('utf8');
  if (Buffer.from(s, 'utf8').equals(v)) return s;
  if (flags) flags.binary = true;
  return 'hex:' + v.toString('hex');
}
/** 命令行上给的 key：hex:… 的还原成字节 */
function keyArg(s) {
  const m = /^hex:((?:[0-9a-fA-F]{2})+)$/.exec(String(s));
  return m ? Buffer.from(m[1], 'hex') : String(s);
}
const BINARY_NOTE = '有的 key 或者值不是文字（二进制的，多半是 Java 序列化写进去的），显示成了 hex:…。要读、要删这样的 key，就把 hex:… 原样当 key 给';

// ---------- 子命令 ----------
async function subPing(s) { return { data: show(await s.call(['PING'])) }; }
async function subInfo(s) { return { data: show(await s.call(['INFO'])) }; }
async function subTtl(s, a) { return { data: await s.call(['TTL', keyArg(a[0])]) }; }

/**
 * 写一个 key。原来有过期时间的照样留着（以前直接 SET，30 分钟过期的缓存被改成了永久的）。
 * 返回里带着写进去的值的开头一段：值是从命令行来的，shell 可能已经改过它（去掉引号、把 / 开头的改成路径），对一眼
 */
async function subSet(s, a, opt) {
  const key = keyArg(a[0]);
  const value = opt.value;
  const left = await s.call(['PTTL', key]);
  const cmd = ['SET', key, value];
  if (left > 0) cmd.push('PX', left);
  const r = show(await s.call(cmd));
  const text = Buffer.isBuffer(value) ? show(value) : String(value);
  const out = { data: r, existed: left !== -2, written: text.length > 200 ? text.slice(0, 200) + '…' : text, bytes: Buffer.byteLength(text) };
  if (left > 0) out.kept_ttl_ms = left;
  return out;
}

async function subDel(s, a) {
  const n = await s.call(['DEL'].concat(a.map(keyArg)));
  return { data: n, deleted: n };
}

// get：先看类型，再按类型取。大的只取前面一段，说清一共多少
async function subGet(s, a, opt) {
  const key = keyArg(a[0]);
  const flags = {};
  const limit = opt.limit || ITEMS_LIMIT;
  const t = show(await s.call(['TYPE', key]));
  const done = (o) => { if (flags.binary) { o.binary = true; o.note = [o.note, BINARY_NOTE].filter(Boolean).join('；'); } return o; };
  const cut = (o, total, what) => { if (total > limit) { o.truncated = true; o.total = total; o.note = '一共 ' + total + ' 个' + what + '，这里只取了前 ' + limit + ' 个。要多取加 --limit（最多 ' + LIMIT_MAX + '）'; } return o; };
  switch (t) {
    case 'string': {
      const size = await s.call(['STRLEN', key]);
      const max = opt.full ? STRING_BYTES_FULL : STRING_BYTES;
      if (size > max) {
        const part = await s.call(['GETRANGE', key, 0, max - 1], 15000);
        return done({ data: show(part, flags), truncated: true, size, note: '这个值有 ' + size + ' 字节，这里只取了前 ' + max + ' 字节' + (opt.full ? '' : '。要取全加 --full') });
      }
      return done({ data: show(await s.call(['GET', key], 15000), flags) });
    }
    case 'hash': {
      const total = await s.call(['HLEN', key]);
      const flat = total > limit ? (await s.call(['HSCAN', key, 0, 'COUNT', limit], 15000))[1] || [] : await s.call(['HGETALL', key], 15000) || [];
      const obj = {};
      for (let i = 0; i + 1 < flat.length && Object.keys(obj).length < limit; i += 2) obj[show(flat[i], flags)] = show(flat[i + 1], flags);
      return done(cut({ data: obj }, total, '字段'));
    }
    case 'list': {
      const total = await s.call(['LLEN', key]);
      const items = await s.call(['LRANGE', key, 0, limit - 1], 15000) || [];
      return done(cut({ data: items.map((x) => show(x, flags)) }, total, '元素'));
    }
    case 'set': {
      const total = await s.call(['SCARD', key]);
      const items = total > limit ? (await s.call(['SSCAN', key, 0, 'COUNT', limit], 15000))[1] || [] : await s.call(['SMEMBERS', key], 15000) || [];
      return done(cut({ data: items.slice(0, limit).map((x) => show(x, flags)) }, total, '元素'));
    }
    case 'zset': {
      const total = await s.call(['ZCARD', key]);
      const flat = await s.call(['ZRANGE', key, 0, limit - 1, 'WITHSCORES'], 15000) || [];
      const arr = [];
      for (let i = 0; i + 1 < flat.length; i += 2) arr.push({ member: show(flat[i], flags), score: Number(show(flat[i + 1])) });
      return done(cut({ data: arr }, total, '元素'));
    }
    case 'none': return { data: null, exists: false };
    case 'stream': throw mkErr('UNSUPPORTED_TYPE', 'stream 类型这个客户端不支持');
    default: throw mkErr('UNSUPPORTED_TYPE', `不认识的类型 ${t}`);
  }
}

/**
 * keys：用游标一轮一轮地看（不用 KEYS，那个会卡住服务器）。在一个连接里做完，按时间收尾。
 * 匹配是服务器看完一批之后再筛的：库里 key 很多的时候，时间到了只看了一部分，没找到不等于没有。
 * 所以没看完的时候说清一共多少个 key、看了大约多少个
 */
async function subKeys(s, a, opt) {
  const pattern = keyArg(a[0]);
  const limit = opt.limit || KEYS_LIMIT;
  const flags = {};
  const t0 = Date.now();
  const seen = new Set();
  let cursor = '0';
  let rounds = 0;
  let why = '';
  do {
    const r = await s.call(['SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT]);
    cursor = String(show(r[0]));
    rounds++;
    for (const k of r[1] || []) {
      if (seen.size >= limit) { why = '个数到了上限（' + limit + ' 个）'; break; }
      seen.add(show(k, flags));
    }
    if (why) break;
    if (cursor !== '0' && Date.now() - t0 > SCAN_BUDGET_MS) { why = '到了时间的上限（' + Math.round(SCAN_BUDGET_MS / 1000) + ' 秒）'; break; }
  } while (cursor !== '0');
  const out = { data: [...seen], truncated: !!why, scanned: rounds };
  if (why) {
    let total = 0;
    try { total = Number(await s.call(['DBSIZE'])) || 0; } catch (e) { total = 0; }
    out.scanned_about = Math.min(rounds * SCAN_COUNT, total || rounds * SCAN_COUNT);
    if (total) out.total_keys = total;
    out.note = '没看完：' + why + (total ? '，这个库一共 ' + total + ' 个 key，看了大约 ' + out.scanned_about + ' 个' : '') + '。这里没列出来的不等于没有。知道确切的 key 就直接 get；要把匹配的都列出来，把匹配写得更具体，或者加 --limit（最多 ' + LIMIT_MAX + '）';
  }
  if (flags.binary) { out.binary = true; out.note = [out.note, BINARY_NOTE].filter(Boolean).join('；'); }
  return out;
}

// ---------- 参数解析与入口 ----------
const SUBCOMMANDS = {
  ping: { argc: 0, max: 0, run: subPing },
  info: { argc: 0, max: 0, run: subInfo },
  get:  { argc: 1, max: 1, run: subGet },
  keys: { argc: 1, max: 1, run: subKeys },
  set:  { argc: 2, max: 2, write: true, run: subSet },
  del:  { argc: 1, max: 1000, write: true, run: subDel },
  ttl:  { argc: 1, max: 1, run: subTtl },
};
const USAGE = '用法：node redis.js [--conn <连接名>] [--project <项目目录>] <子命令> [参数...]。子命令：conns / ' + Object.keys(SUBCOMMANDS).join(' / ');
const VALUE_OPTS = { '--conn': 'conn', '--project': 'project', '--config': 'config', '--limit': 'limit', '--value-file': 'valueFile' };
const FLAG_OPTS = { '--full': 'full', '--value-stdin': 'valueStdin' };

function finish(obj, exit, rec) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  if (rec) record(rec);
  process.exitCode = exit;
}
const bad = (msg) => finish({ ok: false, code: 'BAD_ARGS', error: msg }, 1);

/** 把选项挑出来（写在哪都认），剩下的是子命令和它的参数。不认识的 -- 开头的参数不收 */
function parseArgs(argv) {
  const opt = { conn: '', project: '', config: '', limit: 0, valueFile: '', full: false, valueStdin: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_OPTS[name]) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '') return { error: name + ' 后面要跟一个值' };
      opt[VALUE_OPTS[name]] = v;
    } else if (FLAG_OPTS[a]) opt[FLAG_OPTS[a]] = true;
    else if (a.startsWith('--')) return { error: '不认识的参数 ' + a + '。key 真的以 -- 开头的，写成 hex:…（十六进制）' };
    else rest.push(a);
  }
  if (opt.limit) {
    const n = Number(opt.limit);
    if (!Number.isInteger(n) || n < 1) return { error: '--limit 要给一个正整数' };
    opt.limit = Math.min(n, LIMIT_MAX);
  }
  return { opt, rest };
}
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const t0 = Date.now();
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.error) return bad(parsed.error + '。' + USAGE);
  const opt = parsed.opt;
  if (!parsed.rest.length) return bad(USAGE);
  // 以前是把连接信息（连口令）整个放在命令行上、子命令前面。现在不收：口令会进会话记录
  if (/^\s*\{/.test(parsed.rest[0])) return bad('连接信息不从命令行传了（口令会进会话记录）。写在项目的 .vibe/redis.json 里，用 --conn <连接名> 指定。' + USAGE);

  const name = String(parsed.rest[0]).toLowerCase();
  const args = parsed.rest.slice(1);
  const project = path.resolve(opt.project || process.cwd());
  const base = { cmd: name, project: path.basename(project) };
  const spec = SUBCOMMANDS[name];
  if (name !== 'conns' && !spec) return bad('没有 ' + name + ' 这个子命令。' + USAGE);

  // set 的值：命令行上给，或者从文件、标准输入读（不经过 shell，引号、斜杠不会被改）
  if (name === 'set') {
    const from = [args.length > 1, !!opt.valueFile, opt.valueStdin].filter(Boolean).length;
    if (from > 1) return bad('值只能给一处：命令行上、--value-file、--value-stdin 选一个');
    if (args.length > 2) return bad('set 只收一个 key、一个值，这里多出来 ' + (args.length - 2) + ' 个参数（' + args.slice(2).join(' ').slice(0, 60) + '）。值里有空格要整个用引号括起来；或者把值写进文件，用 --value-file <文件>');
    if (opt.valueFile) {
      try { opt.value = fs.readFileSync(path.resolve(opt.valueFile)); } catch (e) { return bad('--value-file 指的文件读不了：' + opt.valueFile); }
      const s = opt.value.toString('utf8');
      // 是文字的话去掉末尾的一个换行（编辑器、Write 工具存文件时加的）
      if (Buffer.from(s, 'utf8').equals(opt.value)) opt.value = s.replace(/\r?\n$/, '');
    } else if (opt.valueStdin) {
      const b = await readStdin();
      const s = b.toString('utf8');
      opt.value = Buffer.from(s, 'utf8').equals(b) ? s.replace(/\r?\n$/, '') : b;
    } else if (args.length === 2) opt.value = args[1];
    else return bad('set 要给值：set <key> <value>，或者 set <key> --value-file <文件>');
    if (!args.length) return bad('set 要给 key');
  } else if (spec) {
    if (args.length < spec.argc) return bad('子命令 ' + name + ' 至少要 ' + spec.argc + ' 个参数，给了 ' + args.length + ' 个');
    if (args.length > spec.max) return bad('子命令 ' + name + ' 最多收 ' + spec.max + ' 个参数，这里多出来 ' + (args.length - spec.max) + ' 个（' + args.slice(spec.max).join(' ').slice(0, 60) + '）。参数里有空格要整个用引号括起来');
  }

  let all;
  try { all = loadConnections(project, opt.config); } catch (e) { return finish({ ok: false, code: e.code || 'NO_CONFIG', error: e.message }, 0, Object.assign({ exit: 0, ms: Date.now() - t0, errors: [e.code || 'NO_CONFIG'] }, base)); }

  if (name === 'conns') {
    // 列连接：不带口令
    const data = Object.keys(all.conns).map((k) => { const c = all.conns[k]; return { name: k, host: c.host, port: Number(c.port) || 6379, db: Number(c.db) || 0, password: c.password ? '有' : '没有', mode: c.mode || '', source: c.source || '' }; });
    return finish({ ok: true, data, config: all.file }, 0, Object.assign({ exit: 0, ms: Date.now() - t0, errors: [] }, base));
  }

  let session = null;
  try {
    // 全自动模式（用户不在）：改数据的事留给用户
    if (spec.write && autoMode()) throw Object.assign(mkErr('BLOCKED', '全自动模式（用户不在）：' + name + ' 会改 redis 里的数据，不做。在那项任务后面标"（留给用户：要改 redis 的数据）"，接着做别的。'), { exit: 3 });
    const c = pickConn(all, opt.conn);
    if (!c.host) throw mkErr('NO_CONFIG', '连接 ' + c.name + ' 没写 host');
    if (c.mode === 'cluster' || c.mode === 'sentinel') throw mkErr('UNSUPPORTED_MODE', '连接 ' + c.name + ' 是' + (c.mode === 'cluster' ? '集群' : '哨兵') + '模式，这个客户端只支持单机。用项目自己的办法查，或者让用户来查。');
    if (c.tls) throw mkErr('UNSUPPORTED_MODE', '连接 ' + c.name + ' 要走加密连接（rediss），这个客户端不支持。');
    const conn = { host: String(c.host), port: Number(c.port) || 6379, password: resolvePassword(c.password), username: c.username ? String(c.username) : '', db: Number(c.db) || 0 };
    session = await open(conn);
    const res = await spec.run(session, args, opt);
    session.close();
    finish(Object.assign({ ok: true }, res), 0, Object.assign({ exit: 0, ms: Date.now() - t0, errors: [] }, base));
  } catch (e) {
    if (session) session.close();
    if (!e || !e.code || typeof e.code !== 'string' || !/^[A-Z_]+$/.test(e.code)) throw e;      // 不是这里报出来的错：脚本自己的毛病，交给下面记
    finish({ ok: false, code: e.code, error: e.message }, e.exit || 0, Object.assign({ exit: e.exit || 0, ms: Date.now() - t0, errors: [String(e.code)] }, base));
  }
}

if (require.main === module) {
  main().catch((e) => {
    // 走到这里是脚本自己的毛病：记下来交给改套件的人
    record({ incident: 'crash', what: String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 200), detail: String((e && e.stack) || '').split('\n').slice(0, 8).map((l) => l.replace(/\(.*[\\/]/, '(')).join('\n'), cmd: String(process.argv[2] || '') });
    process.stdout.write(JSON.stringify({ ok: false, code: 'UNKNOWN', error: '脚本自己出错了（' + String((e && e.message) || e) + '）。这是工具的问题，已经记下来' }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { encodeCommand, parseReply, Parser, findConfig, loadConnections, pickConn, parseArgs, show, keyArg };
