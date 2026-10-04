'use strict';
/*
 * 第三档基础设施自检（不需要模型）：本脚本自己扮演 MCP 客户端，按 .mcp.json 启动 Playwright MCP 服务器，
 * 走一遍 initialize → tools/list → 打开登录页 → 读快照 → 填账号密码 → 点登录 → 等"当前用户" → 关闭。
 * 全部通过 = 服务器、系统 Edge、快照、交互都正常；之后 /probe-t3 若失败，就是模型的问题而不是环境的问题。
 * 用法：node tools/mcp-selftest.js [--out 目录] [--base http://127.0.0.1:4173]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
function trim(s, n) { n = n || 200; s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

const args = parseArgs(process.argv.slice(2));
const ROOT = path.join(__dirname, '..');
const BASE = args.base || process.env.PROBE_BASE || ('http://127.0.0.1:' + (process.env.PROBE_PORT || 4173));
const OUT = path.resolve(args.out || path.join(ROOT, 'results', 'mcp-selftest'));
fs.mkdirSync(OUT, { recursive: true });

const report = { tier: 3, name: 'Playwright MCP 基础设施自检', base: BASE, ok: true, steps: [], tools: [], toolCalls: 0, out: OUT };
const t0 = Date.now();

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8')).mcpServers.playwright;
} catch (e) {
  report.ok = false; report.fatal = '.mcp.json 读取失败（先运行 1-check-env.ps1 生成）：' + e.message;
  finish();
}

const child = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.on('error', (e) => { report.ok = false; report.fatal = 'MCP 进程启动失败：' + e.message; finish(); });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch (e) { return; }
  if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});

function send(method, params, notify) {
  const msg = { jsonrpc: '2.0', method, params: params || {} };
  if (!notify) msg.id = nextId++;
  child.stdin.write(JSON.stringify(msg) + '\n');
  if (notify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    pending.set(msg.id, (m) => { if (m.error) reject(new Error(method + ' 返回错误：' + JSON.stringify(m.error))); else resolve(m.result); });
    setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); reject(new Error(method + ' 30 秒无响应')); } }, 30000);
  });
}
async function call(name, argsObj) {
  report.toolCalls++;
  const r = await send('tools/call', { name, arguments: argsObj || {} });
  const text = (r && r.content || []).map((c) => c.text || '').join('\n');
  if (r && r.isError) throw new Error(name + ' 失败：' + trim(text, 300));
  return text;
}

async function step(name, fn) {
  const t = Date.now();
  const s = { name, ok: false, ms: 0 };
  try { const info = await fn(); s.ok = true; if (info !== undefined) s.info = info; }
  catch (e) { s.error = trim(e && e.message || e, 300); report.ok = false; }
  s.ms = Date.now() - t;
  report.steps.push(s);
  console.log((s.ok ? '  √ ' : '  × ') + name + ' (' + s.ms + 'ms)' + (s.info ? '  ' + s.info : '') + (s.error ? '  ' + s.error : ''));
  return s.ok;
}

function refOf(snapshot, re) {
  const m = snapshot.match(re);
  return m ? m[1] : null;
}

(async () => {
  let snap = '';
  if (!await step('initialize 握手', async () => {
    const r = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browser-probe', version: '0.1.0' } });
    await send('notifications/initialized', {}, true);
    return '服务器：' + ((r.serverInfo || {}).name || '?') + ' ' + ((r.serverInfo || {}).version || '');
  })) return finish();

  await step('tools/list', async () => {
    const r = await send('tools/list', {});
    report.tools = (r.tools || []).map((t) => t.name);
    const need = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'];
    const miss = need.filter((n) => !report.tools.includes(n));
    if (miss.length) throw new Error('缺少工具：' + miss.join(','));
    return report.tools.length + ' 个工具，含 ' + need.join('/');
  });

  await step('browser_navigate 打开登录页（会启动系统 Edge）', async () => {
    snap = await call('browser_navigate', { url: BASE + '/login.html' });
    fs.writeFileSync(path.join(OUT, 'snapshot-login.txt'), snap);
    if (!/登录/.test(snap)) throw new Error('返回内容里没有"登录"字样：' + trim(snap, 200));
    return '返回 ' + snap.length + ' 字符，含页面快照';
  });

  let userRef, passRef, btnRef;
  await step('从快照里找到输入框和按钮的 ref', async () => {
    // 新版 MCP 的 navigate 可能只返回快照文件链接，不内联；此时直接再取一次 browser_snapshot（模型也应这么做）
    const fileLink = snap.match(/\[Snapshot\]\(([^)]+\.ya?ml)\)/);
    if (!/\[ref=/.test(snap) && fileLink && fs.existsSync(path.resolve(ROOT, fileLink[1]))) snap = fs.readFileSync(path.resolve(ROOT, fileLink[1]), 'utf8');
    if (!/\[ref=/.test(snap)) snap = await call('browser_snapshot', {});
    fs.writeFileSync(path.join(OUT, 'snapshot-login-refs.txt'), snap);
    userRef = refOf(snap, /textbox "用户名"[^\n]*?\[ref=(e\d+)\]/);
    passRef = refOf(snap, /textbox "密码"[^\n]*?\[ref=(e\d+)\]/);
    btnRef = refOf(snap, /button "登录"[^\n]*?\[ref=(e\d+)\]/);
    if (!userRef || !passRef || !btnRef) throw new Error('没找全 ref（用户名 ' + userRef + '，密码 ' + passRef + '，登录 ' + btnRef + '）。快照片段：' + trim(snap, 300));
    return '用户名 ' + userRef + '，密码 ' + passRef + '，登录按钮 ' + btnRef;
  });

  await step('browser_type 填账号密码 + browser_click 登录', async () => {
    // @playwright/mcp 0.0.8x 的参数是 target（ref 字符串或选择器）+ 可选 element（人类可读描述）
    await call('browser_type', { element: '用户名输入框', target: userRef, text: 'admin' });
    await call('browser_type', { element: '密码输入框', target: passRef, text: 'admin123' });
    await call('browser_click', { element: '登录按钮', target: btnRef });
  });

  await step('等待"当前用户"出现并读快照', async () => {
    await call('browser_wait_for', { text: '当前用户' });
    const s2 = await call('browser_snapshot', {});
    fs.writeFileSync(path.join(OUT, 'snapshot-dashboard.txt'), s2);
    if (!/当前用户/.test(s2)) throw new Error('快照里没有"当前用户"');
    const m = s2.match(/link "用户管理"[^\n]*?\[ref=(e\d+)\]/);
    return '已进入控制台，快照 ' + s2.length + ' 字符' + (m ? '，用户管理菜单 ref=' + m[1] : '');
  });

  await step('browser_close 关闭', async () => { await call('browser_close', {}); });
  finish();
})().catch((e) => { report.ok = false; report.fatal = trim(e && e.stack || e, 500); finish(); });

function finish() {
  report.totalMs = Date.now() - t0;
  report.stderr = trim(stderr, 800);
  try { child.kill(); } catch (e) { }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const L = ['# 第三档基础设施自检（Playwright MCP，不需要模型）', '', '- 命令：' + (cfg ? cfg.command + ' ' + cfg.args.join(' ') : '?'), '- 结论：' + (report.ok ? '通过' : '失败') + (report.fatal ? '（' + report.fatal + '）' : ''), '- 工具调用次数：' + report.toolCalls + '，总耗时 ' + report.totalMs + ' ms', '', '| 步骤 | 结果 | 耗时 | 说明 |', '|---|---|---|---|'];
  report.steps.forEach((s) => L.push('| ' + s.name + ' | ' + (s.ok ? '通过' : '失败') + ' | ' + s.ms + ' ms | ' + (s.info || s.error || '') + ' |'));
  if (report.tools.length) L.push('', '工具清单：' + report.tools.join('，'));
  if (report.stderr) L.push('', '服务器 stderr 片段：', '```', report.stderr, '```');
  fs.writeFileSync(path.join(OUT, 'report.md'), L.join('\n'));
  console.log('\n第三档基础设施自检' + (report.ok ? '通过' : '失败') + '，报告：' + path.join(OUT, 'report.md'));
  process.exit(report.ok ? 0 : 1);
}
