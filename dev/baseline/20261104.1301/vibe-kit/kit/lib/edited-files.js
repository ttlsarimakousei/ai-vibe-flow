'use strict';
/*
 * 这个会话改过的文件（K3，2026-11-01）：从会话记录里成功的 Edit、Write、MultiEdit、NotebookEdit 算。
 * 检查点（tools/checkpoint.js）、只提交本会话改过的文件（tools/commit.js），和 guard-commit 查 commit.js 都用这里：
 * 两边拿同一份会话记录、同一套算法，算出来的文件一样。用 Bash 改的（sed -i、脚本生成的）不算：会话记录里看不出改了哪些文件。
 *
 * 工具自己（模型用 Bash 跑起来的 node 进程）拿不到钩子的输入，按下面的顺序找自己是哪个会话：
 *   1. 命令行给了 --session <会话号>
 *   2. 环境变量 CLAUDE_CODE_SESSION_ID（2.1.289 实测 Bash 工具的进程里有；2.1.120 没有）
 *   3. 用户目录 projects/ 下最近改过的会话记录里，最后几个还没有结果的工具调用里有这条命令（2.1.120、2.1.289 实测：
 *      命令执行时这条 tool_use 已经写进了会话记录）：命令里有这个工具的名字、记录里的当前目录对得上的才算；对得上好几个会话的不猜
 * 提交前的一次性许可（票）：guard-commit 查过一条跑 commit.js 的命令、没拦下，记一张票（<会话>-commit-tool.json：仓库、查过的文件）；
 * commit.js 只提交票上有的，用完就作废。钩子没跑（钩子出错放行）就没有票，commit.js 不提交——它不能成了绕过提交检查的后门。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./session');

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const FULL = 32 * 1024 * 1024;
const TICKET = (sid) => String(sid) + '-commit-tool';
const TICKET_MS = 10 * 60000;

/** 整份会话记录（最多最后 32 MB）。读不了返回 [] */
function entriesOf(transcript) {
  if (!transcript) return [];
  try { return S.tailEntries(transcript, FULL).filter((e) => e && !e.isSidechain); } catch (e) { return []; }
}

/** 会话里改成功了的文件：[{ abs, first, last }]，按第一次改的先后排；first、last 是在会话记录里的位置 */
function editedFiles(entries, cwd) {
  const res = S.toolResults(entries);
  const out = new Map();
  for (const c of S.toolCalls(entries, 0)) {
    if (!EDIT_TOOLS.test(String(c.name || ''))) continue;
    const r = res.get(c.id);
    if (!r || r.error) continue;
    const f = String((c.input && (c.input.file_path || c.input.notebook_path)) || '');
    if (!f) continue;
    const abs = path.resolve(cwd || process.cwd(), f);
    const k = S.normKey(abs);
    const x = out.get(k);
    if (x) x.last = c.i; else out.set(k, { abs, first: c.i, last: c.i });
  }
  return [...out.values()];
}

/** 往上最近的 git 仓库根目录（.git 是目录或文件都算）；不在仓库里返回 '' */
function repoOf(p) {
  let d = path.resolve(p);
  try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch (e) { d = path.dirname(d); }
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}

