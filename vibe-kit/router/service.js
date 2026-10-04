'use strict';
/*
 * 模型路由的后台运行管理：启动（没有窗口，任务栏里没有东西）、停止、登录后自动启动。安装器和"会话开始"的钩子都用它。
 *   node service.js start | stop | restart | status | autostart | no-autostart
 *
 * 程序在 ~/.claude/vibe-kit/router/，数据（config.json、用量、日志、备份）在 ~/.claude/vibe-kit/router-data/。
 * 更新、卸载套件都不动数据目录，配好的模型和 key 不会丢。
 *
 * 登录后自动启动：在"启动"文件夹里放一个 .vbs，用隐藏窗口的方式拉起 node。不需要管理员权限，不建计划任务，不出现在任务栏。
 *   有的公司会禁用 .vbs。所以放之前先实际跑一个试试；跑不了就不放，免得以后每次登录都弹一个报错框。
 *   那种情况由"会话开始"的钩子兜底：打开 Claude Code 时发现路由没在跑，就悄悄拉起来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
// 系统自带的命令一律按绝对路径调：有的机器 PATH 被改乱了（少了 System32、混进了坏项），不能指望靠 PATH 找到它们
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const sysExe = (name) => { const p = path.join(SYS32, name); return fs.existsSync(p) ? p : name; };

const CODE_DIR = __dirname;
const KIT_DIR = path.dirname(CODE_DIR);
const DATA_DIR = path.join(KIT_DIR, 'router-data');
const CONFIG = path.join(DATA_DIR, 'config.json');
const ROUTER_JS = path.join(CODE_DIR, 'router.js');
// 路由启动后写的 pid 文件：{ pid, port, host, token, startedAt }。停路由时靠它认人、请它自己退出
const PID_FILE = path.join(DATA_DIR, 'router.pid');
// 测试时用环境变量把"启动"文件夹指到别处，免得动到真的
const STARTUP_DIR = process.env.VIBE_KIT_STARTUP_DIR || (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : '');
const VBS = STARTUP_DIR ? path.join(STARTUP_DIR, 'vibe-kit-router.vbs') : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listenOf() {
  try { let t = fs.readFileSync(CONFIG, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t).listen || {}; } catch (e) { return {}; }
}
function portOf() { const p = Number(listenOf().port); return p > 0 && p < 65536 ? p : 15730; }
/** 配置里的监听地址，和路由自己的默认一样是 127.0.0.1 */
function hostOf() { const h = listenOf().host; return typeof h === 'string' && h ? h : '127.0.0.1'; }
/** 端口上是不是我们的路由在跑：{ listening, ours, version } */
function probe(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/version', timeout: 1200 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let v = ''; try { v = String(JSON.parse(b).version || ''); } catch (e) { /* 不是我们的 */ } resolve({ listening: true, ours: !!v, version: v }); });
    });
    r.on('timeout', () => { r.destroy(); resolve({ listening: true, ours: false, version: '' }); });
    r.on('error', (e) => resolve({ listening: !(e && e.code === 'ECONNREFUSED'), ours: false, version: '' }));
  });
}
/** 只看端口通不通，给钩子用，要快 */
function portOpen(port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms || 400, () => done(true)); // 连上了但没反应也算有东西在
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
/** 路由监听 host:port 时，netstat 里"本地地址"一栏会是哪几种写法 */
function localAddrs(host, port) {
  const h = String(host || '127.0.0.1').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return ['127.0.0.1:' + port, '[::1]:' + port];
  return [(h.includes(':') ? '[' + h + ']' : h) + ':' + port];
}
/**
 * 正在监听 host:port 的进程。只认本地地址和配置里的完全一样的那一行：别的程序可能同时监听着 0.0.0.0:同一个端口，
 * netstat 往往先列出它，按端口号取第一条就会杀错人
 */
