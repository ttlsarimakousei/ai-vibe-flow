'use strict';
/*
 * 起服务自测的管家：记住起过哪些服务，不重复起、不换端口、测完能一把停掉。
 *
 *   node devserver.js start --name <名字> --port <端口> [--hot] [--wait 秒] [--env K=V ...] [--dir 项目目录] [--cwd 运行目录] -- <启动命令>
 *   node devserver.js stop [--name <名字> | --all] [--dir 项目目录]
 *   node devserver.js status [--dir 项目目录]
 *
 * start 的意思是"确保这个服务在跑，而且跑的是现在的代码"：
 *   - 记着的服务还在跑：代码在它启动之后没改过（或者它会热更新，--hot），就直接用，不再起一个；改过就在同一个端口重启。
 *   - 端口被占着、却没有记录：看占着的进程是谁。它的命令行里有这个项目的目录：Claude Code 起的、没人管的（起它的程序已经不在了）停掉重起；
 *     用户自己在终端、IDE 里起的（带着调试器的也算）不动，说清是谁、退出码 1（要接管加 --takeover，先问用户）；
 *     是别的程序，就说清是谁、退出码 1，不动它，也不换端口。
 *   - 起好（端口通了）才返回；起不来把日志最后几十行打出来。日志在 .vibe/run/<名字>.log，记录在 .vibe/run/<名字>.json。
 * 停的时候连子进程一起停（mvn → java 这种）；停完端口还被这个项目的进程占着的（Tomcat 的 startup.bat 这类会甩开父进程），也一起停；
 * 起来的时候记下它起的每个进程（.vibe/run/<名字>.json 的 tree），停的时候还活着的一个个结束：中间那层进程先退了的，
 * 下面的进程按父子关系找不到，以前会留下来（两个 java 一起跑，请求打到哪个不一定——问题反馈 F20260928-011）。
 * 输出的最后一行就是结果："起来了：…""没起来：…""停了：…"。用 && 把 stop 和 start 串起来也行：stop 等端口空出来才返回。
 * 模型路由（~/.claude/vibe-kit/router-data/router.pid）无论如何不停。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const sub = argv[0] || 'status';
const dash = argv.indexOf('--');
const opts = dash >= 0 ? argv.slice(1, dash) : argv.slice(1);
const cmdArgs = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (k) => { const i = opts.indexOf('--' + k); return i >= 0 && i + 1 < opts.length && !opts[i + 1].startsWith('--') ? opts[i + 1] : ''; };
const flag = (k) => opts.includes('--' + k);
const envs = []; opts.forEach((o, i) => { if (o === '--env' && opts[i + 1]) envs.push(opts[i + 1]); });
const dir = path.resolve(opt('dir') || process.cwd());
const runDir = path.join(dir, '.vibe', 'run');
const recFile = (name) => path.join(runDir, name.replace(/[^\w.\-一-龥]/g, '_') + '.json');
const logFile = (name) => path.join(runDir, name.replace(/[^\w.\-一-龥]/g, '_') + '.log');
const readRec = (name) => { try { return JSON.parse(fs.readFileSync(recFile(name), 'utf8')); } catch (e) { return null; } };
const allRecs = () => { try { return fs.readdirSync(runDir).filter((f) => /\.json$/i.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const dropRec = (name) => { try { fs.unlinkSync(recFile(name)); } catch (e) { /* 没有 */ } };
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + ' 秒前' : s < 5400 ? Math.round(s / 60) + ' 分钟前' : s < 172800 ? Math.round(s / 3600) + ' 小时前' : Math.round(s / 86400) + ' 天前'; };

