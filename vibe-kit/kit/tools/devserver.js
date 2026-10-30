'use strict';
/*
 * 起服务自测的管家：记住起过哪些服务，不重复起、不换端口、测完能一把停掉。
 *
 *   node devserver.js start --name <名字> --port auto [--avoid 端口,端口] [--hot] [--wait 秒] [--env K=V ...] [--dir 项目目录] [--cwd 运行目录] -- <启动命令>
 *   node devserver.js start --name <名字> --port <端口> …                        指定端口（前端代理写死了后端端口这类情况）
 *   node devserver.js stop [--name <名字> | --all] [--dir 项目目录]
 *   node devserver.js status [--dir 项目目录]
 *
 * 端口（用户 2026-10-07 定的）：--port auto 在 30000 到 39999 里挑，离 --avoid 给的端口（项目配置里写的）至少 1000——用户自己在 IDE 里按配置的
 *   端口起同一个服务不会撞上，这一类项目端口顺着编（8080、8081……）的也撞不上。起点按项目目录和服务名算，同一个服务每次挑到同一个端口。
 *   挑到的端口怎么交给服务：命令里的 {port} 换成它；环境变量 PORT、SERVER_PORT、VIBE_PORT 也设成它（Spring Boot 认 SERVER_PORT，Vue CLI、
 *   Next、CRA 认 PORT；Vite、webpack-dev-server 不认，命令里要写 -- --port {port}）。起来之后最后一行说用的是哪个端口。
 * start 的意思是"确保这个服务在跑，而且跑的是现在的代码"：
 *   - 记着的服务还在跑：代码在它启动之后没改过（或者它会热更新，--hot），就直接用，不再起一个；改过就在同一个端口重启。
 *   - 端口被占着、却没有记录：看占着的进程是谁。它的命令行里有这个项目的目录：Claude Code 起的、没人管的（起它的程序已经不在了）停掉重起；
 *     用户自己在终端、IDE 里起的（带着调试器的也算）不动，说清是谁、退出码 1（要接管加 --takeover，先问用户）；
 *     是别的程序，就说清是谁、退出码 1，不动它，也不换端口。
 *   - 起好才返回：等的时候每 2 秒看一次日志新增的内容（用户 2026-10-28 定的：定时看日志，不要一上来就一直调接口探）。
 *     日志里看到起好了的标志（Started … in … seconds、Server startup in、ready in …）再发 HTTP 确认；看到起不来的标志
 *     （APPLICATION FAILED TO START、BUILD FAILURE、端口被占……）马上停掉自己起的进程、贴日志返回，不干等到超时。
 *     端口只连不发请求；日志里认不出标志的，端口通了 3 秒发第一次 HTTP、之后每 10 秒一次（随便哪个状态码算答了），Tomcat 这类先占端口、后部署应用的，
 *     端口一通就返回会让紧接着的请求超时；一直不答 HTTP 的（不是网页服务）端口通了 60 秒也算起来。上一次没等到它答 HTTP（等超时、被打断）的，再 start 接着等。
 *     起不来把日志最后几十行打出来。日志在 .vibe/run/<名字>.log，记录在 .vibe/run/<名字>.json。
 * 停的时候连子进程一起停（mvn → java 这种）；停完端口还被这个项目的进程占着的（Tomcat 的 startup.bat 这类会甩开父进程），也一起停；
 * 起来的时候记下它起的每个进程（.vibe/run/<名字>.json 的 tree），停的时候还活着的一个个结束：中间那层进程先退了的，
 * 下面的进程按父子关系找不到，以前会留下来（两个 java 一起跑，请求打到哪个不一定——问题反馈 F20260928-011）。
 * 输出的最后一行就是结果："起来了：…""没起来：…""停了：…"。用 && 把 stop 和 start 串起来也行：stop 等端口空出来才返回。
 * 模型路由（~/.claude/vibe-kit/router-data/router.pid）无论如何不停。
 *
 * 认得自己起过的服务（用户 2026-10-28 定的，问题反馈表第 17 条："你总是忘记自己启动过哪个服务"）：
 *   每个项目的 .vibe/run 按"在哪个目录跑的 devserver、叫什么名字"记，换个目录（壳子根和子项目）、换个名字就找不到，以前会另起一份，
 *   或者 --port auto 跳过被自己占着的端口另挑一个，或者把自己起的当成用户的。现在另记一份全机的登记（套件 state/devserver.json：端口 → 记录在哪、
 *   运行目录、命令），start 找不到同名记录时按"运行目录相同、命令或名字相同"（写了端口的再按端口）认出来，接着用原来那个；要重启就在原来的端口先停再起。
 *   端口上的进程往上找得到 devserver 的看管进程的，就是 Claude 起的，不当成用户的。status、stop 也看这份登记。
 * 会热更新的不重启（同一天定的：vite 这类改了代码不用重启）：命令里、或者 npm/pnpm/yarn 跑的那个脚本里认得出 vite、webpack dev server、
 *   vue-cli-service serve、next dev 这类开发服务器，就和写了 --hot 一样，改了代码直接用。
 * 不用 IDEA 起服务（用户 2026-10-28 定的，删掉 2026-10-17 加的 IDEA 运行配置那条线）：只照 -- 后面的命令起；用户在 IDEA 里起的服务不动（端口被占说清是谁）。
 *   老版本留下的 --idea、--no-idea 参数不认也不报错；以前用 IDEA 起、记成 mode: idea 的记录，stop、status 时说清到 IDEA 里停，记录清掉，不动进程。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 这次调用从什么时候开始（耗时分两段：devserver 自己的准备、命令开始到答 HTTP）；这次是不是改了代码在重启（C7）
const T0 = Date.now();
let RESTART = false;

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
const dropRec = (name) => { unregister(recFile(name)); try { fs.unlinkSync(recFile(name)); } catch (e) { /* 没有 */ } };

