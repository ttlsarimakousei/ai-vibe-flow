'use strict';
/*
 * 假的 IDEA MCP（测 devserver.js --idea 用）：单独一个进程跑，它起的"服务"是它的子进程（测试拿它的进程号当 IDEA：VIBE_KIT_IDEA_PID）。
 * 照真的 IDEA 2026.2.3 实测的样子（docs/claude-code-facts.md"运行配置的起、停、重启"）：
 *   - 工具：get_run_configurations、xdebug_start_debugger_session、xdebug_get_debugger_status、xdebug_control_session（STOP）、execute_run_configuration。
 *   - 调试方式起的进会话列表、能 STOP；Run 方式起的不进列表，STOP 回 "Session '...' not found"。
 *   - 没开着 GET 事件流的调用，超过 DROP_MS 还没回就回 404（真的 IDEA 是 15 秒左右，这里缩短）。
 *   - 运行配置 broken 永远不回话（真的 IDEA 弹了编辑运行配置的框）。
 *   - "服务"起来后先占端口、过 READY_MS 才答 HTTP（Tomcat 先占端口、后部署应用）；答的是启动那一刻 <源目录>/v.txt 的内容（编译时的代码）。
 * 用法：node fake-idea.js <服务端口> <源目录> <日志目录>；起来后第一行输出 {"port":<MCP 端口>}。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

if (process.argv[2] === '__service') {
  // "服务"：启动时读一次 v.txt（像编译好的代码），占端口，READY_MS 之后才答
  const [, , , port, src, readyMs] = process.argv;
  const text = fs.readFileSync(path.join(src, 'v.txt'), 'utf8').trim();
  let ready = false;
  setTimeout(() => { ready = true; }, Number(readyMs) || 0);
  const pending = [];
  http.createServer((req, res) => { if (ready) res.end(text); else pending.push(res); }).listen(Number(port), '127.0.0.1');
  setInterval(() => { if (ready) while (pending.length) pending.shift().end(text); }, 100);
  return;
}

const [svcPort, src, logDir] = process.argv.slice(2);
const DROP_MS = 1500;
const START_MS = 2500;   // 调试方式起要多久才回（比 DROP_MS 长：不开事件流就收不到回复）
const READY_MS = 1200;
const sessions = new Map();   // id → 子进程（调试方式起的）
const runs = [];               // Run 方式起的
const streams = new Set();     // 开着事件流的会话
let streamOpened = 0;
let seq = 0;
const CONFIGS = ['app', 'broken'];

function launch(cfg) {
  const log = path.join(logDir, 'ij_run__' + cfg + '_' + (++seq) + '.log');
  const fd = fs.openSync(log, 'w');
  const c = spawn(process.execPath, [__filename, '__service', svcPort, src, String(READY_MS)], { stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  return { c, log };
}
function tool(name, a, done) {
  const ok = (structuredContent) => done({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false });
  const err = (text) => done({ content: [{ type: 'text', text }], isError: true });
  if (name === 'get_run_configurations') return ok({ configurations: CONFIGS.map((n) => ({ name: n, supportsDynamicLaunchOverrides: false })) });
  if (name === 'xdebug_get_debugger_status') return ok({ sessions: [...sessions.keys()].map((id) => ({ id, name: id, state: 'running', runConfigurationName: id })) });
  if (name === 'xdebug_start_debugger_session') {
    const cfg = a.configurationName;
    if (cfg === 'broken') return;   // 弹了编辑框：不回话
    if (!CONFIGS.includes(cfg)) return err("Run configuration with name '" + cfg + "' not found.");
    return setTimeout(() => { const { c, log } = launch(cfg); sessions.set(cfg, c); c.on('exit', () => { if (sessions.get(cfg) === c) sessions.delete(cfg); }); ok({ sessionId: cfg, name: cfg, status: 'running', runConfigurationName: cfg, output: '', fullOutputPath: log }); }, START_MS);
  }
  if (name === 'xdebug_control_session') {
    const c = sessions.get(a.sessionId);
    if (!c) return err("Session '" + a.sessionId + "' not found. Available sessions: [" + ([...sessions.keys()].join(', ') || 'none') + ']');
    sessions.delete(a.sessionId);
    c.kill();
    return c.on('exit', () => ok({ status: 'stopped', breakpointErrorsTail: [] }));
  }
  if (name === 'execute_run_configuration') { const { c, log } = launch(a.configurationName); runs.push(c); return ok({ output: '', fullOutputPath: log }); }
  if (name === '__stats') return ok({ streamOpened });
  return err('unknown tool ' + name);
}
const srv = http.createServer((req, res) => {
  const sid = req.headers['mcp-session-id'] || '';
  if (req.method === 'GET') { streams.add(sid); streamOpened++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ok\n\n'); req.on('close', () => streams.delete(sid)); return; }
  if (req.method === 'DELETE') { streams.delete(sid); res.writeHead(200); res.end(); return; }
  let b = '';
  req.on('data', (c) => b += c);
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch (e) { res.writeHead(400); res.end(); return; }
    if (j.id === undefined) { res.writeHead(202); res.end(); return; }
    const reply = (result) => { if (res.writableEnded) return; res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid || 's' + (++seq) }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
    if (j.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'IntelliJ IDEA MCP Server', version: '2026.2.3' } });
    if (j.method !== 'tools/call') return reply({});
    // 没开着事件流、DROP_MS 内回不了的：丢掉（回 404）
    const drop = setTimeout(() => { if (!streams.has(sid) && !res.writableEnded) { res.writeHead(404); res.end(); } }, DROP_MS);
    tool(j.params.name, j.params.arguments || {}, (r) => { clearTimeout(drop); reply(r); });
  });
});
srv.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: srv.address().port })));
const bye = () => { for (const c of sessions.values()) c.kill(); for (const c of runs) c.kill(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('message', (m) => { if (m === 'bye') bye(); });
process.stdin.on('end', bye);
process.stdin.resume();