// ---------- 进程和端口 ----------
function alive(pid) { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function portOpen(port, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const tryHost = (hosts) => {
      if (!hosts.length) return finish(false);
      const s = net.connect({ host: hosts[0], port });
      s.setTimeout(ms || 500, () => { s.destroy(); tryHost(hosts.slice(1)); });
      s.on('connect', () => { s.destroy(); finish(true); });
      s.on('error', () => tryHost(hosts.slice(1)));
    };
    tryHost(['127.0.0.1', '::1']);
  });
}
/** 正在监听这个端口的进程号（本机所有地址上的都算） */
function listeners(port) {
  const out = new Set();
  try {
    if (WIN) {
      const text = execFileSync(path.join(SYS32, 'netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true });
      for (const line of text.split(/\r?\n/)) { const m = line.trim().split(/\s+/); if (m.length >= 5 && /^TCP$/i.test(m[0]) && /LISTENING/i.test(m[3]) && m[1].endsWith(':' + port)) out.add(Number(m[4])); }
    } else {
      const text = execFileSync('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
      for (const l of text.split(/\n/)) if (Number(l)) out.add(Number(l));
    }
  } catch (e) { /* 查不到就当没有 */ }
  return [...out].filter((p) => p > 0);
}
/** 进程的名字、命令行、创建时间 */
function procInfo(pid) {
  try {
    if (WIN) {
      const ps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + Number(pid) + "'; if ($p) { $p.Name; ([datetime]$p.CreationDate).ToString('o'); $p.CommandLine }";
      const t = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).split(/\r?\n/);
      return { pid, name: (t[0] || '').trim(), created: Date.parse((t[1] || '').trim()) || 0, cmd: t.slice(2).join(' ').trim() };
    }
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return { pid, name: path.basename(cmd.split(' ')[0] || ''), created: Date.parse(lstart) || 0, cmd };
  } catch (e) { return { pid, name: '', created: 0, cmd: '' }; }
}
function routerPid() { try { return Number(JSON.parse(fs.readFileSync(path.join(KIT, 'router-data', 'router.pid'), 'utf8')).pid) || 0; } catch (e) { return 0; } }
/** 这台电脑上现在所有的进程：[{ pid, ppid, name, created }]。查不了返回空 */
function procTable() {
  try {
    if (WIN) {
      const ps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.ParentProcessId + [char]9 + $_.Name + [char]9 + ([datetime]$_.CreationDate).ToString('o') }";
      const t = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      return t.split(/\r?\n/).map((l) => l.split('\t')).filter((x) => x.length >= 4 && Number(x[0]) > 0).map((x) => ({ pid: Number(x[0]), ppid: Number(x[1]), name: x[2], created: Date.parse(x[3]) || 0 }));
    }
    const t = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    return t.split(/\n/).map((l) => l.trim().split(/\s+/)).filter((x) => Number(x[0]) > 0).map((x) => ({ pid: Number(x[0]), ppid: Number(x[1]), name: path.basename(x.slice(2).join(' ')), created: 0 }));
  } catch (e) { return []; }
}
/** root 起的所有进程（子、孙……）。进程号会重用：子进程的创建时间不能比父进程早 */
function descendants(root, table) {
  const out = [];
  const seen = new Set([root]);
  const at = new Map(table.map((p) => [p.pid, p]));
  let layer = [root];
  for (let depth = 0; depth < 12 && layer.length; depth++) {
    const next = [];
    for (const p of table) {
      if (seen.has(p.pid) || !layer.includes(p.ppid)) continue;
      const parent = at.get(p.ppid);
      if (parent && parent.created && p.created && p.created < parent.created - 2000) continue;
      seen.add(p.pid); next.push(p.pid); out.push(p);
    }
    layer = next;
  }
  return out;
}
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/**
 * 这个进程是不是这个项目的：命令行里有项目目录；或者是这次记录的服务起来的那段时间里出现的
 * （startedAt 之后、端口通了之后几秒之内创建的：Tomcat 的 startup.bat 这类会甩开父进程，按父子关系找不到）。
 * 按时间认只在这条记录的服务还活着的时候用（live）：记录过期了（电脑重启过），之后起的进程全都"比记录晚"，不能都当成它的
 */
function belongs(info, rec, live) {
  if (!info || !info.pid || info.pid === routerPid() || info.pid === process.pid) return false;
  const d = normPath(dir);
  if (d.split('/').filter(Boolean).length >= 2 && normPath(info.cmd).includes(d + '/')) return true;
  if (!rec || !live || !info.created) return false;
  return info.created >= rec.startedAt - 3000 && info.created <= (rec.upAt || Date.now()) + 5000;
}
// 用户在用的程序：终端、IDE、资源管理器。端口上的服务往上找得到它们的，是用户自己起的
const USER_HOST = /^(explorer|idea64|idea|studio64|code|devenv|windowsterminal|openconsole|wezterm-gui|alacritty|mintty|eclipse|sts|netbeans64|webstorm64|pycharm64|goland64|rider64|hbuilderx)(\.exe)?$/i;
/**
 * 端口上这个项目的进程是谁起的：
 *   claude  Claude Code 起的（往上找得到 claude 的进程，或者 devserver 自己的看管进程）
 *   orphan  没人管的：起它的进程已经不在了（以前起了没关，那个会话早就退了）
 *   user    用户自己在终端、IDE 里起的；带着调试器（-agentlib:jdwp）的也算用户的
 * 用户的不能不打招呼就结束：终端里的服务没了、IDE 的调试断了，用户不知道是怎么回事
 */
function whoStarted(info, table) {
  if (/-agentlib:jdwp|-Xrunjdwp/i.test(info.cmd || '')) return 'user';
  const at = new Map(table.map((p) => [p.pid, p]));
  let cur = at.get(info.pid);
  if (!cur) return 'user';
  let nodes = 0;
  for (let depth = 0; depth < 20; depth++) {
    const parent = at.get(cur.ppid);
    if (!parent || (parent.created && cur.created && parent.created > cur.created + 2000)) return 'orphan';
    if (/^claude(\.exe)?$/i.test(parent.name)) return 'claude';
    if (USER_HOST.test(parent.name)) return 'user';
    if (/^node(\.exe)?$/i.test(parent.name) && nodes < 3) {
      nodes++;
      const c = procInfo(parent.pid).cmd || '';
      if (/claude-code|[\\/]claude(\.exe)?["'\s]|devserver\.js["'\s]+__keep/i.test(c)) return 'claude';
    }
    cur = parent;
  }
  return 'user';
}
/**
 * 记录里的进程还是当初起的那一个吗：Windows 会重用进程号，服务早就退了、号被别的程序拿去了的，不能当成它去停。
 * 看进程的创建时间和记录的启动时间对不对得上（查不到创建时间就只能认进程号）
 */
function sameProc(rec) {
  if (!rec || !alive(rec.pid)) return false;
  const i = procInfo(rec.pid);
  return !i.created || Math.abs(i.created - rec.startedAt) < 15000;
}
function killTree(pid) {
  if (!alive(pid) || pid === routerPid()) return;
  try {
    if (WIN) execFileSync(path.join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-pid, 'SIGTERM'); } catch (e) { process.kill(pid, 'SIGTERM'); } }
  } catch (e) { /* 已经没了 */ }
}
async function waitClosed(port, ms) { const until = Date.now() + ms; while (Date.now() < until) { if (!(await portOpen(port, 300))) return true; await sleep(250); } return !(await portOpen(port, 300)); }

/**
 * 停一个记着的服务：连子进程一起停；起来时记下的进程（tree）还活着的一个个停；停完端口还被这个项目的进程占着，也停。
 * 等端口空出来才返回。返回 { free: 端口空出来了没有, killed: 停掉的进程, left: 还占着端口的进程 }
 */
async function stopRec(rec) {
  const killed = [];
  // 停之前先看一眼它现在起着哪些进程：看管进程一结束，下面的进程就按父子关系找不到了
  const table = procTable();
  const mine = new Map();
  const live = sameProc(rec);
  if (live) for (const p of descendants(rec.pid, table)) mine.set(p.pid, p);
  for (const p of Array.isArray(rec.tree) ? rec.tree : []) {
    const now = table.find((x) => x.pid === p.pid);
    // 进程号被别的程序拿去了的不碰：创建时间要对得上
    if (now && (!p.created || !now.created || Math.abs(now.created - p.created) < 3000)) mine.set(p.pid, now);
  }
  if (live) { killTree(rec.pid); killed.push({ pid: rec.pid, name: '看管进程' }); }
  for (const p of mine.values()) { if (p.pid === routerPid() || p.pid === process.pid || !alive(p.pid)) continue; killTree(p.pid); killed.push({ pid: p.pid, name: p.name }); }
  if (rec.port && !(await waitClosed(rec.port, 5000))) {
    // 端口还被占着：只停这个服务那段时间起来的（记录还活着的时候才按时间认），和它起的、命令行里有项目目录的。
    // 记录过期了的，端口上的进程只报告、不动：多半是别的程序后来占了这个端口
    const t2 = procTable();
    for (const pid of listeners(rec.port)) {
      const info = procInfo(pid);
      const byTime = belongs(Object.assign({}, info, { cmd: '' }), rec, live);
      const byDir = belongs(info, null, false) && live && whoStarted(info, t2) !== 'user';
      if (byTime || byDir) { killTree(pid); killed.push({ pid, name: info.name }); }
    }
    await waitClosed(rec.port, 5000);
  }
  dropRec(rec.name);
  const free = !(rec.port && (await portOpen(rec.port, 300)));
  const left = free ? [] : listeners(rec.port).map(procInfo);
  return { free, killed, left };
}

// ---------- 代码在服务起来之后改过没有 ----------
const SKIP = new Set(['.git', '.vibe', 'node_modules', 'target', 'build', 'dist', 'out', 'logs', '.idea', '.vscode']);
function gitRootOf(d) {
  let x = path.resolve(d);
  for (let i = 0; i < 30; i++) { if (fs.existsSync(path.join(x, '.git'))) return x; const up = path.dirname(x); if (up === x) break; x = up; }
  return '';
}
/**
 * 服务启动（t）之后，它实际运行的目录（where，--cwd；没写就是项目目录）里的代码改过没有。
 * 按运行目录往上找它自己的 git 仓库，只看这个目录里的改动和之后的提交——在壳子里用 --cwd 子项目起服务时，
 * 子项目是独立仓库就查子项目；子项目在壳子仓库里被忽略、git 看不到的，扫文件修改时间（有上限）
 */
function changedSince(t, where) {
  const base = path.resolve(where || dir);
  const changed = [];
  const root = gitRootOf(base);
  const gitOut = (args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false'].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  if (root) {
    try {
      const rel = path.relative(root, base).split(path.sep).join('/');
      let ignored = false;
      if (rel) { try { execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore', windowsHide: true }); ignored = true; } catch (e) { ignored = false; } }
      if (!ignored) {
        for (const line of gitOut(['status', '--porcelain', '-uall', '--', rel || '.']).split(/\r?\n/)) {
          const f = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
          if (!f || f.split('/').some((s) => SKIP.has(s))) continue;
          try { if (fs.statSync(path.join(root, f)).mtimeMs > t) changed.push(f); } catch (e) { /* 删掉的文件 */ }
        }
        const head = Number(gitOut(['log', '-1', '--format=%ct', '--', rel || '.']).trim()) * 1000;
        if (head > t && !changed.length) changed.push('（启动之后有新的提交）');
        return changed;
      }
    } catch (e) { /* 查不了就扫文件 */ }
  }
  let n = 0;
  const walk = (d, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (++n > 50000 || changed.length >= 20) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 12) walk(path.join(d, e.name), depth + 1); continue; }
      try { if (fs.statSync(path.join(d, e.name)).mtimeMs > t) changed.push(path.relative(base, path.join(d, e.name)).split(path.sep).join('/')); } catch (err) { /* 刚被删 */ }
    }
  };
  walk(base, 0);
  return changed;
}

