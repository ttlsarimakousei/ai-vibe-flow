'use strict';
/*
 * 自动更新：内网 GitLab 的仓库里放着解开的安装包，这台电脑用 git 拉下来，跑里面的 install.js。
 *
 *   钩子（会话开始、用户开口、收工）到时间了就调 kick()：只看一眼状态文件，该检查了就甩出一个没有窗口的后台进程，自己马上返回
 *   后台进程（node lib/updater.js run）：
 *     1. 问仓库现在是哪个提交（git ls-remote，零点几秒）；和上次一样就不用拉
 *     2. 不一样：拉到暂存处 ~/.claude/vibe-kit/update/repo（只要最新的那一个提交，之后每次只下载变了的文件）
 *     3. 暂存处的版本和装着的不一样（"跟着仓库走"：仓库退回了旧版，这里也跟着退），而且开关是"自动装"：
 *        等路由空闲（没有正在转发的请求）→ 跑暂存处里的 install.js（和手动双击安装完全一样）→ 自检
 *        自检不过：从仓库拉上一版的标签装回去，这个坏版本记下来不再装，等仓库里出了新的再说
 *     4. 顺带把还没上报的问题反馈建成议题（lib/issues.js）
 *
 * 连仓库走哪条路（手填的令牌、SSH 密钥、这台电脑上 git 登录的身份）由 lib/gitlab.js 挨个试，这里不管。
 *
 * 开关（config.json）：autoUpdate = auto 自动装 / notify 只提醒（状态栏、配置页上说有新版，点了才装）/ off 不检查；updateCheckHours 几小时查一次（默认 2）。
 * 更新源在 lib/gitlab.js（配置页里填，默认是团队的那个仓库）。
 *
 * 为什么放在 lib/ 里：模型只能跑 page/ 和 tools/ 里的脚本（guard-commit），这里的它跑不了——更新等于执行仓库里的代码，不能让模型来触发。
 * 状态在 state/update.json，日志在 update/update.log，安装器的输出在 update/last-install.log。
 *
 * 配置页的几个按钮（测试连接、立即检查、立即更新、申请令牌、导出议题）也是起一个进程跑这个文件：连 GitLab 可能要等十几秒，
 * 不能在路由的进程里等。这些命令往标准输出写一行 JSON，令牌从不写出来。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { KIT, CFG_DIR, readConfig, readState, updateState } = require('./session');
const gl = require('./gitlab');

const DIR = path.join(KIT, 'update');
const STAGE = path.join(DIR, 'repo');
const LOG = path.join(DIR, 'update.log');
const LOCK = path.join(DIR, 'lock.json');
const INSTALL_LOG = path.join(DIR, 'last-install.log');
const VERSION_RE = /^\d{8}\.\d{4}$/;
const LOCK_MS = 40 * 60000;

const modeOf = (cfg) => { const m = (cfg || readConfig()).autoUpdate; return ['auto', 'notify', 'off'].includes(m) ? m : 'auto'; };
const hoursOf = (cfg) => { const n = Number((cfg || readConfig()).updateCheckHours); return n >= 1 && n <= 24 ? n : 2; };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim(); } catch (e) { return ''; } };
const installedVersion = () => readText(path.join(KIT, 'VERSION'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });

function log(line) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { if (fs.statSync(LOG).size > 200 * 1024) fs.renameSync(LOG, LOG + '.1'); } catch (e) { /* 还没有 */ }
    fs.appendFileSync(LOG, stamp() + ' ' + line + '\n');
  } catch (e) { /* 记不了就算了 */ }
}
const setState = (patch) => updateState('update', (o) => Object.assign(o, patch));

