'use strict';
/*
 * 写代码之前先拉代码（开关 pullBeforeWork，默认开）。用户 2026-10-01 提的：同事推了新代码，这边照着旧的分析、写，到提交时才发现对不上。
 *
 * 什么时候拉：会话要开始走 OpenSpec 流程的那一句话（hooks/task-anchor.js 定的"进了流程"）——
 *   提了需求（接下来要探索、分析现有代码）、敲了 /opsx:…（explore、propose、apply……）、接着交接记录做。
 *   已经在流程里说的"继续""好"不拉：做到一半不换底下的代码。
 *   同一个仓库 2 小时里只拉一次（拉没拉成都算）：需求分析前拉过，接着 propose、apply 就不再拉；隔了半天再 apply 会再拉一次。
 * 拉哪些：会话启动目录所在的仓库，加上它下面的子项目仓库（壳子），最多 12 个，一起拉。
 * 怎么拉：只快进。先 git fetch，再 git merge --ff-only 跟踪的远端分支。不做合并提交、不变基、不动没提交的改动：
 *   本地有没推的提交、远端也有新的（分叉了）         → 不拉，告诉它
 *   没提交的改动和远端改的是同一些文件               → git 自己拒绝，什么都不变，告诉它
 *   没有跟踪的远端分支、分离头指针、合并/变基做到一半 → 不拉，不提
 *   连不上、没权限、超时                             → 没拉成，告诉它照本地的做
 * git 一律不交互（不弹登录框、不问口令），拉一个仓库最多等 15 秒。
 * 结果带给模型几行；拉到了新代码的，提醒它之前读过的代码可能变了。全自动模式下没拉成的，记进报告"留给你做的"。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readState, updateState, normKey, nestedRepos, hookLog } = require('./session');

const EVERY_MS = 2 * 3600000;
const MAX_REPOS = 12;
const FETCH_MS = 15000;
const STEP_MS = 8000;

/** 这个目录所在的仓库（往上找 .git，文件、目录都算：工作树、子模块的 .git 是文件） */
function repoOf(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}
function reposOf(cwd) {
  const out = [];
  const top = repoOf(cwd);
  if (top) out.push(top);
  try { for (const r of nestedRepos(cwd)) if (!out.some((x) => normKey(x) === normKey(r))) out.push(r); } catch (e) { /* 找不了子项目 */ }
  return out.slice(0, MAX_REPOS);
}