function git(root, args, opts) {
  const o = opts || {};
  return execFileSync('git', ['--no-optional-locks', '-C', root].concat(args), { encoding: o.buffer ? null : 'utf8', input: o.input, env: o.env || process.env, timeout: o.timeout || 30000, windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** 被 .gitignore 忽略的（相对路径的集合）。查不了返回空集合 */
function ignoredSet(root, rels) {
  if (!rels.length) return new Set();
  try {
    const out = git(root, ['check-ignore', '-z', '--stdin'], { input: rels.join('\0') + '\0' });
    return new Set(String(out).split('\0').filter(Boolean));
  } catch (e) { return e && e.status === 1 ? new Set() : new Set(); }
}
/** 已经跟踪着的（相对路径的集合） */
function trackedSet(root, rels) {
  if (!rels.length) return new Set();
  try { return new Set(git(root, ['ls-files', '-z', '--'].concat(rels.slice(0, 400).map((r) => ':(literal)' + r))).split('\0').filter(Boolean)); } catch (e) { return new Set(); }
}

/**
 * 这次 commit.js 要提交哪些文件。o: { entries, cwd, root, only: [路径…] }
 * 返回 { root, files: [{ abs, rel, gone }], skipped: [{ rel, why }], notMine: [路径], other: [别的仓库里的] }
 *   不提交：别的仓库（壳子里的子项目、外面）的、套件自己的（含令牌文件）、.vibe 里的、过程文件（备份、日志）、被 .gitignore 忽略的、
 *   和上次提交一样没改的、建了又删掉的
 *   only 给了：只要这几个；不是这个会话改过的列进 notMine（commit.js 不提交它们）
 */
function commitPlan(o) {
  const root = path.resolve(o.root);
  const rk = S.normKey(root);
  const out = { root, files: [], skipped: [], notMine: [], other: [] };
  let tidy = null;
  try { tidy = require('./tidy.js'); } catch (e) { tidy = null; }
  let list = editedFiles(o.entries || [], o.cwd || root);
  if (o.only && o.only.length) {
    const want = o.only.map((f) => S.normKey(path.resolve(o.cwd || root, String(f))));
    const mine = new Set(list.map((x) => S.normKey(x.abs)));
    out.notMine = o.only.filter((f, i) => !mine.has(want[i]));
    list = list.filter((x) => want.includes(S.normKey(x.abs)));
  }
  const cands = [];
  for (const x of list) {
    const k = S.normKey(x.abs);
    if (!(k === rk || k.startsWith(rk + '/'))) { out.other.push(x.abs); continue; }
    if (S.normKey(repoOf(x.abs)) !== rk) { out.other.push(x.abs); continue; }
    const r = rel(root, x.abs);
    if (S.isKitPath(x.abs)) { out.skipped.push({ rel: r, why: '套件自己的文件' }); continue; }
    if (/(^|\/)\.vibe\//i.test(r)) { out.skipped.push({ rel: r, why: '.vibe 里的过程文件' }); continue; }
    if (tidy && (tidy.isProcessFile(x.abs) || tidy.processDirOf(x.abs, root, false))) { out.skipped.push({ rel: r, why: '过程文件（备份、日志、临时文件）' }); continue; }
    cands.push({ abs: x.abs, rel: r });
  }
  const ignored = ignoredSet(root, cands.map((c) => c.rel));
  const tracked = trackedSet(root, cands.map((c) => c.rel));
  let changed = null;
  try {
    // 和上次提交比有没有变（新文件、删掉的也算变了）。查不了就都当变了，交给 git 自己判断
    const st = git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '-uall', '--'].concat(cands.slice(0, 400).map((c) => ':(literal)' + c.rel)));
    changed = new Set();
    const parts = String(st).split('\0');
    for (let i = 0; i < parts.length; i++) { const e = parts[i]; if (e.length < 4) continue; changed.add(e.slice(3)); if (/^[RC]/.test(e)) i++; }
  } catch (e) { changed = null; }
  for (const c of cands) {
    if (ignored.has(c.rel)) { out.skipped.push({ rel: c.rel, why: '被 .gitignore 忽略' }); continue; }
    const exists = fs.existsSync(c.abs);
    if (!exists && !tracked.has(c.rel)) { out.skipped.push({ rel: c.rel, why: '建了又删掉了' }); continue; }
    if (changed && !changed.has(c.rel)) { out.skipped.push({ rel: c.rel, why: '和上次提交一样，没有改动' }); continue; }
    out.files.push({ abs: c.abs, rel: c.rel, gone: !exists });
  }
  return out;
}

// ---------- 工具找自己是哪个会话 ----------
const projectsDir = () => path.join(S.CFG_DIR, 'projects');
function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return []; } }
/** 会话号对应的会话记录：先看开口钩子记下的（active-sessions），再到 projects/*\/<会话号>.jsonl 找 */
function transcriptOf(sid) {
  if (!/^[\w.-]{6,100}$/.test(String(sid || ''))) return '';
  try { const a = S.readState('active-sessions')[sid]; if (a && a.transcript && fs.existsSync(a.transcript)) return a.transcript; } catch (e) { /* 没记 */ }
  for (const d of listDir(projectsDir())) {
    if (!d.isDirectory()) continue;
    const f = path.join(projectsDir(), d.name, sid + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return '';
}
/** 一份会话记录的最后一段里，还没有结果的工具调用（Bash、PowerShell）：[{ command, cwd }] */
function pendingCommands(file) {
  let es = [];
  try { es = S.tailEntries(file, 400000); } catch (e) { es = []; }
  const done = new Set(S.toolResults(es).keys());
  const out = [];
  for (const c of S.toolCalls(es, 0)) {
    if (done.has(c.id) || !/^(Bash|PowerShell)$/.test(String(c.name || ''))) continue;
    const e = es[c.i] || {};
    out.push({ command: String((c.input && c.input.command) || ''), cwd: String(e.cwd || '') });
  }
  return out;
}
/**
 * 找自己是哪个会话。o: { sid, cwd, marker（认这条命令的正则，例 /commit\.js/） }
 * 返回 { sid, transcript, how } 或 { error: 为什么找不到 }
 */
function findSession(o) {
  const opt = o || {};
  const cwd = path.resolve(opt.cwd || process.cwd());
  const given = String(opt.sid || '').trim();
  if (given) { const t = transcriptOf(given); return t ? { sid: given, transcript: t, how: '命令行' } : { error: '找不到会话 ' + given + ' 的会话记录' }; }
  const env = String(process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (env) { const t = transcriptOf(env); if (t) return { sid: env, transcript: t, how: '环境变量' }; }
  const marker = opt.marker || /./;
  const since = Date.now() - 15 * 60000;
  const hits = [];
  for (const d of listDir(projectsDir())) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !/\.jsonl$/i.test(f.name)) continue;
      const file = path.join(dir, f.name);
      let st = null;
      try { st = fs.statSync(file); } catch (e) { continue; }
      if (st.mtimeMs < since) continue;
      const mine = pendingCommands(file).some((p) => marker.test(p.command) && (!p.cwd || S.normKey(path.resolve(p.cwd)) === S.normKey(cwd)));
      if (mine) hits.push({ sid: f.name.replace(/\.jsonl$/i, ''), transcript: file });
    }
  }
  if (hits.length === 1) return Object.assign({ how: '会话记录' }, hits[0]);
  if (hits.length > 1) return { error: '有 ' + hits.length + ' 个会话正在这个目录里跑同样的命令，分不清是哪个' };
  return { error: '认不出是哪个会话（这个工具要在 Claude Code 的会话里由 Claude 来跑）' };
}

