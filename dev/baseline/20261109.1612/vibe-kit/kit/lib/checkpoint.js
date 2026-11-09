'use strict';
/*
 * 检查点和一键回退（K3 M07，2026-11-01）。tools/checkpoint.js 的命令行在用它；自动模式开工、开新一组任务之前，钩子送一句 hint() 让模型先存一个。
 *
 * 存（save）：用一份临时 index（GIT_INDEX_FILE，从真 index 复制一份）把工作区的样子写成一棵树，做成一个提交，挂在
 *   refs/vibe/ckpt/<会话>/<序号> 上。不动用户的暂存区、分支、工作区。存进去的：已跟踪文件的现状、没被忽略的新文件
 *   （单个超过 20 MB 的不存，记在提交说明里）、这个会话改过的被 .gitignore 忽略的文件（回退要用）。
 *   这个会话改过的文件在别的仓库（壳子的子项目）里：那个仓库也存一份，序号相同。每个会话最多留最近 30 个，别的会话 14 天前的清掉。
 * 回退（restore）：只还原这个会话改过的文件（会话记录里成功的 Edit、Write 算的，lib/edited-files.js），别的文件不碰；
 *   回退之前先自动再存一个检查点，回退本身也能撤销。检查点里有这个文件 → 写回那时的内容；检查点里没有、那时也确实不存在
 *   （没被忽略、不在"太大没存"的名单里）→ 删掉；拿不准的（被忽略、太大没存）不动，列出来。不动 index、HEAD。
 * 检查点只在本机：refs/vibe/ 不在 push 的默认范围里，不会推到远端。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const S = require('./session');
const E = require('./edited-files');

const BIG = 20 * 1024 * 1024;
const KEEP = 30;
const OLD_DAYS = 14;
const IDENT = { GIT_AUTHOR_NAME: 'vibe-kit', GIT_AUTHOR_EMAIL: 'vibe-kit@localhost', GIT_COMMITTER_NAME: 'vibe-kit', GIT_COMMITTER_EMAIL: 'vibe-kit@localhost' };

function git(root, args, o) {
  const opt = o || {};
  return execFileSync('git', ['--no-optional-locks', '-C', root].concat(args), { encoding: opt.buffer ? null : 'utf8', input: opt.input, env: Object.assign({}, process.env, opt.env || {}), timeout: opt.timeout || 120000, windowsHide: true, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
const safeSid = (sid) => String(sid || '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'unknown';
const refBase = (sid) => 'refs/vibe/ckpt/' + safeSid(sid) + '/';
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** 这个会话在这个仓库里的检查点：[{ n, sha, at, why, ref }]，序号从小到大 */
function list(root, sid) {
  let out = '';
  try { out = git(root, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(contents:subject)', refBase(sid)]); } catch (e) { return []; }
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [ref, sha, at, subject] = l.split('\t');
    const n = Number(ref.slice(refBase(sid).length));
    return { n, sha, at: Number(at) * 1000, why: String(subject || '').replace(/^vibe-kit 检查点 \d+[：:]\s*/, ''), ref };
  }).filter((x) => Number.isInteger(x.n) && x.n > 0).sort((a, b) => a.n - b.n);
}

/** 涉及哪些仓库：当前目录所在的，加上会话改过的文件所在的 */
function reposOf(cwd, files) {
  const set = new Map();
  const add = (r) => { if (r && !set.has(S.normKey(r))) set.set(S.normKey(r), r); };
  add(E.repoOf(cwd));
  for (const f of files) add(E.repoOf(f.abs));
  return [...set.values()];
}