// ---------- 启动 ----------
/*
 * Windows 上不能直接 detached 起服务：detached 的进程没有控制台，windowsHide 管不到它再起的进程——cmd 起的 node、java 会自己开一个控制台窗口，
 * Win11 的默认终端是 Windows Terminal，窗口弹在桌面上，服务被停掉（强制结束，退出码不是 0）之后窗口还一直留着。
 * 所以先 detached 起一个看管进程（就是本脚本的 __keep，node 用不着控制台，不会有窗口），由它起服务：windowsHide 加上输出走管道，
 * Windows 给服务一个没有窗口的控制台（CREATE_NO_WINDOW），服务再起的子进程（mvn → java）也用这个看不见的控制台；输出由看管进程写进日志。
 * 服务退出，看管进程跟着退出；停的时候按看管进程的进程号连子进程一起结束。
 */
function keep() {
  const env = Object.assign({}, process.env);
  const command = env.VIBE_DEVSERVER_CMD || '';
  delete env.VIBE_DEVSERVER_CMD;
  const c = spawn(command, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  c.stdout.pipe(process.stdout);
  c.stderr.pipe(process.stderr);
  c.on('error', (e) => { console.error('起不来：' + e.message); process.exit(1); });
  c.on('close', (code) => process.exit(code == null ? 1 : code));
}
const quote = (a) => (/^[\w.\-/:\\=@%+,]+$/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"');
async function launch(name, port, command) {
  fs.mkdirSync(runDir, { recursive: true });
  const log = logFile(name);
  const fd = fs.openSync(log, 'w');
  const env = Object.assign({}, process.env);
  for (const kv of envs) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  const cwd = path.resolve(dir, opt('cwd') || '.');
  const child = WIN
    ? spawn(process.execPath, [__filename, '__keep'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd, env: Object.assign({}, env, { VIBE_DEVSERVER_CMD: command }) })
    : spawn(command, { shell: true, detached: true, stdio: ['ignore', fd, fd], cwd, env });
  child.unref();
  fs.closeSync(fd);
  const rec = { name, pid: child.pid, port, cmd: command, cwd, startedAt: Date.now(), hot: flag('hot'), log };
  fs.writeFileSync(recFile(name), JSON.stringify(rec, null, 2));
  return waitUp(rec, Number(opt('wait')) || 180);
}
/** 日志最后一段：先按 UTF-8 解，解不开（cmd、bat 的报错是 GBK）再按 GBK 解 */
function logTail(file) {
  try {
    const b = fs.readFileSync(file);
    let s = b.slice(Math.max(0, b.length - 4000));
    let k = 0;
    while (k < 3 && k < s.length && (s[k] & 0xC0) === 0x80) k++;
    s = s.slice(k);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(s); } catch (e) { try { return new TextDecoder('gbk').decode(s); } catch (err) { return s.toString('utf8'); } }
  } catch (e) { return ''; }
}
/** 等它起来（端口通了）。0 = 起来了；1 = 没起来：进程退了就删掉记录，等到超时进程还在就留着记录（多半还在启动，再 start 会接着等） */
/** 现在是谁在听这个端口：'java（PID 19228）' */
function whoListens(port) {
  const l = listeners(port).map(procInfo).filter((i) => i.pid);
  return l.length ? l.map((i) => (i.name || '进程').replace(/\.exe$/i, '') + '（PID ' + i.pid + '）').join('、') : '';
}
async function waitUp(rec, waitSec) {
  const t0 = Date.now();
  let deadAt = 0;
  while (Date.now() - t0 < waitSec * 1000) {
    if (await portOpen(rec.port, 400)) {
      // 记下它起的每个进程：停的时候一个个清掉。听端口的进程单独说：看进程列表时认的是它，不是看管进程
      const table = procTable();
      const tree = descendants(rec.pid, table).map((p) => ({ pid: p.pid, name: p.name, created: p.created }));
      for (const pid of listeners(rec.port)) { const p = table.find((x) => x.pid === pid); if (p && !tree.some((x) => x.pid === pid) && belongs(procInfo(pid), rec, true)) tree.push({ pid: p.pid, name: p.name, created: p.created }); }
      try { fs.writeFileSync(recFile(rec.name), JSON.stringify(Object.assign({}, rec, { tree, upAt: Date.now() }), null, 2)); } catch (e) { /* 记不了就按父子关系停 */ }
      const who = whoListens(rec.port);
      // 这一行放在最后：输出的最后一行就是结果
      console.log('测完停掉用：node "' + __filename + '" stop --name ' + rec.name + (opt('dir') ? ' --dir "' + dir + '"' : ''));
      console.log('起来了：' + rec.name + '，端口 ' + rec.port + '，用了 ' + Math.round((Date.now() - rec.startedAt) / 1000) + ' 秒' + (who ? '。听这个端口的是 ' + who : '') + '。日志 ' + path.relative(process.cwd(), rec.log));
      return 0;
    }
    // 启动命令自己退了（startup.bat 这类把服务甩到后台就走）：服务可能还在起，再等它 15 秒
    if (!alive(rec.pid)) { if (!deadAt) deadAt = Date.now(); if (Date.now() - deadAt > 15000) break; }
    await sleep(deadAt ? 500 : 1000);
  }
  const dead = !alive(rec.pid);
  if (dead) dropRec(rec.name);
  console.log('日志最后几段（' + rec.log + '）：\n' + logTail(rec.log).split(/\r?\n/).slice(-30).join('\n'));
  console.log(dead ? '没起来：' + rec.name + ' 的进程已经退出了，看上面的日志。' : '没起来：' + waitSec + ' 秒内端口 ' + rec.port + ' 还没通。进程还在、记录留着：多半还在启动（大项目要一两分钟），过一会儿再 start 一次会接着等它，不会重起；也可能它实际监听的不是这个端口，看上面的日志。');
  return 1;
}

async function start() {
  const name = opt('name') || 'app';
  const port = Number(opt('port'));
  if (!(port > 0 && port < 65536)) { console.log('要写 --port <端口>：这个服务监听的端口（项目说明里记的那个）。不要换端口另起一个。'); return 2; }
  if (!cmdArgs.length) { console.log('要在 -- 后面写启动命令，比如：node devserver.js start --name backend --port 8080 -- mvn spring-boot:run'); return 2; }
  // -- 后面只有一个参数（整条命令加了引号）：原样用，不再包一层引号
  const command = cmdArgs.length === 1 ? cmdArgs[0] : cmdArgs.map(quote).join(' ');
  const cwd = path.resolve(dir, opt('cwd') || '.');
  // 同一个服务：命令、端口、运行目录都一样（同名同端口换了个子项目，不能拿另一个子项目的服务来用）
  const same = (r) => r.cmd === command && r.port === port && normPath(r.cwd || dir) === normPath(cwd);
  const rec = readRec(name);
  const recUp = rec ? await portOpen(rec.port, 500) : false;
  if (rec && sameProc(rec) && !recUp) {
    // 进程还在、端口没通：多半还在启动。同一个服务就接着等，不结束重来（大项目起得慢，结束重来可能永远起不来）
    if (same(rec)) { console.log(name + ' 还在启动（进程 ' + rec.pid + '，' + ago(rec.startedAt) + '起的），接着等它。'); return waitUp(rec, Number(opt('wait')) || 180); }
    console.log(name + ' 还在启动，但这次的启动命令、端口或运行目录变了：停掉，重来。');
    killTree(rec.pid);
    dropRec(rec.name);
  } else if (rec && recUp && sameProc(rec)) {
    const changed = flag('restart') ? ['（要求重启）'] : rec.hot ? [] : changedSince(rec.startedAt, rec.cwd);
    if (!changed.length && same(rec)) {
      const who = whoListens(rec.port);
      console.log('已经在跑：' + name + '（端口 ' + rec.port + '，' + ago(rec.startedAt) + '起的' + (who ? '，听这个端口的是 ' + who : '') + '）' + (rec.hot ? '，会热更新' : '，启动之后代码没改过') + '。直接用，不用再起。要强制重启加 --restart。');
      return 0;
    }
    console.log(name + ' 在跑（端口 ' + rec.port + '，' + ago(rec.startedAt) + '起的），' + (!same(rec) ? '启动命令、端口或运行目录变了' : '但它跑的不是现在的代码（之后改过：' + changed.slice(0, 5).join('、') + (changed.length > 5 ? ' 等 ' + changed.length + ' 个' : '') + '）') + '：停掉，在同一个端口重启。');
    const s = await stopRec(rec);
    if (!s.free) { console.log('没起来：旧的没停干净，端口 ' + port + ' 还被占着：' + (s.left.map((i) => (i.name || '进程') + '（PID ' + i.pid + '）').join('、') || '查不到是哪个进程') + '。没有起新的。'); return 1; }
  } else if (rec) {
    // 记录里的进程已经不在了（号被别的程序拿去了的不碰），记录清掉
    dropRec(rec.name);
  }
  // 端口还被占着：看是谁
  if (await portOpen(port, 500)) {
    const pids = listeners(port);
    const infos = pids.map(procInfo);
    const mine = infos.filter((i) => belongs(i, null));
    const others = infos.filter((i) => !belongs(i, null));
    if (!pids.length || others.length) {
      const who = others.length ? others.map((i) => (i.name || '进程') + '（PID ' + i.pid + (i.pid === routerPid() ? '，这是模型路由' : '') + '）' + (i.cmd ? '：' + i.cmd.slice(0, 200) : '')).join('；') : '查不到是哪个进程';
      console.log('端口 ' + port + ' 被占着：' + who + '。它不是这个项目（' + dir + '）起的服务，没有动它。\n确认它是没用的就停掉它（taskkill /PID <PID> /T /F），拿不准就问用户；不要换端口另起一个——前端代理、配置里写的都是这个端口，换了测的就不是你改的这一份。');
      return 1;
    }
    // 这个项目的进程，但没有记录：看是谁起的。Claude Code 起的、没人管的（起它的进程已经不在了）停掉重起；
    // 用户自己在终端、IDE 里起的（带着调试器的也算）不动，除非加了 --takeover（先问过用户）
    const table = procTable();
    const who = mine.map((i) => ({ i, by: whoStarted(i, table) }));
    const users = who.filter((x) => x.by === 'user');
    if (users.length && !flag('takeover')) {
      console.log('端口 ' + port + ' 上是用户自己起的这个项目的服务：' + users.map((x) => (x.i.name || '进程') + '（PID ' + x.i.pid + (x.i.created ? '，' + ago(x.i.created) + '起的' : '') + '）' + (x.i.cmd ? '：' + x.i.cmd.slice(0, 160) : '')).join('；') + '。没有动它。\n'
        + '要用就直接拿它测（它跑的可能不是你改过之后的代码：改的是后端的话，先问用户要不要重启它）。确实要由 devserver 接管（结束它、在同一个端口重起），先问用户，同意了再加 --takeover 重跑。全自动模式下用户不在：不要接管，把要重启才能验的那一步留给用户。');
      return 1;
    }
    console.log('端口 ' + port + ' 被这个项目的进程占着（' + who.map((x) => (x.i.name || '进程') + ' PID ' + x.i.pid + (x.i.created ? '，' + ago(x.i.created) + '起的' : '') + '，' + (x.by === 'claude' ? 'Claude Code 起的' : x.by === 'orphan' ? '起它的程序已经不在了' : '用户起的，按 --takeover 接管')).join('；') + '）：停掉，重启。');
    for (const x of who) killTree(x.i.pid);
    if (!(await waitClosed(port, 8000))) { console.log('停不掉占着端口 ' + port + ' 的进程，没有起新的。'); return 1; }
  }
  return launch(name, port, command);
}

async function stop() {
  const recs = flag('all') || !opt('name') ? allRecs() : [readRec(opt('name'))].filter(Boolean);
  if (!recs.length) { console.log(opt('name') ? '没有叫 ' + opt('name') + ' 的服务记录（' + runDir + '）' : '这个项目没有记着在跑的服务（' + runDir + '）'); return 0; }
  let bad = 0;
  for (const r of recs) {
    const s = await stopRec(r);
    const n = s.killed.filter((k) => k.name !== '看管进程').map((k) => String(k.name || '进程').replace(/\.exe$/i, '') + ' ' + k.pid);
    if (s.free) console.log((s.killed.length ? '停了：' : '本来就没在跑，记录清掉了：') + r.name + '，端口 ' + r.port + ' 空出来了' + (n.length ? '（结束了 ' + n.slice(0, 6).join('、') + '）' : '') + '。');
    else { bad++; console.log('没停干净：' + r.name + '，端口 ' + r.port + ' 还被占着：' + (s.left.map((i) => (i.name || '进程') + '（PID ' + i.pid + '）' + (i.cmd ? ' ' + i.cmd.slice(0, 120) : '')).join('；') || '查不到是哪个进程') + '。它不是这个项目起的，没有动它；先弄清它是谁，不要换端口另起一个。'); }
  }
  return bad ? 1 : 0;
}

async function status() {
  const recs = allRecs();
  if (!recs.length) { console.log('这个项目没有记着的服务（' + runDir + '）。'); return 0; }
  for (const r of recs) {
    const alive_ = sameProc(r);
    const open = alive_ && (await portOpen(r.port, 500));
    // 只报告，不结束任何进程：进程在、端口没通的是还在启动
    if (!alive_) { console.log(r.name + '：没在跑（进程已经退了），记录清掉了。\n  命令：' + r.cmd + '\n  日志：' + r.log); dropRec(r.name); continue; }
    if (!open) { console.log(r.name + '：还在启动（进程 ' + r.pid + ' 在，端口 ' + r.port + ' 还没通，' + ago(r.startedAt) + '起的）。等一会儿；start 一次会接着等它。\n  命令：' + r.cmd + '\n  日志：' + r.log); continue; }
    const changed = !r.hot ? changedSince(r.startedAt, r.cwd) : [];
    const who = whoListens(r.port);
    console.log(r.name + '：在跑，端口 ' + r.port + (who ? '，听这个端口的是 ' + who : '') + '，' + ago(r.startedAt) + '起的' + (r.hot ? '，会热更新' : changed.length ? '，之后代码改过（' + changed.slice(0, 3).join('、') + (changed.length > 3 ? ' 等' : '') + '），测之前要 start 一下（会自动重启）' : '，跑的是现在的代码') + '\n  命令：' + r.cmd + '\n  运行目录：' + (r.cwd || dir) + '\n  日志：' + r.log);
  }
  return 0;
}

module.exports = { changedSince, belongs, whoStarted, listeners, procInfo, sameProc, procTable, descendants };
if (require.main === module && sub === '__keep') keep();
else if (require.main === module) {
  const f = { start, stop, status }[sub];
  if (!f) { console.log('用法：node devserver.js start|stop|status …（见文件开头的说明）'); process.exit(2); }
  f().then((code) => process.exit(code || 0), (e) => { console.log('出错了：' + ((e && e.stack) || e)); process.exit(1); });
}