// ---------- commit.js 的一次性许可（票） ----------
/*
 * 票上记仓库和查过的文件，不记提交信息：提交信息写在 $(cat <<EOF …) 里的，钩子算不出原文，绑不上；
 * 提交信息的格式 commit.js 自己照同一个规矩再查一遍。commit.js 一开始就把票用掉，后面再因为别的原因不提交，票也不留着给下一次
 */
/** guard-commit 查过、没拦下：记一张票 */
function writeTicket(sid, t) {
  if (!sid || sid === 'unknown' || !t || !t.root) return false;
  try {
    return !!S.updateState(TICKET(sid), (o) => {
      const list = (Array.isArray(o.list) ? o.list : []).filter((x) => Date.now() - (x.at || 0) < TICKET_MS);
      list.push({ at: Date.now(), root: S.normKey(t.root), files: (t.files || []).slice(0, 2000) });
      return { list: list.slice(-10) };
    });
  } catch (e) { return false; }
}
/** commit.js 用票：同一个仓库、10 分钟内的最近一张。拿到就作废（一张票只提交一次）。没有、作废不了返回 null */
function takeTicket(sid, root) {
  if (!sid) return null;
  let got = null;
  try {
    const ok = S.updateState(TICKET(sid), (o) => {
      const list = (Array.isArray(o.list) ? o.list : []).filter((x) => Date.now() - (x.at || 0) < TICKET_MS);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].root === S.normKey(root)) { got = list[i]; list.splice(i, 1); break; }
      }
      return { list };
    });
    return ok ? got : null;
  } catch (e) { return null; }
}

module.exports = { EDIT_TOOLS, entriesOf, editedFiles, repoOf, commitPlan, findSession, transcriptOf, pendingCommands, writeTicket, takeTicket };