/** git 用哪个 ssh：照这台电脑原来的配置（环境变量、git 配置），后面加上"不许交互" */
function sshFor(repo) {
  let base = String(process.env.GIT_SSH_COMMAND || '').trim();
  if (!base) { try { const r = spawnSync('git', ['-C', repo, 'config', '--get', 'core.sshCommand'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); if (r.status === 0) base = String(r.stdout || '').trim(); } catch (e) { /* 没配 */ } }
  if (!base && String(process.env.GIT_SSH || '').trim()) base = '"' + String(process.env.GIT_SSH).trim().replace(/\\/g, '/') + '"';
  base = base || 'ssh';
  return /plink/i.test(base) ? base + ' -batch' : base + ' -o BatchMode=yes -o ConnectTimeout=10';
}
/** 不交互、英文输出（好认出错在哪）。remote：要连远端的那一步才去查 ssh 怎么配的（本地的几步用不着，省一个进程） */
function envFor(repo, remote) {
  return Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', LANG: 'C', LC_ALL: 'C' }, remote ? { GIT_SSH_COMMAND: sshFor(repo) } : {});
}
/** 结束一个进程和它起的子进程（git 起的 ssh、凭据助手）：不留进程 */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else child.kill('SIGKILL');
  } catch (e) { /* 已经没了 */ }
}
/** 跑一条 git，返回 { code, out, err, timedOut } */
function git(repo, args, env, ms) {
  return new Promise((resolve) => {
    const pre = ['-C', repo, '-c', 'credential.interactive=false', '-c', 'core.quotepath=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
    let out = '';
    let err = '';
    let done = false;
    let child;
    try { child = spawn('git', pre.concat(args), { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: String((e && e.message) || e) }); return; }
    const timer = setTimeout(() => { if (done) return; done = true; killTree(child); resolve({ code: -1, out, err, timedOut: true }); }, ms || STEP_MS);
    child.stdout.on('data', (c) => { if (out.length < 200000) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 200000) err += c; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, out, err: e && e.code === 'ENOENT' ? '这台电脑上找不到 git' : String((e && e.message) || e), missing: !!(e && e.code === 'ENOENT') }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); });
  });
}
/** fetch 没成的原因翻成人话 */
function whyFetch(r) {
  const e = String(r.err || '');
  if (r.timedOut) return '等了 ' + Math.round(FETCH_MS / 1000) + ' 秒没拉完';
  if (r.missing) return '这台电脑上找不到 git';
  if (/Host key verification failed/i.test(e)) return '这台电脑还没用 SSH 连过这个远端（要先在终端里连一次、确认指纹）';
  if (/Authentication failed|Permission denied|could not read (Username|Password)|Access denied|HTTP Basic|returned error: 40[13]|terminal prompts disabled/i.test(e)) return '远端不认这台电脑的登录信息（没登录、密码或令牌过期、没有权限）';
  if (/not found|does not appear to be a git repository|returned error: 404/i.test(e)) return '远端仓库找不到';
  if (/Could not resolve host|Connection (timed out|refused|reset)|unable to access|Network is unreachable|Operation timed out|Failed to connect|timed out/i.test(e)) return '连不上远端';
  const line = e.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
  return line ? line.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@').slice(0, 160) : 'git 没说原因';
}
/** 快进合并被拒时，碰到的是哪几个文件（git 列在"would be overwritten"下面、缩进一个 tab 的那几行） */
function filesIn(err) {
  const lines = String(err || '').split(/\r?\n/);
  const out = [];
  let on = false;
  for (const l of lines) {
    if (/would be (overwritten|removed)/i.test(l)) { on = true; continue; }
    if (on && /^\s+\S/.test(l)) { out.push(l.trim()); continue; }
    if (on) on = false;
  }
  return out.slice(0, 8);
}
/** 拉一个仓库。返回 { repo, ok, latest, updated, ahead, behind, from, to, skip, fail, why, files } */
async function pullRepo(repo) {
  const env = envFor(repo);
  const r0 = { repo };
  const head = await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], env);
  if (head.missing) return Object.assign(r0, { fail: 'git', why: '这台电脑上找不到 git' });
  if (head.code !== 0) return Object.assign(r0, { skip: '分离头指针' });
  const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], env);
  if (up.code !== 0) return Object.assign(r0, { skip: '没有跟踪的远端分支' });
  r0.branch = head.out.trim();
  r0.upstream = up.out.trim();
  const gd = await git(repo, ['rev-parse', '--absolute-git-dir'], env);
  const gitDir = gd.out.trim();
  if (gitDir && ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((n) => fs.existsSync(path.join(gitDir, n)))) return Object.assign(r0, { skip: '合并或变基做到一半' });
  const f = await git(repo, ['fetch', '--quiet'], envFor(repo, true), FETCH_MS);
  if (f.code !== 0) return Object.assign(r0, { fail: 'fetch', why: whyFetch(f) });
  const ab = await git(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], env);
  const [ahead, behind] = ab.out.trim().split(/\s+/).map((x) => Number(x) || 0);
  r0.ahead = ahead;
  r0.behind = behind;
  if (!behind) return Object.assign(r0, { ok: true, latest: true });
  if (ahead) return Object.assign(r0, { fail: 'diverged' });
  const before = (await git(repo, ['rev-parse', '--short=8', 'HEAD'], env)).out.trim();
  const m = await git(repo, ['merge', '--ff-only', '--quiet', '@{u}'], env, FETCH_MS);
  if (m.code !== 0) {
    const e = String(m.err || '');
    if (/would be (overwritten|removed)/i.test(e)) return Object.assign(r0, { fail: /untracked/i.test(e) ? 'untracked' : 'dirty', files: filesIn(e) });
    return Object.assign(r0, { fail: 'merge', why: m.timedOut ? '合并等了太久' : (e.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || 'git 没说原因').slice(0, 160) });
  }
  const after = (await git(repo, ['rev-parse', '--short=8', 'HEAD'], env)).out.trim();
  return Object.assign(r0, { ok: true, updated: behind, from: before, to: after });
}