// ---------- 同一时间只跑一个 ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
function lockHeld() {
  try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); return !!l && Date.now() - (l.at || 0) < LOCK_MS && pidAlive(l.pid) && l.pid !== process.pid; } catch (e) { return false; }
}
function lock() {
  if (lockHeld()) return false;
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })); return true; } catch (e) { return false; }
}
function unlock() { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l && l.pid === process.pid) fs.unlinkSync(LOCK); } catch (e) { /* 没有锁 */ } }
/** 锁还是自己的吗 */
function ownLock() { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); return !!l && l.pid === process.pid; } catch (e) { return false; } }
/**
 * 续一下锁：一次跑得长（拉仓库几条路各等十分钟、等空闲最多半小时、装、装回上一版）会超过锁的有效期，
 * 别的钩子看锁过期了会再甩一个进程出来，两个一起装。长的步骤前后都续一下
 */
function touchLock() { try { if (ownLock()) fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch (e) { /* 续不了就算了 */ } }

// ---------- 问仓库、拉到暂存处 ----------
/** 仓库现在是哪个提交。没指定分支就用仓库的默认分支。返回 { ok, commit, branch, empty, route, why } */
function remoteHead(s) {
  const p = s.parsed;
  if (!p.ok) return { ok: false, why: p.why };
  const r = gl.viaRoutes(s, (route) => gl.git(null, s.branch ? ['ls-remote', route.url, 'refs/heads/' + s.branch] : ['ls-remote', '--symref', route.url, 'HEAD'], { settings: s, route, timeout: 40000 }));
  if (r.code !== 0) return { ok: false, why: gl.explainRoutes(r, '问仓库有没有新版') };
  let branch = s.branch;
  let commit = '';
  for (const l of r.out.split(/\r?\n/)) {
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(l);
    if (m) { branch = m[1]; continue; }
    const c = /^([0-9a-f]{40})\s+(\S+)$/.exec(l);
    if (c && (c[2] === 'HEAD' || c[2] === 'refs/heads/' + s.branch)) commit = c[1];
  }
  if (!commit) return s.branch ? { ok: false, why: '仓库里没有 ' + s.branch + ' 这个分支' } : { ok: true, empty: true, branch: branch || '', route: r.route };
  return { ok: true, commit, branch: branch || 'main', route: r.route };
}
const stageCommit = () => { const r = gl.git(STAGE, ['rev-parse', 'HEAD'], { timeout: 15000 }); return r.code === 0 ? r.out.trim() : ''; };
/** 暂存处是不是从现在这个仓库拉的（换了仓库地址就重新来） */
const stageHolds = (s) => fs.existsSync(path.join(STAGE, '.git')) && !!gl.repoKey(s) && readState('update').stageKey === gl.repoKey(s);
/** 暂存处里是不是一个完整的安装包；是的话返回它的版本号 */
function stagedVersion(dir) {
  const d = dir || STAGE;
  for (const f of ['install.js', 'settings.fragment.json', 'kit/VERSION', 'kit/lib/session.js', 'kit/hooks/verify-gate.js', 'claude/CLAUDE.md']) if (!fs.existsSync(path.join(d, f))) return '';
  const v = readText(path.join(d, 'kit', 'VERSION'));
  return VERSION_RE.test(v) ? v : '';
}
function stage(s, head, again) {
  fs.mkdirSync(DIR, { recursive: true });
  touchLock();
  let first = false;
  if (!stageHolds(s) || again) {
    try { fs.rmSync(STAGE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { return { ok: false, why: '清不掉旧的暂存处（被别的程序占着）：' + STAGE }; }
    const i = gl.git(DIR, ['init', '-q', STAGE], { timeout: 60000 });
    if (i.code !== 0) return { ok: false, why: gl.explainGit(i, '建暂存处') };
    setState({ stageKey: gl.repoKey(s) });
    first = true;
  }
  // 不登记远端、不记地址：每次把地址直接给 git，走哪条路都一样用
  const f = gl.viaRoutes(s, (route) => gl.git(STAGE, ['fetch', '-q', '--depth', '1', '--no-tags', route.url, head.branch], { settings: s, route, timeout: 600000 }));
  touchLock();
  // 以前拉到一半被结束（超时、关机）的暂存处会留下 .lock 文件，之后每次都失败：整个重建再来一次
  const broken = (r) => /\.lock\b|index\.lock|shallow\.lock|unable to create|File exists|corrupt|bad object|not a git repository/i.test(String(r.err || r.out || '') + ' ' + String(r.why || ''));
  if (f.code !== 0) {
    if (!again && !first && broken(f.last || f)) { log('暂存处坏了（像是上次拉到一半被结束，留下了锁文件），重建再拉一次'); return stage(s, head, true); }
    return { ok: false, why: gl.explainRoutes(f, first ? '第一次拉仓库' : '拉新版') };
  }
  const c = gl.git(STAGE, ['checkout', '-q', '-f', 'FETCH_HEAD'], { timeout: 120000 });
  if (c.code !== 0) {
    if (!again && broken(c)) { log('暂存处切不到新版（' + String(c.err || '').split(/\r?\n/)[0] + '），重建再拉一次'); return stage(s, head, true); }
    return { ok: false, why: gl.explainGit(c, '切到新版') };
  }
  gl.git(STAGE, ['clean', '-q', '-fdx'], { timeout: 120000 });
  return { ok: true, ms: f.ms + c.ms, first, route: f.route };
}
/**
 * 检查一次：问仓库、有变化就拉到暂存处。只下载，不安装。返回现在的情况（也记进 state/update.json）
 */
function check() {
  const s = gl.settings();
  const now = Date.now();
  const fail = (why) => { setState({ lastCheckAt: now, lastCheckOk: false, lastError: why }); log('检查没成功：' + why); return status(); };
  if (!gl.gitVersion()) return fail('这台电脑上找不到 git，自动更新用不了');
  const head = remoteHead(s);
  if (!head.ok) return fail(head.why);
  if (head.empty) return fail('仓库是空的，还没发布过');
  const st = readState('update');
  const have = stageHolds(s) ? stageCommit() : '';
  if (have !== head.commit) {
    const r = stage(s, head);
    if (!r.ok) return fail(r.why);
    log('拉到了 ' + head.branch + ' 的 ' + head.commit.slice(0, 8) + '（' + r.ms + ' ms，走的是' + r.route.label + (r.first ? '，第一次' : '') + '）');
  }
  const v = stagedVersion();
  if (!v) return fail('仓库里的东西不像是 vibe-kit 的安装包（没有 install.js、kit/VERSION 这些）。先用"发布"把包推进去');
  setState({ lastCheckAt: now, lastCheckOk: true, lastError: '', remoteCommit: head.commit, remoteBranch: head.branch, remoteVersion: v, repo: gl.maskUrl(s.repo), route: head.route.name, routeLabel: head.route.label });
  if (v !== st.remoteVersion) log('仓库里现在是 ' + v + '，这台电脑装着 ' + (installedVersion() || '（没有版本号）'));
  return status();
}

// ---------- 空闲 ----------
function routerPort() { try { const svc = path.join(KIT, 'router', 'service.js'); if (!fs.existsSync(svc)) return 0; return Number(require(svc).portOf()) || 0; } catch (e) { return 0; } }
function getJson(url, timeout) {
  return new Promise((resolve) => {
    const r = http.get(url, { timeout: timeout || 3000 }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j }); }); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, json: null }));
  });
}
/** 路由现在闲不闲：没有正在转发的请求，而且最近 quiet 毫秒里没来过请求。路由没在跑、或者是不认得这个问法的老路由，都算闲 */
async function idle(quiet) {
  const port = routerPort();
  if (!port) return true;
  const r = await getJson('http://127.0.0.1:' + port + '/busy');
  if (r.status !== 200 || !r.json) return true;
  return !(Number(r.json.inflight) > 0) && Number(r.json.idleMs) >= (quiet === undefined ? 20000 : quiet);
}
async function waitIdle(maxMs, quiet) {
  const end = Date.now() + (maxMs || 30 * 60000);
  while (Date.now() < end) { touchLock(); if (await idle(quiet)) return true; await sleep(5000); }
  return false;
}