// ---------- 全机的服务登记（问题反馈表第 17 条） ----------
const REG = path.join(KIT, 'state', 'devserver.json');
const readReg = () => { try { const o = JSON.parse(fs.readFileSync(REG, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
/** 读改写一次只让一个进程做（Codex C09）：两个会话同时起服务，以前后写的会盖掉先写的那条登记。锁 3 秒拿不到照旧写 */
function writeReg(fn) {
  let lock = null;
  try { lock = require('../lib/state-store').acquire(REG + '.lock', { waitMs: 3000 }); } catch (e) { lock = null; }
  try {
    const o = readReg(); fn(o);
    fs.mkdirSync(path.dirname(REG), { recursive: true });
    const tmp = REG + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, REG);
  } catch (e) { /* 记不了：照旧按项目里的记录认 */ }
  finally { if (lock) lock.release(); }
}
function register(rec, file) { writeReg((o) => { for (const k of Object.keys(o)) if (o[k] && normPath(o[k].file) === normPath(file)) delete o[k]; o[String(rec.port)] = { port: rec.port, name: rec.name, file, cwd: rec.cwd, cmd: rec.cmd, startedAt: rec.startedAt }; }); }
function unregister(file) { writeReg((o) => { for (const k of Object.keys(o)) if (!o[k] || normPath(o[k].file) === normPath(file)) delete o[k]; }); }
/** 登记里还活着的（记录文件还在、看管进程还是当初那一个），先用 pick 筛（查进程慢，不相干的不查） */
function liveReg(pick) {
  const out = [];
  for (const e of Object.values(readReg())) {
    if (!e || !e.file || (pick && !pick(e))) continue;
    let rec = null; try { rec = JSON.parse(fs.readFileSync(e.file, 'utf8')); } catch (x) { continue; }
    if (rec && rec.port === e.port && sameProc(rec)) out.push(Object.assign({}, e, { rec }));
  }
  return out;
}
/** a 和 b 是不是同一处的：一个在另一个下面，或者同一个 git 仓库 */
function sameArea(a, b) {
  const x = normPath(a), y = normPath(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
  const gx = gitRootOf(a), gy = gitRootOf(b);
  return !!gx && normPath(gx) === normPath(gy);
}
/**
 * 这次要起的服务，是不是之前用 devserver 起过、还在跑的那个（同名记录没找到时用）：
 *   在别的目录跑 devserver 起的（壳子根、子项目），运行目录相同、名字或命令（端口代进去）相同；
 *   写了端口的，在别的目录起的、同一处的、在这个端口上的也算。
 *   同一个目录里名字不同的照旧是两个服务（同一条命令起两份、环境变量不同，是有意的）
 */
function findOurs(name, cwd, port, cmdFor) {
  const key = normPath(cwd);
  const elsewhere = (e) => normPath(path.dirname(e.file)) !== normPath(runDir);
  const live = liveReg((e) => elsewhere(e) && (normPath(e.cwd) === key || (port > 0 && e.port === port && sameArea(e.cwd, cwd))));
  return live.find((e) => normPath(e.cwd) === key && (e.name === name || e.cmd === cmdFor(e.port))) || (port > 0 ? live.find((e) => e.port === port) : null) || null;
}
/** 认下之前起的那个：记录挪到这次的目录和名字下（日志留在原处，记录里是完整路径） */
function adopt(e, name, why) {
  const rec = Object.assign({}, e.rec, { name });
  const to = recFile(name);
  if (normPath(e.file) !== normPath(to)) {
    try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(to, JSON.stringify(rec, null, 2)); try { fs.unlinkSync(e.file); } catch (x) { /* 删不掉：登记已经指到新的 */ } register(rec, to); } catch (x) { return e.rec; }
  }
  console.log('认出来了：端口 ' + rec.port + ' 上是之前用 devserver 起的' + (e.name !== name ? '"' + e.name + '"' : ' ' + name) + '（' + ago(rec.startedAt) + '起的，运行目录 ' + rec.cwd + '）' + (why || '') + '。接着用它，不另起一个' + (e.name !== name ? '；以后叫 ' + name : '') + '。');
  return rec;
}

// ---------- 会热更新的开发服务器（问题反馈表第 17 条：vite 这类改了代码不用重启） ----------
const HOT_RE = /(?:^|[\s/\\"'])(?:vite(?:\.(?:js|mjs|cmd))?(?!\s+(?:build|preview|optimize))(?=\s|$|["'])|vue-cli-service(?:\.js)?\s+serve|webpack-dev-server|webpack(?:\.js)?\s+(?:serve|s)\b|next\s+dev|nuxi?\s+dev|react-scripts\s+start|umi\s+dev|max\s+dev|ng\s+serve|nodemon|ts-node-dev|tsx\s+watch|parcel(?!\s+build)(?=\s|$))/i;
/** 命令会不会热更新：命令本身认得出，或者 npm/pnpm/yarn 跑的那个脚本（package.json 的 scripts）认得出 */
function hotOf(command, cwd) {
  const c = String(command || '');
  if (HOT_RE.test(c)) return true;
  const w = (c.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
  const i = w.findIndex((t) => /^(?:npm|pnpm|yarn|cnpm)(?:\.cmd)?$/i.test(t.split(/[\\/]/).pop()));
  if (i < 0) return false;
  let pkgDir = cwd || dir, script = '';
  for (let k = i + 1; k < w.length; k++) {
    const t = w[k];
    if (['--prefix', '-C', '--cwd', '--dir'].includes(t)) { pkgDir = path.resolve(cwd || dir, w[k + 1] || '.'); k++; continue; }
    if (t === '--') break;
    if (t.startsWith('-') || t === 'run' || t === 'run-script') continue;
    script = t; break;
  }
  if (!script) return false;
  try { const sc = (JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).scripts || {})[script]; return !!sc && HOT_RE.test(' ' + sc); } catch (e) { return false; }
}
const hotRec = (r) => !!(r && (r.hot || hotOf(r.cmd, r.cwd)));
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + ' 秒前' : s < 5400 ? Math.round(s / 60) + ' 分钟前' : s < 172800 ? Math.round(s / 3600) + ' 小时前' : Math.round(s / 86400) + ' 天前'; };

// ---------- 自动挑端口 ----------
const AUTO_LOW = 30000;
const AUTO_SPAN = 10000;
const AUTO_GAP = 1000;
/** 在 30000 到 39999 里挑一个：起点按项目目录和服务名算，往后找第一个空着的；离 avoid 里的端口至少 1000；这个项目别的服务记着的端口也避开 */
async function pickPort(name, avoid, rec, where) {
  // 起点按服务实际运行的目录（--cwd，没写就是项目目录）算：在壳子根加 --cwd 子项目、和在子项目里直接跑，挑到的是同一个端口（第 17 条）
  const h = require('crypto').createHash('sha1').update(normPath(where || dir) + '|' + name).digest();
  const seed = h.readUInt16BE(0) % AUTO_SPAN;
  const taken = allRecs().filter((r) => r.name !== name && r.port > 0).map((r) => r.port);
  let first = true;
  for (let k = 0; k < AUTO_SPAN; k++) {
    const p = AUTO_LOW + ((seed + k * 7919) % AUTO_SPAN);   // 7919 和 10000 互质：走一圈每个端口正好过一次
    if (avoid.some((a) => Math.abs(a - p) < AUTO_GAP) || taken.includes(p)) continue;
    // 记着的就是这个端口：是自己上一次起的，老的还在听也不算被占（下面会停掉重起）
    if (rec && rec.port === p) return p;
    if (await portOpen(p, 200)) {
      // 这个服务每次都该挑到的第一个端口被 Claude 用 devserver 起的进程占着：多半就是它自己（记录丢了），用这个端口，下面按端口被占的规矩认（先停再起；登记里是别的项目的不动，第 17 条）
      const isFirst = first; first = false;
      if (isFirst) { try { const t = procTable(); if (listeners(p).map(procInfo).some((i) => byKeeper(i, t))) return p; } catch (e) { /* 认不出就跳过 */ } }
      continue;
    }
    return p;
  }
  return 0;
}

// ---------- 进程和端口 ----------
function alive(pid) { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function portOpen(port, ms, hostList) {
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
    tryHost(hostList || ['127.0.0.1', '::1']);
  });
}
/** 端口上的服务答不答 HTTP（随便哪个状态码都算答了）。127.0.0.1 上没人听再问 ::1：Vite 这类只听 localhost 的，可能只在 ::1 上 */
function httpAnswers(port) {
  const ask = (hosts) => new Promise((resolve) => {
    if (!hosts.length) return resolve(false);
    const q = require('http').get({ host: hosts[0], port, path: '/', timeout: 3000, agent: false }, (res) => { res.resume(); resolve(true); });
    q.on('timeout', () => { q.destroy(); resolve(false); });
    q.on('error', (e) => (e && e.code === 'ECONNREFUSED' ? ask(hosts.slice(1)).then(resolve) : resolve(false)));
  });
  return ask(['127.0.0.1', '::1']);
}
const NO_HTTP_MS = 60000;
const NO_HTTP_NOTE = '，端口通了 60 秒一直没答 HTTP，当它不是网页服务';
/** 等超时了、端口通着却还没答 HTTP 时怎么说 */
const noHttpYet = (port, waitSec) => '没起来：端口 ' + port + ' 通了，但 ' + waitSec + ' 秒内一直没答 HTTP（Tomcat 这类先占端口、后部署应用，多半还在部署；不是网页服务的，端口通了 60 秒才算起来）。';
/** 正在监听这个端口的进程号（本机所有地址上的都算） */
function listeners(port) {
  const out = new Set();
  try {
    if (WIN) {
      const text = execFileSync(path.join(SYS32, 'netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      for (const line of text.split(/\r?\n/)) { const m = line.trim().split(/\s+/); if (m.length >= 5 && /^TCP$/i.test(m[0]) && /LISTENING/i.test(m[3]) && m[1].endsWith(':' + port)) out.add(Number(m[4])); }
    } else {
      const text = execFileSync('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
      for (const l of text.split(/\n/)) if (Number(l)) out.add(Number(l));
    }
  } catch (e) { /* 查不到就当没有 */ }
  return [...out].filter((p) => p > 0);
}
/**
 * 进程的名字、命令行、创建时间。Windows 上从进程表里取（审核第五节、C 批 C2）：以前每查一个进程起一个 PowerShell（一次 1—3 秒），
 * 一次 start 要起好几个；现在一次调用只取一份带命令行的进程表，3 秒内复用，表里没有的（刚起的）才重取一次
 */
function procInfo(pid) {
  try {
    if (WIN) {
      let p = procTable().find((x) => x.pid === Number(pid));
      if (!p && TABLE && Date.now() - TABLE.at > 300) p = procTable(true).find((x) => x.pid === Number(pid));
      return p ? { pid, name: p.name, created: p.created, cmd: p.cmd || '' } : { pid, name: '', created: 0, cmd: '' };
    }
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return { pid, name: path.basename(cmd.split(' ')[0] || ''), created: Date.parse(lstart) || 0, cmd };
  } catch (e) { return { pid, name: '', created: 0, cmd: '' }; }
}
function routerPid() { try { return Number(JSON.parse(fs.readFileSync(path.join(KIT, 'router-data', 'router.pid'), 'utf8')).pid) || 0; } catch (e) { return 0; } }
/** 这台电脑上现在所有的进程：[{ pid, ppid, name, created, cmd }]。查不了返回空。Windows 上一次调用里 3 秒内复用（fresh 为真时重取） */
let TABLE = null;
const TABLE_MS = 3000;
/** 结束了进程、起了新进程之后，进程表和端口表都要重取 */
function invalidate() { TABLE = null; }
function procTable(fresh) {
  try {
    if (WIN) {
      if (!fresh && TABLE && Date.now() - TABLE.at < TABLE_MS) return TABLE.rows;
      const ps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // 字段用 \x01 隔开、每个进程用 \x02 收尾：命令行里可能有制表符、换行
      const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]1 + $_.ParentProcessId + [char]1 + $_.Name + [char]1 + ([datetime]$_.CreationDate).ToString('o') + [char]1 + $_.CommandLine + [char]2 }";
      const t = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
      const rows = t.split('\x02').map((l) => l.replace(/^\s+/, '').split('\x01')).filter((x) => x.length >= 4 && Number(x[0]) > 0).map((x) => ({ pid: Number(x[0]), ppid: Number(x[1]), name: x[2], created: Date.parse(x[3]) || 0, cmd: String(x[4] || '').replace(/\s+/g, ' ').trim() }));
      TABLE = { at: Date.now(), rows };
      return rows;
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
  const cmd = normPath(info.cmd);
  const at = cmd.indexOf(d);
  // -Dmaven.multiModuleProjectDirectory=<目录> 后面可以直接是引号或空白，并不一定有斜杠。
  if (d.split('/').filter(Boolean).length >= 2 && at >= 0 && /^(?:[\/\s"']|$)/.test(cmd.slice(at + d.length))) return true;
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
/**
 * 往上找得到 devserver 的看管进程（node devserver.js __keep）：是 Claude 用 devserver 起的（第 17 条：记录丢了也认得，不当成用户的）。
 * 只认看管进程，不认 claude.exe：从 Claude Code 里跑的别的程序（测试、工具、它自己起的脚本）往上也找得到 claude，不能当成服务去停
 */
function byKeeper(info, table) {
  const at = new Map(table.map((p) => [p.pid, p]));
  let cur = at.get(info.pid);
  for (let depth = 0; cur && depth < 20; depth++) {
    const parent = at.get(cur.ppid);
    if (!parent || (parent.created && cur.created && parent.created > cur.created + 2000)) return false;
    if (/^node(\.exe)?$/i.test(parent.name) && /devserver\.js["'\s]+__keep/i.test(procInfo(parent.pid).cmd || '')) return true;
    cur = parent;
  }
  return false;
}
function sameProc(rec) {
  if (!rec || !alive(rec.pid)) return false;
  const i = procInfo(rec.pid);
  return !i.created || Math.abs(i.created - rec.startedAt) < 15000;
}
function killTree(pid) {
  invalidate();
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
// 不进运行的（审核第五节、Codex C15，用户 2026-10-30 定的）：文档、需求文档、测试代码、服务自己写出来的日志和库文件。改了这些不用重启
const NOT_RUN = /(^|\/)(openspec|docs?|src\/test|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.(md|markdown|log|mv\.db|trace\.db|lock\.db|lck|pid|tmp|swp|orig|rej|bak)$|(^|\/)(README|CHANGELOG|LICENSE|NOTICE)[^/]*$/i;
const runFile = (f) => !!f && !f.split('/').some((x) => SKIP.has(x)) && !NOT_RUN.test(f);
const gitText = (root) => (args, input) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false'].concat(args), { encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20000 });
/** git 看得到的改动（含没跟踪的），只留会进运行的；改名两头都算 */
function dirtyRunFiles(git, rel) {
  const out = new Set();
  for (const line of git(['status', '--porcelain', '-uall', '--', rel || '.']).split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const part of line.slice(3).split(' -> ')) { const p = part.replace(/^"|"$/g, ''); if (runFile(p)) out.add(p); }
  }
  return [...out];
}
/** 工作区里这些文件现在的内容（git 的 blob 哈希，换行按 git 的规则转过）；不在了的是 '' */
function blobsNow(root, git, files) {
  const out = {};
  const there = files.filter((p) => { try { return fs.statSync(path.join(root, p)).isFile(); } catch (e) { return false; } });
  for (const p of files) out[p] = '';
  if (there.length) { const h = git(['hash-object', '--stdin-paths'], there.join('\n') + '\n').trim().split(/\r?\n/); there.forEach((p, i) => { out[p] = h[i] || ''; }); }
  return out;
}
/** 某次提交里这些文件的内容（blob 哈希）；那时还没有的是 '' */
function blobsAt(git, rev, files) {
  const out = {};
  for (const p of files) out[p] = '';
  if (!rev) return out;
  for (let i = 0; i < files.length; i += 100) {
    for (const line of git(['ls-tree', '-r', rev, '--'].concat(files.slice(i, i + 100))).split(/\r?\n/)) { const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line); if (m) out[m[2].replace(/^"|"$/g, '')] = m[1]; }
  }
  return out;
}
/**
 * 起服务时的代码快照：运行目录所在仓库的 HEAD，和当时改着的会进运行的文件的内容。之后按内容比（C1）：只是提交了、改了又改回去不算；
 * 删掉、改名算。不在 git 里（或者被壳子忽略）的返回 null，照旧按修改时间看
 */
function codeSnap(where) {
  const base = path.resolve(where || dir);
  const root = gitRootOf(base);
  if (!root) return null;
  try {
    const rel = path.relative(root, base).split(path.sep).join('/');
    if (rel) { try { execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return null; } catch (e) { /* 没被忽略 */ } }
    const git = gitText(root);
    let head = ''; try { head = git(['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch (e) { head = ''; }
    const files = blobsNow(root, git, dirtyRunFiles(git, rel));
    return { root, rel, head, files };
  } catch (e) { return null; }
}
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
function changedSince(t, where, snap) {
  const base = path.resolve(where || dir);
  const changed = [];
  // 起服务时记了快照的：按内容比（C1）
  if (snap && snap.root && snap.files) {
    try {
      const git = gitText(snap.root);
      const cand = new Set(Object.keys(snap.files).concat(dirtyRunFiles(git, snap.rel)));
      let head = ''; try { head = git(['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch (e) { head = ''; }
      if (snap.head && head && head !== snap.head) for (const p of git(['diff', '--name-only', '--no-renames', snap.head, head, '--', snap.rel || '.']).split(/\r?\n/)) if (runFile(p.trim())) cand.add(p.trim());
      const list = [...cand];
      const now = blobsNow(snap.root, git, list);
      const then = blobsAt(git, snap.head, list.filter((p) => !(p in snap.files)));
      for (const p of list) if ((p in snap.files ? snap.files[p] : then[p]) !== now[p]) changed.push(p);
      return changed.slice(0, 20);
    } catch (e) { /* 比不了就按修改时间 */ }
  }
  const root = gitRootOf(base);
  const gitOut = (args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false'].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000 });
  if (root) {
    try {
      const rel = path.relative(root, base).split(path.sep).join('/');
      let ignored = false;
      if (rel) { try { execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); ignored = true; } catch (e) { ignored = false; } }
      if (!ignored) {
        for (const line of gitOut(['status', '--porcelain', '-uall', '--', rel || '.']).split(/\r?\n/)) {
          const f = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
          if (!runFile(f)) continue;
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
      const relf = path.relative(base, path.join(d, e.name)).split(path.sep).join('/');
      if (!runFile(relf)) continue;
      try { if (fs.statSync(path.join(d, e.name)).mtimeMs > t) changed.push(relf); } catch (err) { /* 刚被删 */ }
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
/** 项目的源文件编码：项目说明（.vibe/project.md，后台自动探索写的）里"- 编码："那一行，往上找到壳子为止；没写的按 UTF-8 */
function projectEncoding(from) {
  for (let d = path.resolve(from), i = 0; i < 4; i++) {
    let t = '';
    try { t = fs.readFileSync(path.join(d, '.vibe', 'project.md'), 'utf8'); } catch (e) { t = ''; }
    const m = /^-\s*编码[：:]\s*(.+)$/m.exec(t);
    if (m) {
      const v = m[1].trim();
      if (/^UTF-?8/i.test(v)) return 'UTF-8';
      if (/^GB18030/i.test(v)) return 'GB18030';
      if (/^(GBK|GB2312)|不是 UTF-8 的居多/i.test(v)) return 'GBK';
      return 'UTF-8';
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return 'UTF-8';
}
/**
 * Java 进程的编码参数（问题表第 23 条，用户 2026-10-30 定的）：IDEA 起 Tomcat、Spring Boot 时自己带 -Dfile.encoding=<项目编码>，
 * devserver 以前不带，JVM 用系统的编码（英文 Windows 是 Windows-1252，中文是 GBK）：Tomcat 的 default servlet 按 file.encoding 读静态文件，
 * 编码过滤器又强制回 UTF-8，静态页面、js 里的中文全乱；JSP 没写 pageEncoding 的也一样。日志（System.out）统一按 UTF-8 写，
 * devserver 按 UTF-8 读。走 JAVA_TOOL_OPTIONS：mvn、gradle、catalina、java 起的 JVM 都认；命令里、JAVA_OPTS、CATALINA_OPTS 这些已经写了的那一项不加。
 * 前端（node、npm 这类）不加
 */
function javaEncodingOpts(command, env, projectDir) {
  if (/^\s*"?(?:[^"\s]*[\\/])?(node|npm|npx|pnpm|yarn|bun|deno|vite|python|py)(\.exe|\.cmd)?"?(\s|$)/i.test(command)) return '';
  const given = [command, env.JAVA_TOOL_OPTIONS, env.JDK_JAVA_OPTIONS, env._JAVA_OPTIONS, env.JAVA_OPTS, env.CATALINA_OPTS, env.MAVEN_OPTS, env.GRADLE_OPTS].filter(Boolean).join(' ');
  const out = [];
  if (!/-Dfile\.encoding=/.test(given)) out.push('-Dfile.encoding=' + projectEncoding(projectDir));
  for (const p of ['stdout.encoding', 'stderr.encoding', 'sun.stdout.encoding', 'sun.stderr.encoding']) if (!new RegExp('-D' + p.replace(/\./g, '\\.') + '=').test(given)) out.push('-D' + p + '=UTF-8');
  return out.join(' ');
}
async function launch(name, port, command, meta) {
  fs.mkdirSync(runDir, { recursive: true });
  const log = logFile(name);
  // 端口交给服务：Spring Boot 认 SERVER_PORT，Vue CLI、Next、CRA 认 PORT。--env 里写的优先
  const env = Object.assign({}, process.env, { PORT: String(port), SERVER_PORT: String(port), VIBE_PORT: String(port) });
  let backendUrl = '';
  if (opt('backend')) { const backend = readRec(opt('backend')); if (!backend || !sameProc(backend) || !(await portOpen(backend.port, 300))) throw new Error('指定后端没有有效运行记录，请先用 devserver 起后端'); backendUrl = 'http://127.0.0.1:' + backend.port; Object.assign(env, { VIBE_BACKEND_URL: backendUrl, VITE_BACKEND_URL: backendUrl, BACKEND_URL: backendUrl }); }
  for (const kv of envs) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  const cwd = path.resolve(dir, opt('cwd') || '.');
  // 运行目录不在：以前 spawn 不报错、进程号是空的，之后崩成"spawn node.exe ENOENT"，看着像找不到 node，记录还留下了（审核 P31）
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { console.log('没起来：运行目录不在：' + cwd + '。--cwd 写项目里的子目录（相对 --dir 或当前目录），写对了再 start。'); return 1; }
  const javaOpts = javaEncodingOpts(command, env, cwd);
  if (javaOpts) { env.JAVA_TOOL_OPTIONS = (env.JAVA_TOOL_OPTIONS ? env.JAVA_TOOL_OPTIONS + ' ' : '') + javaOpts; console.log('Java 的编码：' + javaOpts + '（照项目说明里的编码；命令里、JAVA_OPTS 里自己写了的那一项不加）'); }
  if (opt('backend')) {
    const front = require('../lib/onboard').frontendFacts(cwd, new Set());
    if (front && front.fixedProxyFiles && front.fixedProxyFiles.length) console.error('提醒：前端代理有写死的 target，--backend 只传环境变量。先核对代理是否读取 VIBE_BACKEND_URL（有上下文路径的要保留路径），再验证请求确实到达自测后端；统一认证/CORS 的固定端口另记进项目说明。');
  }
  const snap = codeSnap(cwd);
  const fd = fs.openSync(log, 'w');
  const child = WIN
    ? spawn(process.execPath, [__filename, '__keep'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd, env: Object.assign({}, env, { VIBE_DEVSERVER_CMD: command }) })
    : spawn(command, { shell: true, detached: true, stdio: ['ignore', fd, fd], cwd, env });
  child.unref();
  fs.closeSync(fd);
  invalidate();
  const rec = { name, pid: child.pid, port, cmd: command, cwd, startedAt: Date.now(), hot: flag('hot') || hotOf(command, cwd), log, auto: !!(meta && meta.auto), avoid: (meta && meta.avoid) || [], backendUrl, snap, retriedOnline: !!(meta && meta.retriedOnline) };
  fs.writeFileSync(recFile(name), JSON.stringify(rec, null, 2));
  register(rec, recFile(name));
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
/** 现在是谁在听这个端口：'java（PID 19228）' */
function whoListens(port) {
  const l = listeners(port).map(procInfo).filter((i) => i.pid);
  return l.length ? l.map((i) => (i.name || '进程').replace(/\.exe$/i, '') + '（PID ' + i.pid + '）').join('、') : '';
}
// 日志里认得的"起好了""起不来"（用户 2026-10-28 定的：起服务定时看日志，不要一上来就一直调接口探）。只认常见框架的原话，认不出的照旧靠端口和 HTTP
const LOG_UP = /Started \S+ in [\d.]+ seconds|Tomcat started on port|Server startup in|Starting ProtocolHandler \[|Started ServerConnector|Jetty[^\n]*Started|Netty started on port|Undertow started|ready in [\d.]+ ?m?s|Local:\s+https?:\/\/|App running at|Compiled successfully|webpack compiled|Uvicorn running on|Running on https?:\/\/|Listening on port|listening on port|Started @\d+ms/i;
// Maven 离线（-o）缺依赖：在私服上才有的父 pom、内部依赖、插件（C5：devserver 去掉 -o 再起一次）
// Java 系的服务（mvn、gradle、Tomcat、java -jar）同时听 IPv4、IPv6，只探 127.0.0.1 就够；Node 的常只听 ::1，两个都探（C4）
const JAVA_CMD = /(?:^|[\\/\s"])(?:mvnw?|gradlew?|catalina|startup|java|javaw|tomcat\d*)(?:\.cmd|\.bat|\.sh|\.exe)?(?=[\s"]|$)/i;
const OFFLINE_MISS = /in offline mode|offline mode and the artifact|Cannot access \S+ in offline mode/i;
const LOG_FAIL = /APPLICATION FAILED TO START|BUILD FAILURE|Address already in use|BindException|Port \d+ (?:was )?already in use|EADDRINUSE|npm ERR!|ERR_PNPM|Exception in thread "main"|Error: Cannot find module|Could not find or load main class|Failed to start component|Context initialization failed|Application run failed/i;
/** 日志从 from 字节往后的新内容（最多 1 MB）。cmd、bat 的报错是 GBK：这里只认英文的标志，按 UTF-8 读就够 */
function logSince(file, from) {
  try {
    const size = fs.statSync(file).size;
    if (size <= from) return { text: '', end: size < from ? 0 : from };
    const start = Math.max(from, size - 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); return { text: buf.toString('utf8'), end: size }; } finally { fs.closeSync(fd); }
  } catch (e) { return { text: '', end: from }; }
}
const LOG_EVERY = 2000;     // 多久看一次日志、连一次端口（只连不发请求）
const FIRST_HTTP_MS = 3000; // 日志里认不出"起好了"时，端口通了多久发第一次 HTTP
const HTTP_EVERY = 10000;   // 之后多久发一次
/**
 * 等它起来。0 = 起来了；1 = 没起来：进程退了、日志里报了起不来就删掉记录，等到超时进程还在就留着记录（多半还在启动，再 start 会接着等）。
 * 每 2 秒：读日志新增的内容、连一次端口。日志说起好了 → 发 HTTP 确认（答了就算起来）；日志报了起不来 → 停掉自己起的进程、贴日志返回；
 * 都认不出 → 端口通了 3 秒发第一次 HTTP、之后每 10 秒一次，60 秒一直不答也算起来（不是网页服务）
 */
async function waitUp(rec, waitSec) {
  const t0 = Date.now();
  let deadAt = 0, offset = 0, carry = '', sign = '', fail = '', openAt = 0, lastHttp = 0, signAt = 0;
  const done = async (up, how) => {
    // 记下它起的每个进程：停的时候一个个清掉。听端口的进程单独说：看进程列表时认的是它，不是看管进程
    const table = procTable();
    const tree = descendants(rec.pid, table).map((p) => ({ pid: p.pid, name: p.name, created: p.created }));
    for (const pid of listeners(rec.port)) { const p = table.find((x) => x.pid === pid); if (p && !tree.some((x) => x.pid === pid) && belongs(procInfo(pid), rec, true)) tree.push({ pid: p.pid, name: p.name, created: p.created }); }
    try { fs.writeFileSync(recFile(rec.name), JSON.stringify(Object.assign({}, rec, { tree, upAt: Date.now() }), null, 2)); } catch (e) { /* 记不了就按父子关系停 */ }
    const who = whoListens(rec.port);
    // 耗时异常自动发现、上报（问题表第 20 条，C7）：这次调用起的才算；接着等上一次没起完的不算
    if (rec.startedAt >= T0) { try { const line = require('../lib/perf').noteStart({ kind: RESTART ? 'restart' : 'first', root: rec.cwd, command: rec.cmd, prepMs: rec.startedAt - T0, startMs: Date.now() - rec.startedAt, log: (() => { try { const b = fs.readFileSync(rec.log); return b.slice(Math.max(0, b.length - 2000000)).toString('utf8'); } catch (e) { return ''; } })() }); if (line) console.log(line); } catch (e) { /* 记不了不影响起服务 */ } }
    // 这一行放在最后：输出的最后一行就是结果
    console.log('测完停掉用：node "' + __filename + '" stop --name ' + rec.name + (opt('dir') ? ' --dir "' + dir + '"' : ''));
    console.log('起来了：' + rec.name + '，端口 ' + rec.port + (rec.auto ? '（自动挑的' + (rec.avoid && rec.avoid.length ? '，避开了项目配置的 ' + rec.avoid.join('、') : '') + '，看页面、调接口都用它）' : '') + '，用了 ' + Math.round((Date.now() - rec.startedAt) / 1000) + ' 秒' + (up === 'port' ? NO_HTTP_NOTE : '') + (how ? '，' + how : '') + (rec.hot ? '。会热更新：改了代码不用重启，再 start 直接用' : '') + (who ? '。听这个端口的是 ' + who : '') + '。日志 ' + path.relative(process.cwd(), rec.log));
    return 0;
  };
  let lastProbe = 0, lastOpen = false;
  while (Date.now() - t0 < waitSec * 1000) {
    const got = logSince(rec.log, offset);
    if (got.end < offset) carry = '';
    offset = got.end;
    if (got.text) {
      const lines = (carry + got.text).split(/\r?\n/); carry = lines.pop().slice(-2000);
      for (const l of lines) { if (!sign && LOG_UP.test(l)) { sign = l.trim().slice(0, 160); signAt = Date.now(); } if (!fail && LOG_FAIL.test(l)) fail = l.trim().slice(0, 200); }
    }
    if (fail) {
      // 日志里报了起不来：给它 3 秒自己退，还在就停掉自己起的进程（不留半死的服务占着端口）。
      // 看管进程退了、它起的进程还在的（孙进程），一个个停（审核 P31：以前不记就删了记录，孙进程留下来）
      const kids = descendants(rec.pid, procTable(true));
      for (let i = 0; i < 6 && alive(rec.pid); i++) await sleep(500);
      if (alive(rec.pid)) killTree(rec.pid);
      for (const k of kids) if (alive(k.pid) && k.pid !== routerPid() && k.pid !== process.pid) killTree(k.pid);
      dropRec(rec.name);
      // 离线（-o）缺依赖：去掉 -o 再起一次（C5，用户 2026-10-30 定的）
      const offline = /(?:^|\s)(?:-o|--offline)(?=\s|$)/.test(rec.cmd) && OFFLINE_MISS.test(logTail(rec.log));
      if (offline && !rec.retriedOnline) {
        const cmd2 = rec.cmd.replace(/(^|\s)(?:-o|--offline)(?=\s|$)/, '$1').replace(/\s{2,}/g, ' ').trim();
        console.log('离线（-o）起不来：父 pom 或内部依赖只在私服上（日志里 "' + fail + '"）。去掉 -o 再起一次：' + cmd2);
        return launch(rec.name, rec.port, cmd2, { auto: rec.auto, avoid: rec.avoid, retriedOnline: true });
      }
      console.log('日志最后几段（' + rec.log + '）：\n' + logTail(rec.log).split(/\r?\n/).slice(-30).join('\n'));
      console.log('没起来：日志里报了 "' + fail + '"，用了 ' + Math.round((Date.now() - rec.startedAt) / 1000) + ' 秒。看上面的日志改好再 start；进程已经停了。');
      return 1;
    }
    // 端口每 2 秒连一次（只连不发请求，用户 2026-10-28 定的）；日志刚说起好了的，马上连一次（C4：以前要等到下一轮，最多晚 2 秒）
    const probeNow = Date.now() - lastProbe >= LOG_EVERY || (sign && !lastOpen);
    const open = probeNow ? await portOpen(rec.port, 400, JAVA_CMD.test(rec.cmd) ? ['127.0.0.1'] : null) : lastOpen;
    if (probeNow) { lastProbe = Date.now(); lastOpen = open; }
    if (open && !openAt) openAt = Date.now();
    // 日志说起好了就发 HTTP 确认；日志里认不出标志的（别的框架），端口通了 3 秒发第一次，之后每 10 秒一次
    if (open && (sign || (lastHttp ? Date.now() - lastHttp >= HTTP_EVERY : Date.now() - openAt >= FIRST_HTTP_MS))) {
      lastHttp = Date.now();
      if (await httpAnswers(rec.port)) return done('http', sign ? '日志里看到 "' + sign + '"' : '');
      if (Date.now() - openAt > NO_HTTP_MS) return done('port', sign ? '日志里看到 "' + sign + '"' : '');
    }
    // 日志说起好了，端口却一直不通：监听的多半不是这个端口，不干等到超时
    if (sign && !open && Date.now() - signAt > 15000) {
      console.log('日志最后几段（' + rec.log + '）：\n' + logTail(rec.log).split(/\r?\n/).slice(-30).join('\n'));
      console.log('没起来：日志里说起好了（"' + sign + '"），但 15 秒了端口 ' + rec.port + ' 还没通：它实际监听的多半不是这个端口，看上面的日志找它的端口，--port 写那个再 start。进程还在、记录留着。');
      return 1;
    }
    // 启动命令自己退了（startup.bat 这类把服务甩到后台就走）：服务可能还在起，再等它 15 秒；端口已经通了的是在部署，接着等到超时
    if (!alive(rec.pid) && !openAt) { if (!deadAt) deadAt = Date.now(); if (Date.now() - deadAt > 15000) break; }
    await sleep(500);
  }
  const dead = !alive(rec.pid);
  // 超时这一刻再连一次端口：等得短（--wait 2）时 2 秒一次的检查可能还没赶上端口通
  const open = await portOpen(rec.port, 400);
  if (dead && open) {
    // 启动命令退了、端口通着（startup.bat 甩到后台的 Tomcat）：记下听端口的、这段时间起的进程，记录留着，stop 停得掉（审核 P31）
    const t = procTable(true);
    const tree = listeners(rec.port).map((pid) => t.find((x) => x.pid === pid)).filter((p) => p && belongs(procInfo(p.pid), rec, true)).map((p) => ({ pid: p.pid, name: p.name, created: p.created }));
    try { fs.writeFileSync(recFile(rec.name), JSON.stringify(Object.assign({}, rec, { tree }), null, 2)); } catch (e) { /* 记不了就算了 */ }
  } else if (dead) dropRec(rec.name);
  console.log('日志最后几段（' + rec.log + '）：\n' + logTail(rec.log).split(/\r?\n/).slice(-30).join('\n'));
  if (open) console.log(noHttpYet(rec.port, waitSec) + (dead ? '启动命令已经退出了，看上面的日志有没有报错。' : '进程还在、记录留着：过一会儿再 start 一次会接着等它，不会重起；也看看上面的日志有没有报错。'));
  else console.log(dead ? '没起来：' + rec.name + ' 的进程已经退出了，看上面的日志。' : '没起来：' + waitSec + ' 秒内端口 ' + rec.port + ' 还没通。进程还在、记录留着：多半还在启动（大项目要一两分钟），过一会儿再 start 一次会接着等它，不会重起；也可能它实际监听的不是这个端口，看上面的日志。');
  return 1;
}

async function start() {
  // 不再用 IDEA 起（用户 2026-10-28 定的）：老习惯写了 --idea 的照 -- 后面的命令起
  if (opt('idea')) console.log('不再用 IDEA 的运行配置起服务（--idea 不认了），照 -- 后面的命令起。');
  const name = opt('name') || 'app';
  const portArg = String(opt('port') || '').trim().toLowerCase();
  const auto = portArg === 'auto';
  let port = Number(portArg);
  if (!auto && !(port > 0 && port < 65536)) { console.log('要写 --port auto（在 30000 到 39999 里挑一个空着的，离 --avoid 给的端口远）或者 --port <端口>。'); return 2; }
  if (!cmdArgs.length) { console.log('要在 -- 后面写启动命令，比如：node devserver.js start --name backend --port auto --avoid 8080 -- mvn spring-boot:run'); return 2; }
  const avoid = String(opt('avoid') || '').split(/[,，\s]+/).map(Number).filter((n) => n > 0 && n < 65536);
  const cwd = path.resolve(dir, opt('cwd') || '.');
  // 命令里的 {port} 换成这次用的端口
  const cmdFor = (p) => (cmdArgs.length === 1 ? cmdArgs[0] : cmdArgs.map(quote).join(' ')).split('{port}').join(String(p)).split('{PORT}').join(String(p));
  let rec = readRec(name);
  // 同名记录没找到：看全机登记里有没有之前起的这个服务（换了目录、换了名字的），有就接着用它（第 17 条）
  if (!rec) { const hit = findOurs(name, cwd, auto ? 0 : port, cmdFor); if (hit) rec = adopt(hit, name); }
  if (auto) {
    // 记着的服务：还用那个端口，同一个服务每次都是同一个端口（场景文件里写的地址不用改）
    port = rec && rec.port > 0 && !avoid.some((a) => Math.abs(a - rec.port) < AUTO_GAP) ? rec.port : await pickPort(name, avoid, rec, cwd);
    if (!port) { console.log('没起来：30000 到 39999 里挑不出空着的端口。'); return 1; }
  }
  // -- 后面只有一个参数（整条命令加了引号）：原样用，不再包一层引号
  const command = cmdFor(port);
  // 同一个服务：命令、端口、运行目录都一样（同名同端口换了个子项目，不能拿另一个子项目的服务来用）
  const same = (r) => r.cmd === command && r.port === port && normPath(r.cwd || dir) === normPath(cwd);
  const recUp = rec ? await portOpen(rec.port, 500) : false;
  const recLive = rec ? sameProc(rec) : false;
  // 进程还在、端口没通：多半还在启动。同一个服务就接着等，不结束重来（大项目起得慢，结束重来可能永远起不来）。
  // 端口通了、记录里却没有 upAt 的：上一次 start 没等到它答 HTTP（等超时了、被打断了），也接着等
  if (rec && recLive && (!recUp || (!rec.upAt && !flag('restart'))) && same(rec)) { console.log(name + ' 还在启动（进程 ' + rec.pid + '，' + ago(rec.startedAt) + '起的' + (recUp ? '，端口通了，上次没等到它答 HTTP' : '') + '），接着等它。'); return waitUp(rec, Number(opt('wait')) || 180); }
  if (rec && recLive && !recUp) {
    console.log(name + ' 还在启动，但这次的启动命令、端口或运行目录变了：停掉，重来。');
    killTree(rec.pid);
    dropRec(rec.name);
  } else if (rec && recUp && recLive) {
    const hot = hotRec(rec);
    const changed = flag('restart') ? ['（要求重启）'] : hot ? [] : changedSince(rec.startedAt, rec.cwd, rec.snap);
    if (!changed.length && same(rec)) {
      const who = whoListens(rec.port);
      console.log('已经在跑：' + name + '（端口 ' + rec.port + '，' + ago(rec.startedAt) + '起的' + (who ? '，听这个端口的是 ' + who : '') + '）' + (hot ? '，会热更新，改了代码不用重启' : '，启动之后代码没改过') + '。直接用，不用再起。要强制重启加 --restart。');
      return 0;
    }
    console.log(name + ' 在跑（端口 ' + rec.port + '，' + ago(rec.startedAt) + '起的），' + (!same(rec) ? '启动命令、端口或运行目录变了' : '但它跑的不是现在的代码（之后改过：' + changed.slice(0, 5).join('、') + (changed.length > 5 ? ' 等 ' + changed.length + ' 个' : '') + '）') + '：停掉，在同一个端口重启。');
    RESTART = true;
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
    const t0 = procTable();
    // 登记里这个端口是别的项目的服务：不动（Claude 在别处起的，不是这个项目的）
    const foreign = liveReg((e) => e.port === port && !sameArea(e.cwd, cwd))[0];
    if (foreign) { console.log('端口 ' + port + ' 上是 Claude 在别的项目（' + foreign.cwd + '）用 devserver 起的 ' + foreign.name + '（' + ago(foreign.startedAt) + '起的），没有动它。换个端口（--port auto 会挑别的），或者去那个目录 stop。'); return 1; }
    // 命令行里有这个项目的目录，或者往上找得到 devserver 的看管进程（Claude 起的，第 17 条：以前 vite 这类命令行里没有项目路径，被当成用户起的）
    const ours = (i) => belongs(i, null) || byKeeper(i, t0);
    const mine = infos.filter(ours);
    const others = infos.filter((i) => !ours(i));
    if (!pids.length || others.length) {
      const who = others.length ? others.map((i) => (i.name || '进程') + '（PID ' + i.pid + (i.pid === routerPid() ? '，这是模型路由' : '') + '）' + (i.cmd ? '：' + i.cmd.slice(0, 200) : '')).join('；') : '查不到是哪个进程';
      console.log('端口 ' + port + ' 被占着：' + who + '。无法确认它归这个项目（' + dir + '）管，没有动它。可能是用户在 IDEA 或终端里启动的服务；先核实来源和用途，不要直接结束它。');
      return 1;
    }
    // 这个项目的进程，但没有记录：看是谁起的。Claude Code 起的、没人管的（起它的进程已经不在了）停掉重起；
    // 用户自己在终端、IDE 里起的（带着调试器的也算）不动，除非加了 --takeover（先问过用户）
    const who = mine.map((i) => ({ i, by: byKeeper(i, t0) ? 'keeper' : whoStarted(i, t0) }));
    // 起它的程序不在了（orphan）的，要有 devserver 起过它的痕迹（全机登记里这一处、这个端口）才停（审核 P29）：
    // 用户双击 startup.bat 起的 Tomcat，bat 退了以后也找不到父进程，以前被当成"没人管的"直接停掉
    const traced = Object.values(readReg()).some((e) => e && e.port === port && sameArea(e.cwd, cwd));
    const users = who.filter((x) => x.by === 'user' || (x.by === 'orphan' && !traced));
    if (users.length && !flag('takeover')) {
      console.log('端口 ' + port + ' 上是用户自己起的这个项目的服务：' + users.map((x) => (x.i.name || '进程') + '（PID ' + x.i.pid + (x.i.created ? '，' + ago(x.i.created) + '起的' : '') + '）' + (x.i.cmd ? '：' + x.i.cmd.slice(0, 160) : '')).join('；') + '。没有动它。\n'
        + '要用就直接拿它测（它跑的可能不是你改过之后的代码：改的是后端的话，先问用户要不要重启它）。确实要由 devserver 接管（结束它、在同一个端口重起），先问用户，同意了再加 --takeover 重跑。全自动模式下用户不在：不要接管，把要重启才能验的那一步留给用户。');
      return 1;
    }
    console.log('端口 ' + port + ' 被这个项目的进程占着（' + who.map((x) => (x.i.name || '进程') + ' PID ' + x.i.pid + (x.i.created ? '，' + ago(x.i.created) + '起的' : '') + '，' + (x.by === 'keeper' ? 'Claude 用 devserver 起的，记录丢了' : x.by === 'claude' ? 'Claude Code 起的' : x.by === 'orphan' ? '起它的程序已经不在了' : '用户起的，按 --takeover 接管')).join('；') + '）：先停掉，再在这个端口起。');
    for (const x of who) killTree(x.i.pid);
    if (!(await waitClosed(port, 8000))) { console.log('停不掉占着端口 ' + port + ' 的进程，没有起新的。'); return 1; }
  }
  return launch(name, port, command, { auto, avoid });
}

/** 老版本用 IDEA 起、记成 mode: idea 的：套件不再管 IDEA 里的服务，不动进程，记录清掉 */
const ideaGone = (r) => r.name + '：以前用 IDEA 的运行配置"' + (r.config || r.name) + '"起的（端口 ' + r.port + '），套件不再管 IDEA 里的服务，没有动它，记录清掉了。要停到 IDEA 里停；要套件管就停掉它再用 start 照命令起。';

/** 全机登记里、这个目录这一处的（运行目录在它下面，或者同一个 git 仓库）、记录不在这个目录里的：挪过来（第 17 条：换个目录跑 stop、status 也认得） */
function adoptArea(nameOnly) {
  const here = new Set(allRecs().map((r) => r.name));
  for (const e of liveReg((x) => sameArea(x.cwd, dir) && normPath(path.dirname(x.file)) !== normPath(runDir) && (!nameOnly || x.name === nameOnly))) {
    if (here.has(e.name)) continue;
    adopt(e, e.name, '（记录在 ' + path.dirname(e.file) + '）');
    here.add(e.name);
  }
}
async function stop() {
  try { adoptArea(flag('all') || !opt('name') ? '' : opt('name')); } catch (e) { /* 认不了照旧只看这个目录 */ }
  const recs = flag('all') || !opt('name') ? allRecs() : [readRec(opt('name'))].filter(Boolean);
  if (!recs.length) { console.log(opt('name') ? '没有叫 ' + opt('name') + ' 的服务记录（' + runDir + '）' : '这个项目没有记着在跑的服务（' + runDir + '）'); return 0; }
  let bad = 0;
  for (const r of recs) {
    if (r.mode === 'idea') { dropRec(r.name); console.log(ideaGone(r)); continue; }
    const s = await stopRec(r);
    const n = s.killed.filter((k) => k.name !== '看管进程').map((k) => String(k.name || '进程').replace(/\.exe$/i, '') + (k.pid ? ' ' + k.pid : ''));
    if (s.free) console.log((s.killed.length ? '停了：' : '本来就没在跑，记录清掉了：') + r.name + '，端口 ' + r.port + ' 空出来了' + (n.length ? '（结束了 ' + n.slice(0, 6).join('、') + '）' : '') + '。');
    else { bad++; console.log('没停干净：' + r.name + '，端口 ' + r.port + ' 还被占着：' + (s.left.map((i) => (i.name || '进程') + '（PID ' + i.pid + '）' + (i.cmd ? ' ' + i.cmd.slice(0, 120) : '')).join('；') || '查不到是哪个进程') + '。无法确认归属，没有动它；先弄清它是谁，不要直接结束它。'); }
  }
  return bad ? 1 : 0;
}

async function status() {
  try { adoptArea(''); } catch (e) { /* 认不了照旧只看这个目录 */ }
  const recs = allRecs();
  if (!recs.length) { console.log('这个项目没有记着的服务（' + runDir + '）。'); return 0; }
  for (const r of recs) {
    if (r.mode === 'idea') { dropRec(r.name); console.log(ideaGone(r)); continue; }
    const alive_ = sameProc(r);
    const open = alive_ && (await portOpen(r.port, 500));
    // 只报告，不结束任何进程：进程在、端口没通的是还在启动
    if (!alive_) { console.log(r.name + '：没在跑（进程已经退了），记录清掉了。\n  命令：' + r.cmd + '\n  日志：' + r.log); dropRec(r.name); continue; }
    if (!open) { console.log(r.name + '：还在启动（进程 ' + r.pid + ' 在，端口 ' + r.port + ' 还没通，' + ago(r.startedAt) + '起的）。等一会儿；start 一次会接着等它。\n  命令：' + r.cmd + '\n  日志：' + r.log); continue; }
    const changed = !hotRec(r) ? changedSince(r.startedAt, r.cwd, r.snap) : [];
    const who = whoListens(r.port);
    console.log(r.name + '：在跑，端口 ' + r.port + (r.auto ? '（自动挑的）' : '') + (who ? '，听这个端口的是 ' + who : '') + '，' + ago(r.startedAt) + '起的' + (hotRec(r) ? '，会热更新，改了代码不用重启' : changed.length ? '，之后代码改过（' + changed.slice(0, 3).join('、') + (changed.length > 3 ? ' 等' : '') + '），测之前要 start 一下（会自动重启）' : '，跑的是现在的代码') + '\n  命令：' + r.cmd + '\n  运行目录：' + (r.cwd || dir) + '\n  日志：' + r.log);
  }
  return 0;
}

module.exports = { changedSince, codeSnap, belongs, whoStarted, listeners, procInfo, sameProc, procTable, descendants, hotOf };
if (require.main === module && sub === '__keep') keep();
else if (require.main === module) {
  const f = { start, stop, status }[sub];
  if (!f) { console.log('用法：node devserver.js start|stop|status …（见文件开头的说明）'); process.exit(2); }
  f().then((code) => process.exit(code || 0), (e) => { console.log('出错了：' + ((e && e.stack) || e)); process.exit(1); });
}
