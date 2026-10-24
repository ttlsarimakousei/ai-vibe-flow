'use strict';
/*
 * 把本机 IDEA 已开启的内置 MCP 登记到 Claude Code 的用户配置。
 * 安装、同步和后台更新共用这里：只探测回环地址，不下载插件，不改 IDEA 的授权设置。
 * 用 initialize 和 tools/list 核对身份；不执行项目操作。已登记的连接只管自己加的那份。
 * 用户改过或删过登记时暂停补登记，关掉再打开开关才恢复。配置解析失败、并发写入时不覆盖。
 * 不输出 Claude 配置和服务器的原始回复，它们可能有令牌。状态只存连接地址、版本和归属。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { CFG_DIR, readConfig } = require('./session');
const EVERY_MS = 5 * 60000;
const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const same = (a, b) => obj(a) && obj(b) && Object.keys(a).length === 2 && a.type === b.type && a.url === b.url;
const localUrl = (s) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/stream$/.test(String(s || ''));
function files(dir) { return { state: path.join(dir, 'vibe-kit', 'state', 'idea-mcp.json'), lock: path.join(dir, 'vibe-kit', 'state', 'idea-mcp.lock') }; }
function readState(dir) { try { const s = JSON.parse(fs.readFileSync(files(dir).state, 'utf8')); return obj(s) ? s : {}; } catch (e) { return {}; } }
function clientFile(dir, st) {
  const choices = [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')];
  if (choices.includes(st.clientFile)) return st.clientFile;
  return process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR) === path.resolve(dir) ? choices[0] : choices[1];
}
function status(dir) {
  const s = readState(dir || CFG_DIR);
  return { status: s.status || 'unchecked', checkedAt: Number(s.checkedAt) || 0,
    connections: (Array.isArray(s.connections) ? s.connections : []).filter((c) => obj(c) && localUrl(c.url)).slice(0, 32).map((c) => ({ name: String(c.name || '').replace(/[^\w-]/g, '').slice(0, 80), url: c.url, version: /^[\d.]+$/.test(c.version) ? c.version : '', managed: c.managed === true })) };
}
function due(dir) {
  const base = dir || CFG_DIR, st = readState(base);
  if (Date.now() - (st.checkedAt || 0) < EVERY_MS) return false;
  // 没装 IDEA、没开 MCP 的机器不为它起后台进程。后来启用时，下次钩子会发现。
  if (Object.keys(obj(st.owned) ? st.owned : {}).length > 0) return true;
  return readConfig().ideaMcp !== false && configs(base).some(c => c.enabled);
}
function save(dir, s) { fs.writeFileSync(files(dir).state, JSON.stringify(s, null, 2) + '\n'); return status(dir); }
function configs(dir) {
  const home = path.dirname(dir);
  const bases = process.platform === 'win32' ? [path.join(home, 'AppData', 'Roaming', 'JetBrains')]
    : process.platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'JetBrains')]
      : [path.join(home, '.config', 'JetBrains')];
  const found = [];
  for (const base of bases) {
    let names = []; try { names = fs.readdirSync(base); } catch (e) { continue; }
    for (const name of names.filter((n) => /^(IntelliJIdea|IdeaIC)\d{4}\.\d/.test(n)).slice(-16)) {
      try {
        const f = path.join(base, name, 'options', 'mcpServer.xml');
        if (fs.statSync(f).size > 65536) continue;
        const xml = fs.readFileSync(f, 'utf8');
        const enabled = /<option\b(?=[^>]*\bname=["']enableMcpServer["'])(?=[^>]*\bvalue=["']true["'])[^>]*>/.test(xml);
        // brave mode：MCP 调用运行配置、命令不用用户在 IDEA 里点允许（lib/idea-run.js 只在开着时用 IDEA 起服务）
        const brave = /<option\b(?=[^>]*\bname=["']enableBraveMode["'])(?=[^>]*\bvalue=["']true["'])[^>]*>/.test(xml);
        found.push({ name, enabled, brave, at: fs.statSync(f).mtimeMs });
      } catch (e) { /* 没有设置文件，不代表开过 MCP */ }
    }
  }
  return found;
}
function ports(st) {
  // 测试只连假服务器；生产从官方起始端口找相邻的 32 个，绝不扫整个端口范围。
  const test = process.env.VIBE_KIT_IDEA_MCP_PORTS;
  const nums = test !== undefined ? test.split(',').map(Number) : Array.from({ length: 32 }, (_, i) => 64342 + i).concat(Object.values(obj(st.owned) ? st.owned : {}).filter((c) => obj(c) && localUrl(c.url)).map((c) => Number(new URL(c.url).port)));
  return [...new Set(nums.filter((n) => Number.isInteger(n) && n > 0 && n < 65536))].slice(0, 64);
}
/** JSON 和 HTTP 事件流都支持；总时限、回复大小有上限，不跟随重定向。 */
function rpc(port, body, session, method) {
  return new Promise((resolve) => {
    let done = false, res, bytes = 0, raw = '';
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (res) res.destroy(); req.destroy(); resolve(v); };
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' };
    if (session) headers['Mcp-Session-Id'] = session;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/stream', method: method || 'POST', headers, agent: false }, (r) => {
      res = r;
      const sid = r.headers['mcp-session-id'];
      const sessionId = typeof sid === 'string' && /^[\x21-\x7e]{1,200}$/.test(sid) ? sid : '';
      if (r.statusCode < 200 || r.statusCode >= 300) return finish(null);
      const parse = () => {
        const candidates = [raw, ...raw.split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))];
        for (const t of candidates) { try { const j = JSON.parse(t); if (j.jsonrpc === '2.0' && body && j.id === body.id && own(j, 'result')) return finish({ result: j.result, session: sessionId || session }); } catch (e) { /* 消息还没收全 */ } }
      };
      r.on('data', (c) => { bytes += c.length; if (bytes > 262144) return finish(null); raw += c.toString('utf8'); parse(); });
      r.on('end', () => { if (!body || !own(body, 'id')) finish({ session: sessionId || session }); else { parse(); finish(null); } });
      r.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), 450);
    req.on('error', () => finish(null));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function probe(port) {
  const first = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vibe-kit-check', version: '1' } } });
  if (!first) return null;
  try {
    const r = first.result;
    if (!obj(r) || !obj(r.serverInfo) || r.serverInfo.name !== 'IntelliJ IDEA MCP Server' || !['2025-06-18', '2025-03-26', '2024-11-05'].includes(r.protocolVersion)) return null;
    if (!await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, first.session)) return null;
    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, first.session);
    if (!list || !Array.isArray(list.result.tools) || !list.result.tools.some((t) => ['execute_tool', 'build_project', 'get_project_modules'].includes(t.name))) return null;
    return { url: 'http://127.0.0.1:' + port + '/stream', version: /^[\d.]+$/.test(r.serverInfo.version) ? r.serverInfo.version : '' };
  } finally { if (first.session) await rpc(port, null, first.session, 'DELETE'); }
}
function snapshot(f) {
  try {
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024) throw new Error('config');
    const raw = fs.readFileSync(f);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!obj(value) || (value.mcpServers !== undefined && !obj(value.mcpServers))) throw new Error('config');
    return { raw, value, mode: st.mode };
  } catch (e) { if (e.code === 'ENOENT') return { raw: null, value: {}, mode: 0o600 }; throw new Error('config'); }
}
function writeClient(f, before) {
  const tmp = f + '.vibe-idea-' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(before.value, null, 2) + '\n', { flag: 'wx', mode: before.mode & 0o777 });
    const latest = snapshot(f);
    if (before.raw === null ? latest.raw !== null : latest.raw === null || !before.raw.equals(latest.raw)) throw new Error('changed');
    fs.renameSync(tmp, f);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* 已经换过去了 */ } }
}
async function sync(opt) {
  const o = opt || {}, dir = path.resolve(o.claudeDir || CFG_DIR), f = files(dir);
  fs.mkdirSync(path.dirname(f.state), { recursive: true });
  let fd;
  try { fd = fs.openSync(f.lock, 'wx'); } catch (e) {
    // 进程异常退出留下的锁，一分钟后可以接手。正常检查不到几秒。
    try { if (Date.now() - fs.statSync(f.lock).mtimeMs > 60000) { fs.unlinkSync(f.lock); fd = fs.openSync(f.lock, 'wx'); } } catch (x) { /* 另一个正在做 */ }
    if (fd === undefined) return Object.assign(status(dir), { busy: true });
  }
  try {
    const st = readState(dir), target = clientFile(dir, st);
    const next = Object.assign({}, st, { clientFile: target, checkedAt: Date.now(), connections: [], status: 'unchecked' });
    const off = o.remove === true || o.enabled === false || (o.enabled === undefined && readConfig().ideaMcp === false);
    let found = [];
    if (!off) {
      const dirs = configs(dir);
      if (!dirs.length) next.status = 'no-idea';
      else if (!dirs.some((d) => d.enabled)) next.status = 'not-enabled';
      else {
        const candidates = ports(st);
        for (let i = 0; i < candidates.length; i += 8) found.push(...(await Promise.all(candidates.slice(i, i + 8).map(probe))).filter(Boolean));
        next.status = found.length ? 'ready' : 'not-running';
      }
    }
    let before;
    try { before = snapshot(target); } catch (e) { next.status = 'config-error'; return save(dir, next); }
    const servers = before.value.mcpServers || {}, owned = obj(st.owned) ? st.owned : {};
    let changed = false;
    const managed = {};
    for (const [name, entry] of Object.entries(owned)) {
      if (!/^vibe-idea-\d+$/.test(name) || !obj(entry) || !same(entry, { type: 'http', url: entry.url }) || !localUrl(entry.url)) continue;
      if (!same(servers[name], entry)) { if (!off) next.suppressed = true; continue; }
      if (off) { delete servers[name]; changed = true; } else managed[name] = entry;
    }
    if (off) { next.status = 'off'; next.suppressed = false; }
    else if (next.suppressed) next.status = 'user-changed';
    else for (const c of found) {
      // 用户已经登记过这个 HTTP 地址：直接使用，不接管、不复制 headers 和环境变量。
      const existing = Object.keys(servers).find((n) => obj(servers[n]) && ['http', 'streamable-http'].includes(servers[n].type) && servers[n].url === c.url);
      const name = existing || 'vibe-idea-' + new URL(c.url).port;
      if (!existing && own(servers, name)) { next.status = 'name-conflict'; continue; }
      if (!existing) { servers[name] = { type: 'http', url: c.url }; managed[name] = servers[name]; changed = true; }
      next.connections.push({ name, url: c.url, version: c.version, managed: own(managed, name) });
    }
    // IDEA 换了端口：已有活连接时收回失效的自有登记；全都关着时保留，等下次启动。
    if (!off && !next.suppressed && found.length) for (const [name, entry] of Object.entries(managed)) {
      if (!found.some((c) => c.url === entry.url)) { delete servers[name]; delete managed[name]; changed = true; }
    }
    next.owned = managed;
    if (changed) {
      before.value.mcpServers = servers;
      try { writeClient(target, before); } catch (e) { next.status = 'config-busy'; next.owned = owned; next.connections = []; return save(dir, next); }
    }
    const result = save(dir, next);
    return Object.assign(result, { changed });
  } catch (e) {
    // 不把异常的原文带进安装日志，避免 JSON 解析错误带出配置内容。
    try { return save(dir, Object.assign(readState(dir), { status: 'check-error', checkedAt: Date.now(), connections: [] })); } catch (x) { return { status: 'check-error', connections: [] }; }
  } finally { fs.closeSync(fd); try { fs.unlinkSync(f.lock); } catch (e) { /* 已清掉 */ } }
}
module.exports = { sync, status, due, configs, EVERY_MS };