// ---------- 安装、自检、装回上一版 ----------
/**
 * 要装的比装着的旧（维护者把所有人退回旧版、或者装回上一版）：旧版的安装器只认它那时的技能名字，
 * 这一版装的、旧版没有的技能和代理（ttls-*）会留下来，和旧名字并存。装之前记下现在装的原样，装完把没改过的删掉；
 * 这一版收进 retired/ 的旧技能（urai-db-crud、redis），旧版里还是单独装的，挪回去
 */
function snapshotOwn() {
  const snap = path.join(DIR, 'pristine-before');
  try { fs.rmSync(snap, { recursive: true, force: true }); } catch (e) { /* 没有 */ }
  const copy = (src, dst) => { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) { const s = path.join(src, n); const d = path.join(dst, n); const st = fs.statSync(s); if (st.isDirectory()) copy(s, d); else if (st.isFile()) fs.copyFileSync(s, d); } };
  try { for (const d of ['skills', 'agents']) if (fs.existsSync(path.join(KIT, 'pristine', d))) copy(path.join(KIT, 'pristine', d), path.join(snap, d)); return snap; } catch (e) { return ''; }
}
function tidyAfterDowngrade(snap) {
  const out = [];
  if (!snap) return out;
  const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
  const files = (dir, rel, acc) => { for (const n of list(path.join(dir, rel))) { if (n === '__pycache__') continue; const r = rel ? path.join(rel, n) : n; const st = fs.statSync(path.join(dir, r)); if (st.isDirectory()) files(dir, r, acc); else acc.push(r); } return acc; };
  const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; } };
  const sameDir = (a, b) => { try { const x = files(a, '', []).sort(); const y = files(b, '', []).sort(); return x.length === y.length && x.every((f, i) => f === y[i] && sameFile(path.join(a, f), path.join(b, f))); } catch (e) { return false; } };
  const now = new Set(list(path.join(KIT, 'pristine', 'skills')));
  for (const n of list(path.join(snap, 'skills'))) {
    if (now.has(n)) continue;
    const d = path.join(CFG_DIR, 'skills', n);
    if (fs.existsSync(d) && sameDir(d, path.join(snap, 'skills', n))) { try { fs.rmSync(d, { recursive: true, force: true }); out.push('删了技能 ' + n); } catch (e) { out.push('技能 ' + n + ' 删不掉'); } }
  }
  const nowAgents = new Set(list(path.join(KIT, 'pristine', 'agents')));
  for (const n of list(path.join(snap, 'agents'))) {
    if (nowAgents.has(n)) continue;
    const f = path.join(CFG_DIR, 'agents', n);
    if (fs.existsSync(f) && sameFile(f, path.join(snap, 'agents', n))) { try { fs.unlinkSync(f); out.push('删了代理 ' + n); } catch (e) { out.push('代理 ' + n + ' 删不掉'); } }
  }
  // retired/ 里收着的以前单独装的技能：旧版里它们是单独装的，挪回去
  for (const r of list(path.join(KIT, 'retired'))) {
    const m = /^(urai-db-crud|db-crud|redis)-\d{8}-\d{6}$/.exec(r);
    if (!m) continue;
    const d = path.join(CFG_DIR, 'skills', m[1]);
    if (fs.existsSync(d)) continue;
    try { fs.renameSync(path.join(KIT, 'retired', r), d); out.push('挪回了以前单独装的 ' + m[1]); } catch (e) { out.push(m[1] + ' 挪不回去'); }
  }
  try { fs.rmSync(snap, { recursive: true, force: true }); } catch (e) { /* 留着 */ }
  return out;
}
const olderThan = (a, b) => VERSION_RE.test(a) && VERSION_RE.test(b) && a < b;
function runInstaller(dir) {
  const target = stagedVersion(dir);
  const cur = installedVersion();
  const snap = olderThan(target, cur) ? snapshotOwn() : '';
  const r = runInstallerOnly(dir);
  if (snap && r.ok) { const done = tidyAfterDowngrade(snap); if (done.length) log('装回旧版 ' + target + ' 之后收拾：' + done.join('；')); }
  return r;
}
function runInstallerOnly(dir) {
  touchLock();
  let man = {};
  try { man = JSON.parse(fs.readFileSync(path.join(KIT, 'installed.json'), 'utf8')) || {}; } catch (e) { man = {}; }
  const hasRouter = man.router === true || (man.router === undefined && fs.existsSync(path.join(KIT, 'router', 'service.js')));
  const args = [path.join(dir, 'install.js'), '--no-open'].concat(hasRouter ? [] : ['--no-router']);
  const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG_DIR, VIBE_KIT_AUTO_UPDATE: '1' });
  const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 10 * 60000, maxBuffer: 16 * 1024 * 1024 });
  touchLock();
  const out = String(r.stdout || '') + String(r.stderr || '') + (r.error ? '\n' + r.error.message : '');
  try { fs.writeFileSync(INSTALL_LOG, stamp() + ' node ' + args.join(' ') + '\n退出码 ' + r.status + '\n' + out); } catch (e) { /* 记不了就算了 */ }
  return { ok: r.status === 0, out };
}
/**
 * 装完自检：每个钩子、每个库都载得进来；状态栏跑得出一行字。在另一个进程里做，这里的代码是装之前载入的那一份。
 * 注意：跑这份名单的是"装之前的那一版"。以后的版本要是把名单里的某个钩子文件删了，老版本装完会认为新版坏了、退回去，
 * 永远升不上来——要去掉一个钩子，文件得留成一个什么都不做的空壳（hooks/source-hint.js 就是这样），过几版再删
 */
