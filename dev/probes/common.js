'use strict';
/*
 * 探测脚本共用的几样：找到某个版本的 claude.exe、起一个假网关（记下每个请求、按剧本回复）、用 -p 跑一次 Claude Code。
 * 探测不是回归测试：它回答"这个版本的 Claude Code 在这件事上是怎么做的"，输出给人看，不判对错。
 * 家目录、APPDATA 一律指假的（用 ../lib/harness.js 的 envFor），和测试一样不碰真实的用户目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const H = require('../lib/harness');

/** 给版本号（2.1.289）就到 %LOCALAPPDATA%\Programs\claude-code-versions\<版本号>\ 下面找；给 claude.exe 的路径就用它 */
function exeOf(arg) {
  const a = String(arg || '');
  if (!a) { console.log('要给 Claude Code 的版本号（装在 %LOCALAPPDATA%\\Programs\\claude-code-versions\\<版本号>\\ 的）或者 claude.exe 的路径'); process.exit(2); }
  if (/\.exe$/i.test(a) || fs.existsSync(a) && fs.statSync(a).isFile()) return path.resolve(a);
  const programs = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : path.join(os.homedir(), 'AppData', 'Local', 'Programs');
  const exe = path.join(programs, 'claude-code-versions', a, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (!fs.existsSync(exe)) { console.log('没找到 ' + exe + '\n装法见 dev/README.md"拿到别的版本的 Claude Code"'); process.exit(2); }
  return exe;
}
const brief = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || (typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : '')).join('\n'));
const systemOf = (body) => (Array.isArray(body.system) ? body.system.map((s) => s.text || '').join('\n') : String(body.system || ''));
/** 主会话的请求：带着 Bash、Edit 这些工具 */
const isMain = (body) => { const names = (body.tools || []).map((t) => t.name); return names.includes('Bash') && names.includes('Edit'); };

/** 回一条消息。block：{ type: 'text', text } 或 { type: 'tool_use', id, name, input }；usage 里的 input_tokens 就是"上下文用了多少" */
function reply(body, res, block, stop, inputTokens) {
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const usage = { input_tokens: inputTokens || 3000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  if (block.type === 'text') { ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }); }
  else { ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }); ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }); }
  ev.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } }, { type: 'message_stop' });
  for (const e of ev) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
}
/** 起一个假网关。onMessage(body, res, req) 处理 POST /v1/messages；别的请求回 404 并交给 onOther(req)。返回 { port, close } */
async function fakeGateway(onMessage, onOther) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 不是 JSON */ }
      if (req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url) && body) { try { return onMessage(body, res, req); } catch (e) { console.log('假网关出错：' + e.stack); } }
      if (onOther) onOther(req);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'probe: not found' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}
/** 给 Claude Code 的环境变量：家目录是假的，连的是假网关，不走代理、不自动更新 */
function claudeEnv(h, port, extra) {
  const env = H.envFor(h, Object.assign({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'probe-token', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' }, extra || {}));
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  return env;
}
function killTree(pid) { try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* 已经退了 */ } }
/** 起一个进程，等它退出或者到时间结束它。返回 { code, killed, out, err } */
function runFor(file, args, opts, seconds) {
  return new Promise((resolve) => {
    const p = spawn(file, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = ''; let err = ''; let killed = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { killed = true; killTree(p.pid); }, (seconds || 150) * 1000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, killed, out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, killed, out, err: String(e) }); });
  });
}
/** claude -p 跑一次。返回 runFor 的结果，外加 json（最后一行解析出来的结果，解析不了是 null） */
async function runPrint(exe, h, proj, port, prompt, args, extraEnv, seconds) {
  const r = await runFor(exe, ['-p', prompt, '--output-format', 'json'].concat(args || []), { cwd: proj, env: claudeEnv(h, port, extraEnv) }, seconds);
  let json = null;
  try { json = JSON.parse(r.out.trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { json = null; }
  return Object.assign(r, { json });
}

module.exports = { H, exeOf, brief, textOf, systemOf, isMain, reply, fakeGateway, claudeEnv, runFor, runPrint, killTree };
