'use strict';
/*
 * 用 IDEA 的运行配置起、停服务（用户 2026-10-17 定的：IDEA MCP 连上时用它的运行配置起服务，改完自动重启再测；devserver.js --idea 用这里）。
 *
 * 实测（docs/claude-code-facts.md"运行配置的起、停、重启"）定下的做法：
 *   - 用调试方式起（xdebug_start_debugger_session）。普通 Run 起的 MCP 停不了，再跑一次也不重启（会起第二份、端口绑不上、旧的照样答话）；
 *     调试方式返回会话号（就是运行配置名），xdebug_control_session STOP 一两秒放掉端口。不打断点和 Run 一样用。
 *   - 运行配置用户自己配好，这里只用现成的，不建、不改。
 *   - IDEA 没开 brave mode（每次调用要用户点允许）就不用：调用会一直挂着等人点。由调用方照旧用命令起（ready() 说为什么不能用）。
 *   - IDEA 只等 15 秒左右：只发 POST、不开着 GET /stream 事件流的调用，超过就被丢掉。这里每次调用都开着事件流，回复从哪边来都认。
 *   - 运行配置有错时 IDEA 弹编辑框、不回话：调用超时，调用方说清去 IDEA 里看。
 * 只连 127.0.0.1 上已登记的 IDEA MCP（lib/idea-mcp.js 登记的那个地址），只用 Node 自带的模块；回复大小有上限，原文不写日志（输出里可能有项目的口令）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_REPLY = 4 * 1024 * 1024;
const localUrl = (s) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/stream$/.test(String(s || ''));

/** 往上找 IDEA 的项目目录（有 .idea 的那一层）：壳子打开成一个 IDEA 项目时，子项目的项目目录是壳子 */
function projectOf(dir) {
  for (let d = path.resolve(dir || '.'); ; d = path.dirname(d)) {
    try { if (fs.statSync(path.join(d, '.idea')).isDirectory()) return d; } catch (e) { /* 这一层没有 */ }
    if (path.dirname(d) === d) return '';
  }
}
/**
 * 这个目录能不能用 IDEA 起服务：IDEA MCP 连上了、开了 brave mode、目录在一个 IDEA 项目里。只读本机文件，不连网络，钩子里也能用。
 * 返回 { ok, url, projectPath, why }
 */
function ready(dir) {
  try {
    const S = require('./session');
    if (S.readConfig().ideaMcp === false) return { ok: false, why: '配置页关了 IDEA MCP' };
    const M = require('./idea-mcp');
    const st = M.status();
    const c = (st.connections || []).find((x) => localUrl(x.url));
    if (st.status !== 'ready' || !c) return { ok: false, why: 'IDEA 的 MCP 没连上（IDEA 没开着、没开 MCP 服务器，或者套件还没查到）' };
    const cfgs = M.configs(S.CFG_DIR).filter((x) => x.enabled).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!cfgs.length || !cfgs[0].brave) return { ok: false, url: c.url, why: 'IDEA 没开 brave mode（设置 → 工具 → MCP 服务器 → 不经确认运行命令和运行配置），每次起服务都要你在 IDEA 里点允许' };
    const projectPath = projectOf(dir);
    if (!projectPath) return { ok: false, url: c.url, why: '这个目录不在 IDEA 项目里（往上找不到 .idea）' };
    return { ok: true, url: c.url, projectPath };
  } catch (e) { return { ok: false, why: '查不了 IDEA 的状态：' + ((e && e.message) || e) }; }
}

// ---------- MCP 客户端（可流式 HTTP） ----------
function request(url, method, body, session, onMessage, onClose) {
  const u = new URL(url);
  const headers = { Accept: method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  if (body) headers['Content-Type'] = 'application/json';
  if (session) headers['Mcp-Session-Id'] = session;
  let bytes = 0; let buf = '';
  const req = http.request({ hostname: '127.0.0.1', port: Number(u.port), path: u.pathname, method, headers, agent: false }, (r) => {
    const sid = typeof r.headers['mcp-session-id'] === 'string' && /^[\x21-\x7e]{1,200}$/.test(r.headers['mcp-session-id']) ? r.headers['mcp-session-id'] : '';
    if (onClose) onClose.status = r.statusCode;
    if (sid && onClose) onClose.sid = sid;
    r.on('data', (c) => { bytes += c.length; if (bytes > MAX_REPLY) { req.destroy(); return; } buf = drain(buf + c.toString('utf8'), onMessage); });
    r.on('end', () => { drain(buf + '\n\n', onMessage); if (onClose && onClose.done) onClose.done(); });
    r.on('error', () => { if (onClose && onClose.done) onClose.done(); });
  });
  req.on('error', () => { if (onClose && onClose.done) onClose.done(); });
  req.end(body ? JSON.stringify(body) : undefined);
  return req;
}
/** 普通 JSON 和事件流都认：按空行切事件，取 data: 行 */
function drain(buf, onMessage) {
  const t = buf.trim();
  if (t.startsWith('{')) { try { onMessage(JSON.parse(t)); return ''; } catch (e) { /* 还没收全 */ } }
  const parts = buf.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  for (const ev of parts) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (data) { try { onMessage(JSON.parse(data)); } catch (e) { /* 不是 JSON 的事件 */ } }
  }
  return rest;
}
const post = (url, body, session, onMessage) => new Promise((resolve) => { const box = {}; box.done = () => resolve(box); request(url, 'POST', body, session, onMessage, box); });
/**
 * 调一个 IDEA 工具。返回 { ok, result }（result 是 structuredContent，没有就是整个 result）、{ ok:false, timeout:true }、{ ok:false, why }。
 * 工具自己报错（isError）算 ok:false，why 是它的文字
 */