/** 一个仓库存一份快照：返回 { sha, big: [没存的大文件] } */
function snapshot(root, sid, n, why, mine) {
  const gd = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const tmp = path.join(os.tmpdir(), 'vibe-ckpt-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.idx');
  const env = { GIT_INDEX_FILE: tmp, GIT_LITERAL_PATHSPECS: '1' };
  try {
    let head = '';
    try { head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch (e) { head = ''; }
    // 从真 index 复制：已跟踪文件的时间戳、大小都在，git 不用每个都重读一遍
    try { fs.copyFileSync(path.join(gd, 'index'), tmp); } catch (e) { /* 还没有 index（新仓库）：从空的开始 */ }
    git(root, ['add', '-u'], { env });
    // 没被忽略的新文件：太大的不存（记下来，回退时这些按"拿不准"处理）；下面套着的别的仓库（以 / 结尾）不存
    const untracked = git(root, ['ls-files', '-o', '--exclude-standard', '-z'], { env }).split('\0').filter((f) => f && !f.endsWith('/'));
    const big = [];
    const small = [];
    for (const f of untracked) { let size = 0; try { size = fs.statSync(path.join(root, f)).size; } catch (e) { continue; } (size > BIG ? big : small).push(f); }
    for (let i = 0; i < small.length; i += 500) git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: small.slice(i, i + 500).join('\0') + '\0' });
    // 这个会话改过的、被忽略的文件：一个一个写进去（git add 不收被忽略的）
    const mineRel = mine.map((f) => rel(root, f.abs));
    let ignored = [];
    if (mineRel.length) { try { ignored = git(root, ['check-ignore', '-z', '--stdin'], { input: mineRel.join('\0') + '\0' }).split('\0').filter(Boolean); } catch (e) { ignored = []; } }
    const kept = [];
    for (const f of ignored) {
      const abs = path.join(root, f);
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (!st.isFile() || st.size > BIG) { big.push(f); continue; }
      const blob = git(root, ['hash-object', '-w', '--', f]).trim();
      git(root, ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + f], { env });
      kept.push(f);
    }
    const tree = git(root, ['write-tree'], { env }).trim();
    const body = ['vibe-kit 检查点 ' + n + '：' + (String(why || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '（没写为什么）'), '', '会话 ' + sid];
    if (big.length) body.push('没存（太大）：' + big.slice(0, 200).join('\t'));
    if (kept.length) body.push('被忽略、也存了：' + kept.slice(0, 200).join('\t'));
    const sha = git(root, ['commit-tree', tree].concat(head ? ['-p', head] : []), { env: IDENT, input: body.join('\n') + '\n' }).trim();
    git(root, ['update-ref', refBase(sid) + n, sha]);
    return { sha, big };
  } finally {
    for (const f of [tmp, tmp + '.lock']) { try { fs.unlinkSync(f); } catch (e) { /* 没有 */ } }
  }
}

/** 清掉旧的：这个会话只留最近 KEEP 个；别的会话 OLD_DAYS 天前的整个清掉 */
function prune(root, sid) {
  try {
    const mine = list(root, sid);
    for (const x of mine.slice(0, Math.max(0, mine.length - KEEP))) git(root, ['update-ref', '-d', x.ref]);
    const out = git(root, ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)', 'refs/vibe/ckpt/']);
    const cut = Date.now() / 1000 - OLD_DAYS * 86400;
    for (const l of out.split(/\r?\n/).filter(Boolean)) { const [ref, at] = l.split('\t'); if (!ref.startsWith(refBase(sid)) && Number(at) < cut) git(root, ['update-ref', '-d', ref]); }
  } catch (e) { /* 清不了下次再清 */ }
}

/**
 * 存一个检查点。o: { sid, transcript, cwd, why }。返回 { n, repos: [{ root, sha, big }], files: 会话改过的文件数 } 或 { error }
 */
function save(o) {
  const cwd = path.resolve(o.cwd || process.cwd());
  const files = E.editedFiles(E.entriesOf(o.transcript), cwd);
  const repos = reposOf(cwd, files);
  if (!repos.length) return { error: cwd + ' 不在 git 仓库里，存不了检查点。' };
  // 几个仓库用同一个序号：取各仓库里这个会话最大的序号加一
  const n = Math.max(0, ...repos.map((r) => { const l = list(r, o.sid); return l.length ? l[l.length - 1].n : 0; })) + 1;
  const out = { n, repos: [], files: files.length };
  for (const root of repos) {
    const mine = files.filter((f) => S.normKey(E.repoOf(f.abs)) === S.normKey(root));
    try { out.repos.push(Object.assign({ root }, snapshot(root, o.sid, n, o.why, mine))); } catch (e) { out.repos.push({ root, error: String((e && (e.stderr || e.message)) || e).trim().slice(0, 300) }); }
    prune(root, o.sid);
  }
  return out;
}

/** 检查点的提交说明里记的两份名单 */
function notesOf(root, sha) {
  let msg = '';
  try { msg = git(root, ['log', '-1', '--format=%B', sha]); } catch (e) { msg = ''; }
  const pick = (k) => { const m = new RegExp('^' + k + '：(.*)$', 'm').exec(msg); return new Set(m ? m[1].split('\t').filter(Boolean) : []); };
  return { big: pick('没存（太大）'), kept: pick('被忽略、也存了') };
}

/**
 * 回退到第 n 个检查点：只还原这个会话改过的文件。o: { sid, transcript, cwd, n, only: [路径…] }
 * 返回 { before: 回退前自动存的检查点序号, restored: [], removed: [], same: [], unsure: [{ rel, why }], missing: [没有这个检查点的仓库] } 或 { error }
 */