function pidOnPort(port, host) {
  const want = localAddrs(host || hostOf(), port);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(sysExe('netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) { const m = line.trim().split(/\s+/); if (m.length >= 5 && /^TCP$/i.test(m[0]) && /^LISTENING$/i.test(m[3]) && want.includes(m[1].toLowerCase())) return parseInt(m[4], 10) || 0; }
    } else {
      for (const a of want) {
        const hp = a.replace(/:(\d+)$/, '');
        const pid = parseInt(execFileSync('lsof', ['-nP', '-t', '-sTCP:LISTEN', '-iTCP@' + hp + ':' + port], { encoding: 'utf8' }).trim().split('\n')[0], 10);
        if (pid) return pid;
      }
    }
  } catch (e) { /* 查不到就当没有 */ }
  return 0;
}
function readPidFile() {
  try { const j = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); return j && Number(j.pid) > 0 ? j : null; } catch (e) { return null; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
/** 请路由自己保存用量、退出：带上它启动时写在 pid 文件里的令牌（网页、别的程序拿不到） */
function askShutdown(port, token) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/internal/shutdown', method: 'POST', timeout: 1500, agent: false, headers: { 'content-type': 'application/json', 'content-length': 2, 'x-vibe-token': token } }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.on('error', () => resolve(false));
    r.end('{}');
  });
}
async function waitClosed(port, ms) {
  const until = Date.now() + ms;
  for (;;) {
    if (!(await portOpen(port, 300))) return true;
    if (Date.now() >= until) return false;
    await sleep(150);
  }
}
function killPid(pid) {
  try { process.kill(pid); } catch (e) { try { execFileSync(sysExe('taskkill.exe'), ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }); } catch (e2) { /* 下面会发现没停掉 */ } }
}

/**
 * 在后台拉起路由：独立于当前进程，没有窗口。
 * 输出接到 router.out.log，只为了留住启动时就崩掉的报错（语法错误之类）；路由发现标准输出是文件，平时的日志只写 router.log（满 5 MB 轮换），
 * 不会再往这里写一份，所以它不会越跑越大
 */