async function callTool(url, name, args, timeoutMs) {
  if (!localUrl(url)) return { ok: false, why: 'IDEA MCP 的地址不对' };
  const waiting = new Map();
  const onMessage = (m) => { if (m && m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const wait = (id, ms) => new Promise((res) => { const t = setTimeout(() => { waiting.delete(id); res(null); }, ms); waiting.set(id, (m) => { clearTimeout(t); res(m); }); });
  const p1 = wait(1, 8000);
  const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vibe-kit-devserver', version: '1' } } }, null, onMessage);
  const first = await p1;
  if (!first || !first.result || !init.sid) return { ok: false, why: 'IDEA MCP 没握上手' + (init.status ? '（HTTP ' + init.status + '）' : '') };
  const sid = init.sid;
  let stream = null;
  try {
    await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, onMessage);
    // 开着事件流：IDEA 等不到事件流会在 15 秒左右把还没回的调用丢掉（实测）
    stream = request(url, 'GET', null, sid, onMessage, null);
    const p = wait(2, timeoutMs || 120000);
    post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args || {} } }, sid, onMessage);
    const m = await p;
    if (!m) return { ok: false, timeout: true };
    if (m.error) return { ok: false, why: String(m.error.message || 'IDEA 报错').slice(0, 300) };
    const r = m.result || {};
    const text = Array.isArray(r.content) ? r.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
    if (r.isError) return { ok: false, why: text.slice(0, 500) || 'IDEA 报错' };
    let result = r.structuredContent;
    if (!result) { try { result = JSON.parse(text); } catch (e) { result = { text }; } }
    return { ok: true, result };
  } finally {
    try { if (stream) stream.destroy(); } catch (e) { /* 关不了算了 */ }
    await new Promise((res) => { const box = { done: res }; const q = request(url, 'DELETE', null, sid, () => {}, box); setTimeout(() => { try { q.destroy(); } catch (e) { /* 已经关了 */ } res(); }, 3000); });
  }
}

// ---------- 运行配置 ----------
/** 项目里的运行配置名 */
async function configs(r) {
  const x = await callTool(r.url, 'get_run_configurations', { projectPath: r.projectPath }, 30000);
  if (!x.ok) return x;
  return { ok: true, names: (Array.isArray(x.result.configurations) ? x.result.configurations : []).map((c) => String(c && c.name || '')).filter(Boolean) };
}
/** 现在的调试会话：[{ id, name, state, runConfigurationName }] */
async function sessions(r) {
  const x = await callTool(r.url, 'xdebug_get_debugger_status', { projectPath: r.projectPath }, 30000);
  if (!x.ok) return x;
  return { ok: true, list: (Array.isArray(x.result.sessions) ? x.result.sessions : []).filter((s) => s && s.id) };
}
/** 调试方式起一个运行配置。返回 { ok, sessionId, log }；超时（多半弹了编辑框或在等人点）返回 { ok:false, timeout:true } */
async function startDebug(r, name, waitMs) {
  const x = await callTool(r.url, 'xdebug_start_debugger_session', { projectPath: r.projectPath, configurationName: name, timeout: Math.min(waitMs || 90000, 170000), graceWaitMs: 500 }, (waitMs || 90000) + 15000);
  if (!x.ok) return x;
  return { ok: true, sessionId: String(x.result.sessionId || name), log: typeof x.result.fullOutputPath === 'string' ? x.result.fullOutputPath : '' };
}
async function stopSession(r, id) {
  const x = await callTool(r.url, 'xdebug_control_session', { projectPath: r.projectPath, sessionId: id, action: 'STOP', timeout: 30000 }, 60000);
  return x.ok ? { ok: true } : x;
}

module.exports = { ready, projectOf, callTool, configs, sessions, startDebug, stopSession };