/** 给模型看的几行 */
function linesOf(results, cwd, auto) {
  const name = (r) => { const rel = path.relative(cwd, r.repo).split(path.sep).join('/'); return rel && !rel.startsWith('..') ? rel : path.basename(r.repo); };
  const out = [];
  const latest = results.filter((r) => r.latest);
  const ask = auto ? '全自动模式：照本地的做，写进最后的交代，留给用户处理。' : '要不要处理（先提交、暂存、还是合并）问我，不要自己动 git 历史。';
  for (const r of results) {
    if (r.updated) out.push(name(r) + '：拉到了 ' + r.updated + ' 个新提交（' + r.from + '..' + r.to + '）。这个仓库里之前读过的代码可能变了，用到的地方重新读');
    else if (r.fail === 'diverged') out.push(name(r) + '：本地有 ' + r.ahead + ' 个没推的提交，远端也有 ' + r.behind + ' 个新提交（分叉了），没拉。' + ask);
    else if (r.fail === 'dirty' || r.fail === 'untracked') out.push(name(r) + '：远端有 ' + r.behind + ' 个新提交，和' + (r.fail === 'untracked' ? '还没 add 的新文件' : '没提交的改动') + '碰到同一些文件' + (r.files && r.files.length ? '（' + r.files.slice(0, 5).join('、') + '）' : '') + '，git 没让拉，什么都没变。' + ask);
    else if (r.fail) out.push(name(r) + '：没拉成（' + (r.why || r.fail) + '），照本地的代码做');
  }
  if (!out.length && !latest.length) return '';
  if (latest.length) out.push(out.length ? '其余 ' + latest.length + ' 个仓库本来就是最新的' : latest.length > 1 ? latest.length + ' 个仓库都是最新的' : name(latest[0]) + '：本来就是最新的');
  return '开工前拉了一次代码（只快进，同一个仓库 2 小时内不再拉）：' + (out.length > 1 ? '\n- ' + out.join('\n- ') : out[0]);
}

/**
 * 要开工了：拉一次代码。j.cwd 是会话的启动目录（task-anchor 已经换过）。
 * 返回 { text, results }；不用拉（开关关着、不是仓库、2 小时内拉过）返回 null
 */
async function beforeWork(j, cfg) {
  if (!cfg || cfg.pullBeforeWork === false) return null;
  const cwd = path.resolve((j && j.cwd) || process.cwd());
  const repos = reposOf(cwd);
  if (!repos.length) return null;
  const now = Date.now();
  const seen = readState('pull').repos || {};
  const due = repos.filter((r) => now - ((seen[normKey(r)] || {}).at || 0) >= EVERY_MS);
  if (!due.length) return null;
  // 先记上"拉过了"：同时开口的另一个会话不再去拉同一个仓库
  const mark = (list) => updateState('pull', (o) => {
    const m = o.repos && typeof o.repos === 'object' ? o.repos : (o.repos = {});
    for (const x of list) m[normKey(x.repo)] = Object.assign({ at: now }, x.ok ? { ok: true, updated: x.updated || 0 } : {}, x.fail ? { fail: x.fail } : {}, x.skip ? { skip: x.skip } : {});
    const ks = Object.keys(m);
    if (ks.length > 300) for (const k of ks.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)).slice(0, ks.length - 300)) delete m[k];
    return o;
  });
  mark(due.map((repo) => ({ repo })));
  const results = await Promise.all(due.map((r) => pullRepo(r).catch((e) => ({ repo: r, fail: 'error', why: String((e && e.message) || e).slice(0, 160) }))));
  mark(results);
  try { const U = require('./usage.js'); for (const r of results) if (!r.skip) U.bump(r.updated ? 'pull.updated' : r.ok ? 'pull.latest' : 'pull.fail'); } catch (e) { /* 数不了不影响 */ }
  // 全自动模式：没拉成的留给用户，记进报告
  if (cfg.autoMode) {
    try {
      const R = require('./report.js');
      for (const r of results.filter((x) => x.fail)) {
        const detail = r.fail === 'diverged' ? '本地有 ' + r.ahead + ' 个没推的提交，远端也有 ' + r.behind + ' 个新提交，没有自动合并。回来先把两边合起来（git pull --rebase 或者合并），再推'
          : r.fail === 'dirty' || r.fail === 'untracked' ? '远端有 ' + r.behind + ' 个新提交，和' + (r.fail === 'untracked' ? '还没 add 的新文件' : '没提交的改动') + '碰到同一些文件' + (r.files && r.files.length ? '：' + r.files.slice(0, 5).join('、') : '') + '。这一轮照本地的代码做的'
            : '没拉成：' + (r.why || r.fail) + '。这一轮照本地的代码做的';
        R.note(j, { kind: 'hand', title: '开工前没拉成代码：' + path.basename(r.repo), detail });
      }
    } catch (e) { /* 记不了不影响干活 */ }
  }
  hookLog('开工前拉代码 ' + results.map((r) => path.basename(r.repo) + '=' + (r.updated ? '拉到 ' + r.updated + ' 个提交' : r.latest ? '最新' : r.skip ? '跳过（' + r.skip + '）' : '没拉成（' + (r.why || r.fail) + '）')).join('，'));
  return { text: linesOf(results, cwd, !!cfg.autoMode), results };
}

module.exports = { beforeWork, pullRepo, reposOf, linesOf, EVERY_MS };