function launch() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outLog = path.join(DATA_DIR, 'router.out.log');
  try { if (fs.statSync(outLog).size > 2 * 1024 * 1024) fs.writeFileSync(outLog, ''); } catch (e) { /* 还没有 */ }
  const out = fs.openSync(outLog, 'a');
  const child = spawn(process.execPath, [ROUTER_JS, '-c', CONFIG], { cwd: DATA_DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  try { fs.closeSync(out); } catch (e) { /* 忽略 */ }
}
const tail = (f, n) => { try { return fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim().split(/\r?\n/).slice(-n).join('\n'); } catch (e) { return ''; } };
const tailLog = () => [tail('router.out.log', 6), tail('router.log', 4)].filter(Boolean).join('\n');

async function start() {
  const port = portOf();
  let p = await probe(port);
  if (p.ours) return { ok: true, already: true, port, version: p.version };
  if (p.listening) return { ok: false, port, reason: '端口 ' + port + ' 被别的程序占着（不是这个路由）。在 ' + CONFIG + ' 里把 listen.port 换一个，再运行一次' };
  if (!fs.existsSync(ROUTER_JS)) return { ok: false, port, reason: '找不到 ' + ROUTER_JS };
  launch();
  for (let i = 0; i < 40; i++) { await sleep(250); p = await probe(port); if (p.ours) return { ok: true, already: false, port, version: p.version }; }
  return { ok: false, port, reason: '启动了但 10 秒内没有回应。它的输出：\n' + (tailLog() || '（空）') };
}
/**
 * 停路由：
 *   1. 认人：端口上回答 /version 的是这个路由；或者它卡住了不回答，但 pid 文件里记的进程正占着配置里的 host:端口
 *      （别的程序占着同一个端口，一律不碰）
 *   2. 先带 pid 文件里的令牌请它自己保存用量、退出（Windows 上直接结束进程，路由的收尾代码不会执行，最近的用量就丢了）
 *   3. 2 秒内端口没关（卡住了、或者是没有这个接口的旧版本），再按 pid 结束它
 */
async function stop() {
  const port = portOf();
  const host = hostOf();
  const pf = readPidFile();
  const pfHere = !!pf && Number(pf.port) === port;
  const p = await probe(port);
  if (!p.listening) {
    // 没在跑：留下的 pid 文件是上次没来得及删的，顺手删掉
    if (pfHere && !pidAlive(Number(pf.pid))) { try { fs.unlinkSync(PID_FILE); } catch (e) { /* 忽略 */ } }
    return { ok: true, wasRunning: false, port };
  }
  const listenPid = pidOnPort(port, host);
  const stuck = !p.ours && pfHere && listenPid > 0 && listenPid === Number(pf.pid);
  if (!p.ours && !stuck) return { ok: true, wasRunning: false, port };
  let graceful = false;
  if (pfHere && pf.token) {
    graceful = await askShutdown(port, String(pf.token));
    if (graceful && await waitClosed(port, 2000)) return { ok: true, wasRunning: true, port, graceful: true };
  }
  const pid = listenPid || (pfHere && pidAlive(Number(pf.pid)) ? Number(pf.pid) : 0);
  if (pid) killPid(pid);
  if (await waitClosed(port, 3000)) return { ok: true, wasRunning: true, port, graceful: false, killed: pid };
  return { ok: false, wasRunning: true, port, reason: '停不掉占着端口 ' + port + ' 的进程（PID ' + (pid || '查不到') + '）' };
}
/** 钩子用：没在跑就悄悄拉起来，不等它起好。任何情况都不抛异常 */
async function ensureRunning() {
  try {
    if (!fs.existsSync(ROUTER_JS)) return 'absent';
    if (await portOpen(portOf(), 400)) return 'running';
    launch();
    return 'started';
  } catch (e) { return 'error'; }
}

// ---------- 登录后自动启动 ----------
const vbsText = () => [
  "' vibe-kit 模型路由：登录后在后台启动，没有窗口。删掉这个文件就不再自动启动（以后装新版也不会再加回来）。",
  'Dim fso, sh, node',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set sh = CreateObject("WScript.Shell")',
  'node = "' + process.execPath + '"',
  'If Not fso.FileExists(node) Then node = "node"',
  'If fso.FileExists("' + ROUTER_JS + '") Then sh.Run """" & node & """ ""' + ROUTER_JS + '"" -c ""' + CONFIG + '""", 0, False',
  '',
].join('\r\n');
// wscript 认带 BOM 的 UTF-16，路径里有中文也不会坏
const writeVbs = (file, text) => fs.writeFileSync(file, String.fromCharCode(0xFEFF) + text, 'utf16le');

/**
 * 这台机器让不让跑 .vbs：实际跑一个试试。用 cscript（控制台程序）跑：公司策略禁了脚本时，
 * wscript 会弹"Windows Script Host 访问已被禁用"的对话框（后台自动更新时用户会看到来路不明的弹框），cscript 只往标准输出写一句
 */
function wshWorks() {
  if (process.platform !== 'win32') return false;
  const probeVbs = path.join(DATA_DIR, 'wsh-probe.vbs');
  const mark = path.join(DATA_DIR, 'wsh-probe.ok');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.unlinkSync(mark); } catch (e) { /* 没有 */ }
    writeVbs(probeVbs, 'CreateObject("Scripting.FileSystemObject").CreateTextFile("' + mark + '", True).Close\r\n');
    const exe = fs.existsSync(sysExe('cscript.exe')) ? sysExe('cscript.exe') : sysExe('wscript.exe');
    execFileSync(exe, ['//B', '//Nologo', probeVbs], { timeout: 15000, stdio: 'ignore', windowsHide: true });
    return fs.existsSync(mark);
  } catch (e) { return false; } finally { for (const f of [probeVbs, mark]) { try { fs.unlinkSync(f); } catch (e) { /* 没有 */ } } }
}
// 用户自己关掉过登录后自动启动（跑过 no-autostart，或者把"启动"文件夹里那个文件删了）：记一个标记，以后装新版（包括后台自动更新）不再加回来
const NO_AUTOSTART = path.join(DATA_DIR, 'no-autostart');
const autostartRefused = () => fs.existsSync(NO_AUTOSTART);
function refuseAutostart(why) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(NO_AUTOSTART, (why || '用户关掉的') + '\n' + new Date().toISOString() + '\n'); } catch (e) { /* 记不下：下次装的时候还会加回来 */ } }
/** force：用户明说要打开（service.js autostart）。不给的时候，用户关掉过就不加 */
function enableAutostart(force) {
  if (process.platform !== 'win32' || !VBS) return { ok: false, reason: '只支持 Windows' };
  if (!force && autostartRefused()) return { ok: false, refused: true, reason: '你关掉过登录后自动启动，这次没有加回来（要打开：node "' + path.join(__dirname, 'service.js') + '" autostart）' };
  if (!wshWorks()) return { ok: false, reason: '这台机器不让跑 .vbs 脚本（多半是公司策略）' };
  try {
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
    writeVbs(VBS, vbsText());
    try { fs.unlinkSync(NO_AUTOSTART); } catch (e) { /* 没有 */ }
    return { ok: true, file: VBS };
  } catch (e) { return { ok: false, reason: '写不进"启动"文件夹：' + e.message }; }
}
/** 只删自己放的那个：内容里指向的是这一份路由 */
function disableAutostart() {
  try {
    if (!VBS || !fs.existsSync(VBS)) return { ok: true, removed: false };
    if (!fs.readFileSync(VBS, 'utf16le').includes(ROUTER_JS)) return { ok: true, removed: false };
    fs.unlinkSync(VBS);
    return { ok: true, removed: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}
const autostartOn = () => { try { return !!VBS && fs.existsSync(VBS) && fs.readFileSync(VBS, 'utf16le').includes(ROUTER_JS); } catch (e) { return false; } };

module.exports = { start, stop, probe, portOf, hostOf, pidOnPort, readPidFile, ensureRunning, enableAutostart, disableAutostart, autostartOn, autostartRefused, refuseAutostart, DATA_DIR, CONFIG, VBS, PID_FILE };

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2] || 'status';
    const say = (s) => console.log('  ' + s);
    if (cmd === 'start' || cmd === 'restart') {
      if (cmd === 'restart') await stop();
      const r = await start();
      say(r.ok ? '[OK] 路由 v' + r.version + (r.already ? ' 本来就在运行' : ' 已在后台启动') + '：http://127.0.0.1:' + r.port + '/ui' : '[X] ' + r.reason);
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd === 'stop') { const r = await stop(); say(r.ok ? (r.wasRunning ? '[OK] 已停止' : '本来就没在运行') : '[X] ' + r.reason); process.exit(r.ok ? 0 : 1); }
    if (cmd === 'autostart') { const r = enableAutostart(true); say(r.ok ? '[OK] 登录后自动启动：' + r.file : '[!] 没设成：' + r.reason); process.exit(r.ok ? 0 : 1); }
    if (cmd === 'no-autostart') { const r = disableAutostart(); if (r.ok) refuseAutostart('跑了 service.js no-autostart'); say(r.ok ? (r.removed ? '[OK] 已取消登录后自动启动（以后装新版也不会再加回来）' : '本来就没设（以后装新版也不会加）') : '[X] ' + r.reason); process.exit(r.ok ? 0 : 1); }
    const port = portOf();
    const p = await probe(port);
    say((p.ours ? '在运行，v' + p.version : p.listening ? '端口 ' + port + ' 被别的程序占着' : '没在运行') + '；登录后自动启动：' + (autostartOn() ? '是' : '否') + '；配置页 http://127.0.0.1:' + port + '/ui；数据目录 ' + DATA_DIR);
  })();
}