function selfCheck() {
  const script = [
    "const fs = require('fs'); const path = require('path');", 'const kit = ' + JSON.stringify(KIT) + ';',
    "for (const d of ['lib', 'hooks']) for (const f of fs.readdirSync(path.join(kit, d)).sort()) if (/[.]js$/.test(f)) { try { require(path.join(kit, d, f)); } catch (e) { console.log('载不进来：' + d + '/' + f + '：' + (e && e.message)); process.exit(3); } }",
    "for (const h of ['pre-edit', 'guard-commit', 'guard-ask', 'guard-read', 'verify-gate', 'session-start', 'task-anchor']) if (typeof require(path.join(kit, 'hooks', h + '.js')).handle !== 'function') { console.log('钩子 ' + h + ' 没有 handle'); process.exit(3); }",
    "console.log('ok');",
  ].join('\n');
  const a = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (a.status !== 0 || !/ok/.test(String(a.stdout))) return { ok: false, why: (String(a.stdout || '') + String(a.stderr || '')).trim().split(/\r?\n/).slice(0, 3).join('；') || '自检进程没跑完' };
  const b = spawnSync(process.execPath, [path.join(KIT, 'statusline.js')], { input: '{}', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (b.status !== 0 || !String(b.stdout || '').trim()) return { ok: false, why: '状态栏跑不出来：' + String(b.stderr || '').trim().split(/\r?\n/)[0] };
  return { ok: true };
}
function rollback(prev, s) {
  if (!VERSION_RE.test(prev)) return { ok: false, why: '装之前的版本没有版本号，没法从仓库里找回来' };
  const tag = 'refs/tags/v' + prev;
  const f = gl.viaRoutes(s, (route) => gl.git(STAGE, ['fetch', '-q', '--depth', '1', route.url, '+' + tag + ':' + tag], { settings: s, route, timeout: 300000 }));
  if (f.code !== 0) return { ok: false, why: '仓库里找不到上一版（标签 v' + prev + '）：' + gl.explainRoutes(f, '拉上一版') };
  const c = gl.git(STAGE, ['checkout', '-q', '-f', tag], { timeout: 120000 });
  if (c.code !== 0 || stagedVersion() !== prev) return { ok: false, why: '切不到上一版 v' + prev };
  const r = runInstaller(STAGE);
  return r.ok && installedVersion() === prev ? { ok: true } : { ok: false, why: '装回上一版也没成功，看 ' + INSTALL_LOG };
}
const failedTimes = (st, v) => (st.failed && st.failed.version === v ? Number(st.failed.times) || 0 : 0);
/** 要不要装：暂存处是一个完整的包、版本和装着的不一样、而且这个版本没有连着装坏过两次（anyway：在配置页上点的，装坏过也再试） */
function needInstall(anyway) {
  const st = readState('update');
  const v = stagedVersion();
  return !!v && v === st.remoteVersion && v !== installedVersion() && (anyway === true || failedTimes(st, v) < 2);
}
function apply() {
  const s = gl.settings();
  const from = installedVersion();
  const to = stagedVersion();
  if (!to) return { ok: false, why: '暂存处里没有可装的包，先检查一次' };
  if (to === from) return { ok: true, same: true, version: to };
  // 锁已经不是自己的了（等空闲等得太久，别的进程接手了）：不装，免得两个安装器同时拷文件
  if (!ownLock()) return { ok: false, why: '更新的锁被别的进程拿走了，这次不装' };
  touchLock();
  log('开始安装 ' + to + '（现在是 ' + (from || '没有版本号') + '）');
  const r = runInstaller(STAGE);
  let why = '';
  if (!r.ok) why = '安装器没跑完（' + (r.out.split(/\r?\n/).filter((l) => /\[X\]/.test(l))[0] || '看 ' + INSTALL_LOG).trim() + '）';
  else if (installedVersion() !== to) why = '装完版本号不对：是 ' + installedVersion();
  else { const c = selfCheck(); if (!c.ok) why = '装完自检没过：' + c.why; }
  const hist = (readState('update').history || []).slice(-9);
  if (!why) {
    setState({ lastApplied: { at: Date.now(), from, to }, failed: null, history: hist.concat({ at: Date.now(), from, to, ok: true }) });
    log('已更新到 ' + to);
    return { ok: true, version: to, from };
  }
  log('没装成：' + why);
  const st = readState('update');
  const times = failedTimes(st, to) + 1;
  const back = rollback(from, s);
  log(back.ok ? '已装回上一版 ' + from : '没能装回上一版：' + back.why);
  setState({ failed: { version: to, times, why, at: Date.now(), rolledBack: back.ok }, history: hist.concat({ at: Date.now(), from, to, ok: false, why, rolledBack: back.ok }) });
  // 暂存处回到仓库最新的那个提交，下次检查不用重新下载
  try { if (st.remoteCommit) gl.git(STAGE, ['checkout', '-q', '-f', st.remoteCommit], { timeout: 120000 }); } catch (e) { /* 下次检查会重新拉 */ }
  try { require('./feedback.js').record({ kind: '出错', hook: '自动更新', source: '钩子自动记录', title: '自动更新到 ' + to + ' 没装成：' + why.slice(0, 60), what: '从 ' + from + ' 更新到 ' + to + ' 时：' + why + '。' + (back.ok ? '已经装回 ' + from + '。' : '没能装回上一版：' + back.why), stack: readText(INSTALL_LOG).slice(-3000), sig: require('./feedback.js').sigOf(['update', to, why.slice(0, 40)]) }); } catch (e) { /* 记不了就算了 */ }
  return { ok: false, why, rolledBack: back.ok, version: to, from };
}

// ---------- 现在的情况（配置页、状态栏用） ----------
function status() {
  const cfg = readConfig();
  const st = readState('update');
  const installed = installedVersion();
  const remote = st.remoteVersion || '';
  const failed = st.failed && st.failed.version === remote ? st.failed : null;
  return {
    mode: modeOf(cfg), hours: hoursOf(cfg), installed, remote, branch: st.remoteBranch || '', commit: String(st.remoteCommit || '').slice(0, 8), route: st.route || '', routeLabel: st.routeLabel || '',
    differs: !!remote && remote !== installed, behind: !!remote && remote !== installed && !(failed && failed.times >= 2),
    lastCheckAt: st.lastCheckAt || 0, lastCheckOk: st.lastCheckOk !== false, lastError: st.lastError || '', lastApplied: st.lastApplied || null, failed,
    history: (st.history || []).slice(-10).reverse(), running: lockHeld(), log: LOG, maintainer: gl.isMaintainer(),
  };
}

// ---------- 钩子调的：到时间了就甩一个后台进程 ----------
function spawnBackground(args) {
  const env = Object.assign({}, process.env);
  const c = spawn(process.execPath, [__filename].concat(args), { detached: true, windowsHide: true, stdio: 'ignore', env, cwd: KIT });
  c.on('error', () => {});
  c.unref();
  return true;
}
/**
 * 该检查更新了、或者有还没上报的问题：甩一个后台进程去做，自己马上返回。一分钟内不重复甩，已经有一个在跑也不甩。
 * 只读两个小文件，钩子里每次都调也不碍事
 */
function kick(why) {
  try {
    // 临时不想让它在后台检查更新、上报问题（排查问题、跑测试）：环境变量 VIBE_KIT_NO_UPDATE=1
    if (process.env.VIBE_KIT_NO_UPDATE === '1') return false;
    const cfg = readConfig();
    const st = readState('update');
    const now = Date.now();
    const dueUpdate = modeOf(cfg) !== 'off' && now - (st.lastCheckAt || 0) >= hoursOf(cfg) * 3600000;
    // 已经下载好、还没装上的（上次一直没等到空闲）：十分钟后再试一次
    const dueApply = modeOf(cfg) === 'auto' && now - (st.lastKickAt || 0) >= 10 * 60000 && needInstall();
    let dueIssues = false;
    if (cfg.issueUpload !== 'off') { const d = readState('issues-dirty'); const i = readState('issues'); dueIssues = (d.at || 0) > (i.lastSyncAt || 0) && now >= (i.blockedUntil || 0) && now - (i.lastTryAt || 0) >= 5 * 60000; }
    // 使用情况：有过完了的日子还没传（今天查过、传完了就不再看；传不上去一小时后再试）
    let dueUsage = false;
    if (cfg.usageReport !== 'off') { const u = readState('usage-sync'); const U = require('./usage.js'); const today = U.dayKey(); dueUsage = u.checkedDay !== today && now >= (u.blockedUntil || 0) && now - (u.lastTryAt || 0) >= 3600000 && U.days().some((d) => d < today); }
    if (!dueUpdate && !dueApply && !dueIssues && !dueUsage) return false;
    if (now - (st.lastKickAt || 0) < 60000 || lockHeld()) return false;
    setState({ lastKickAt: now, lastKickWhy: String(why || '') });
    return spawnBackground(['run']);
  } catch (e) { return false; }
}

/** 后台进程干的事：检查 → （自动装的）等空闲、安装 → 上报问题、使用情况 */
async function run(opt) {
  const o = opt || {};
  if (!lock()) return { skipped: '已经有一个在跑了' };
  const out = {};
  try {
    const cfg = readConfig();
    const st = readState('update');
    if (modeOf(cfg) !== 'off' || o.force) {
      if (o.force || Date.now() - (st.lastCheckAt || 0) >= hoursOf(cfg) * 3600000 || !st.remoteVersion) out.check = check();
      if ((modeOf(cfg) === 'auto' || o.force) && needInstall(!!o.force)) {
        if (o.force || await waitIdle(o.waitMs, o.quietMs)) out.apply = apply();
        else { log('一直有请求在跑，这次先不装，十分钟后再看'); out.apply = { ok: false, why: '路由一直在忙' }; }
      }
    }
    // 刚装过新版的话，这个进程里载入的还是旧代码：上报留给下一次（新代码来做）
    if (cfg.issueUpload !== 'off' && !o.noIssues && !out.apply) { try { out.issues = await require('./issues.js').sync(); } catch (e) { log('上报问题时出错：' + ((e && e.message) || e)); } }
    if (cfg.usageReport !== 'off' && !o.noIssues && !out.apply) { try { out.usage = await require('./issues.js').syncUsage(); } catch (e) { log('上报使用情况时出错：' + ((e && e.message) || e)); } }
  } catch (e) { log('后台更新出错：' + ((e && e.stack) || e)); out.error = String((e && e.message) || e); } finally { unlock(); }
  return out;
}

module.exports = { DIR, STAGE, LOG, INSTALL_LOG, modeOf, hoursOf, installedVersion, stagedVersion, remoteHead, check, needInstall, apply, selfCheck, idle, waitIdle, status, kick, run, spawnBackground, lockHeld };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  const has = (f) => process.argv.includes(f);
  const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  (async () => {
    // --wait-ms、--quiet-ms：等路由空闲最多等多久、多久没请求才算空闲（默认 30 分钟、20 秒）；--print：把结果写出来
    const num = (f) => { const i = process.argv.indexOf(f); const n = i > 0 ? Number(process.argv[i + 1]) : NaN; return n >= 0 ? n : undefined; };
    if (cmd === 'run') { const r = await run({ force: has('--force'), waitMs: num('--wait-ms'), quietMs: num('--quiet-ms') }); if (has('--print')) print(r); }
    else if (cmd === 'check') { let ran = false; if (lock()) { try { check(); ran = true; } finally { unlock(); } } print(Object.assign(status(), ran ? {} : { skipped: '已经有一个在跑了' })); }
    else if (cmd === 'apply') print(await run({ force: true, noIssues: true }));
    else if (cmd === 'selfcheck') { const c = selfCheck(); console.log(c.ok ? 'ok' : c.why); process.exitCode = c.ok ? 0 : 1; }
    else if (cmd === 'diagnose') print(await gl.diagnose(readConfig()));
    else if (cmd === 'mint') { const m = gl.mintToken(); if (m.ok) log('用 SSH 申请了一个令牌，到期日 ' + (m.expires || '（没说）')); print(m); }
    else if (cmd === 'issues-sync') { let r = { skipped: '已经有一个在跑了' }; if (lock()) { try { r = await require('./issues.js').sync({ force: true }); } finally { unlock(); } } print(r); }
    else if (cmd === 'issues-summary') print(Object.assign(require('./issues.js').summary(), { lastExport: require('./issues.js').lastExport() }));
    // 导出只导出（页面交给浏览器下载），关掉是另一步：issues-close <编号,编号|-> --name <导出的文件名>
    else if (cmd === 'issues-export') print(await require('./issues.js').exportIssues());
    else if (cmd === 'issues-close') { const i = process.argv.indexOf('--name'); print(await require('./issues.js').closeExported(String(process.argv[3] || '').split(',').map(Number).filter((x) => x > 0), i > 0 ? process.argv[i + 1] : '')); }
    else if (cmd === 'usage-sync') { let r = { skipped: '已经有一个在跑了' }; if (lock()) { try { r = await require('./issues.js').syncUsage({ force: true }); } finally { unlock(); } } print(r); }
    else if (cmd === 'usage-preview') print(require('./issues.js').usagePreview());
    else print(status());
  })().catch((e) => { log('出错：' + ((e && e.stack) || e)); print({ ok: false, error: String((e && e.message) || e) }); process.exitCode = 1; });
}