function restore(o) {
  const cwd = path.resolve(o.cwd || process.cwd());
  const files0 = E.editedFiles(E.entriesOf(o.transcript), cwd);
  let files = files0;
  if (o.only && o.only.length) { const want = o.only.map((f) => S.normKey(path.resolve(cwd, String(f)))); files = files0.filter((f) => want.includes(S.normKey(f.abs))); }
  const repos = reposOf(cwd, files0);
  const have = repos.map((root) => ({ root, ck: list(root, o.sid).find((x) => x.n === Number(o.n)) })).filter((x) => x.ck);
  if (!have.length) return { error: '没有第 ' + o.n + ' 个检查点（这个会话的）。checkpoint.js list 看有哪些。' };
  const pre = save({ sid: o.sid, transcript: o.transcript, cwd, why: '回退到第 ' + o.n + ' 个之前自动存的' });
  if (pre.error || pre.repos.some((r) => r.error)) return { error: '回退之前没能先存一个检查点（' + (pre.error || pre.repos.filter((r) => r.error).map((r) => r.error).join('；')) + '），没有回退。' };
  const out = { before: pre.n, restored: [], removed: [], same: [], unsure: [], missing: repos.filter((r) => !have.some((x) => x.root === r)) };
  for (const { root, ck } of have) {
    const notes = notesOf(root, ck.sha);
    const mine = files.filter((f) => S.normKey(E.repoOf(f.abs)) === S.normKey(root));
    const rels = mine.map((f) => rel(root, f.abs));
    let ignored = new Set();
    if (rels.length) { try { ignored = new Set(git(root, ['check-ignore', '-z', '--stdin'], { input: rels.join('\0') + '\0' }).split('\0').filter(Boolean)); } catch (e) { ignored = new Set(); } }
    // Windows 上路径不分大小写，Edit 记的大小写可能和 git 记的不一样：按 git 记的认。不然查不到，会当成"那时不存在"把文件删掉（复审发现）
    let names = null;
    const treeName = (r0) => {
      if (process.platform !== 'win32') return r0;
      if (!names) { names = new Map(); try { for (const n of git(root, ['ls-tree', '-r', '-z', '--name-only', ck.sha]).split('\0').filter(Boolean)) names.set(n.toLowerCase(), n); } catch (e) { /* 查不了就按原样 */ } }
      return names.get(r0.toLowerCase()) || r0;
    };
    for (const f of mine) {
      const r = treeName(rel(root, f.abs));
      let entry = '';
      try { entry = git(root, ['ls-tree', '-z', ck.sha, '--', r], { env: { GIT_LITERAL_PATHSPECS: '1' } }).split('\0').filter(Boolean)[0] || ''; } catch (e) { entry = ''; }
      const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(entry);
      if (m) {
        let cur = '';
        try { cur = fs.existsSync(f.abs) ? git(root, ['hash-object', '--', r]).trim() : ''; } catch (e) { cur = ''; }
        if (cur === m[2]) { out.same.push(r); continue; }
        // --filters：按这个仓库检出时的换行、过滤规则还原（core.autocrlf 开着时写回 CRLF），和 git checkout 出来的一样
        const buf = git(root, ['cat-file', '--filters', '--path=' + r, m[2]], { buffer: true });
        fs.mkdirSync(path.dirname(f.abs), { recursive: true });
        fs.writeFileSync(f.abs, buf);
        out.restored.push(r);
        continue;
      }
      if (notes.big.has(r)) { out.unsure.push({ rel: r, why: '存检查点时它太大，没存' }); continue; }
      if (ignored.has(r) && !notes.kept.has(r)) { out.unsure.push({ rel: r, why: '被 .gitignore 忽略，存检查点时这个会话还没改过它，检查点里没有' }); continue; }
      // 检查点里没有，那时也确实不存在：是那之后才建的，删掉
      if (fs.existsSync(f.abs)) { try { fs.unlinkSync(f.abs); out.removed.push(r); } catch (e) { out.unsure.push({ rel: r, why: '删不掉：' + String((e && e.message) || e).slice(0, 80) }); } }
      else out.same.push(r);
    }
  }
  return out;
}

/** 给钩子送的那一句（自动模式开工、开新一组任务之前） */
function hint() {
  const tool = 'node "' + path.join(S.KIT, 'tools', 'checkpoint.js').split(path.sep).join('/') + '"';
  return '大改之前先存一个检查点：' + tool + ' save --why "<接下来要做什么>"（只在本机，不动暂存区和分支）；改坏了用 ' + tool + ' restore <序号> 只还原这个会话改过的文件（回退前会自动再存一个），' + tool + ' list 看有哪些。';
}
/**
 * 同一件事只送一次（<会话>-ckpt-hint.json）：key 是 'apply'（开工）或者 'group:<变更目录>|<组>'（开新一组）。
 * 已经送过、记不下来的返回 ''（记不下来就不送：不然每次收工都送一遍）
 */
function hintOnce(j, key) {
  const sid = String((j && j.session_id) || '');
  if (!sid || sid === 'unknown') return '';
  let fresh = false;
  const ok = S.updateState(sid + '-ckpt-hint', (o) => { const keys = Array.isArray(o.keys) ? o.keys : []; if (!keys.includes(key)) { keys.push(key); fresh = true; } return { keys: keys.slice(-50), at: Date.now() }; });
  return ok && fresh ? hint() : '';
}

module.exports = { list, save, restore, hint, hintOnce, refBase };
