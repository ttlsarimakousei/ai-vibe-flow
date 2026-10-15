'use strict';
/*
 * 全自动模式的报告：用户不在，套件替他记下"回来要看的事"，收工时合成一份。
 *
 * 记在哪：state/<会话>-report.json，一轮一份（用户每开口一次算新的一轮）。
 * 报告写到启动 Claude 的那个目录的 .vibe/reports/全自动报告-<这一轮开始的时间>.md（.vibe 不进仓库）。
 * 谁往里记（note）：
 *   bypass      放行了哪道检查、哪一步、理由                 lib/feedback.js
 *   ask         它想用提问框问用户的问题和选项（没问成）       hooks/guard-ask.js
 *   hand        留给用户做的：push                            hooks/guard-commit.js
 *   secret      提交里像密码、key 的内容（提交放行了）         hooks/guard-commit.js
 *   unverified  打勾时验法里写了"不做"的部分                  hooks/guard-spec.js
 * 收工时（build）再补上从文件里看得出来的：各个变更做到哪、留给用户的任务、revisions.md 里"自动模式决定"的条目、
 * .vibe/pending 里等定位置的产出、这一轮的提交、还没推的提交、这个会话记下的套件问题、这一轮里它改过的库
 * （查库的工具留的痕：哪张表、几行、新增的主键、还原脚本在哪）。AI 最后的交代由收工钩子接在后面（saveFinal）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readState, writeState, updateState, normKey, hookLog, listChanges, changeRoots, nestedRepos, proposalReviewed, codeReviewIssue, reviewRecord, TASK_LINE, taskKey, syncTicks, readConfig, verifyPartOf, isDeferredTask, ensureVibeIgnored, sessionHome } = require('./session');

const TITLES = { hand: '留给你做的', db: '库里改过的', ask: '它想问你、没问成的', unverified: '没验证的', bypass: '放行的检查', secret: '提交里像密码的内容', decision: '它自己定的事' };
const MAX_ITEMS = 200;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const fileStamp = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); };
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const keyOf = (j) => String((j && j.session_id) || 'unknown') + '-report';

/** revisions.md 里有几条记录（一个二级标题一条） */
const entryCount = (file) => { try { return (fs.readFileSync(file, 'utf8').match(/^##\s/gm) || []).length; } catch (e) { return 0; } };
/** 用户开口了：上一轮到此为止，新的一轮从现在算。记下各个变更的 revisions.md 现在有几条：之后多出来的才是这一轮记的 */
function begin(j) {
  if (!j || !j.session_id) return;
  // 报告写到会话启动的那个目录里：模型单独 cd 过之后，钩子收到的 cwd 是它现在所在的目录（议题 #8：报告被写进了 子项目/ui/.vibe）
  const cwd = sessionHome(j);
  const revs = {};
  try { for (const c of listChanges(cwd)) revs[normKey(path.join(c.dir, 'revisions.md'))] = entryCount(path.join(c.dir, 'revisions.md')); } catch (e) { /* 数不了就按时间认 */ }
  writeState(keyOf(j), { round: Date.now(), cwd, items: [], revs, at: Date.now() });
}
/** 记一条。同一轮里同样的（种类、标题一样）只记一次，次数加一 */
function note(j, item) {
  if (!j || !j.session_id || !item || !item.kind) return;
  try {
    // 标题、说明里常常是命令的原文（"没让它跑：curl -H 'Authorization: Bearer …'"）：口令、令牌遮掉再记
    let redact = (s) => s;
    try { redact = require('./feedback.js').redact; } catch (e) { /* 老版本没有 */ }
    updateState(keyOf(j), (st) => {
      if (!st.round) { st.round = Date.now(); st.cwd = sessionHome(j); }
      const list = Array.isArray(st.items) ? st.items : [];
      const title = clip(redact(String(item.title == null ? '' : item.title)), 200);
      const detail = clip(redact(String(item.detail == null ? '' : item.detail)), 600);
      const old = list.find((x) => x.kind === item.kind && x.title === title);
      if (old) { old.times = (old.times || 1) + 1; old.at = Date.now(); if (item.detail) old.detail = detail; }
      else list.push({ kind: item.kind, title, detail, change: item.change || '', at: Date.now(), times: 1 });
      st.items = list.slice(-MAX_ITEMS);
      st.at = Date.now();
      return st;
    });
    hookLog('全自动报告 记了一条 ' + item.kind + '：' + clip(item.title, 60));
  } catch (e) { /* 记不了不影响干活 */ }
}
const stateOf = (j) => { const st = readState(keyOf(j)); return { round: st.round || 0, cwd: st.cwd || '', revs: st.revs && typeof st.revs === 'object' ? st.revs : null, items: Array.isArray(st.items) ? st.items : [], delivered: st.delivered || 0, deliveredCount: st.deliveredCount || 0, times: st.times || 0, file: st.file || '', finalAt: st.finalAt || 0 }; };

function git(root, args) {
  try { return execFileSync('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false'].concat(args), { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; }
}
function reposOf(cwd) {
  const out = [];
  let d = cwd;
  for (let i = 0; i < 12; i++) { if (fs.existsSync(path.join(d, '.git'))) { out.push(d); break; } const up = path.dirname(d); if (up === d) break; d = up; }
  try { for (const r of nestedRepos(cwd)) if (!out.some((x) => normKey(x) === normKey(r))) out.push(r); } catch (e) { /* 找不了子项目 */ }
  return out.slice(0, 12);
}
/**
 * revisions.md 里"起因：自动模式决定"的条目，这一轮记的。
 * 认法：这一轮开始时数过这个文件有几条（revs），之后多出来的就是这一轮记的；这一轮里新建的变更全算。
 * 没数过（全自动模式是中途打开的）才按标题里的时间认——模型常常不知道现在几点，标题里的日期会写错，所以不先用它
 */
function decisionsIn(file, since, revs) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const all = text.split(/^(?=##\s)/m).filter((b) => /^##\s/.test(b));
  const itemOf = (b) => ({ head: clip((b.match(/^##\s+(.+)$/m) || [])[1] || '', 80), why: clip((b.match(/起因\s*[:：]\s*(.+)/) || [])[1] || '', 160), did: clip((b.match(/改了\s*[:：]\s*(.+)/) || [])[1] || '', 160) });
  if (revs) {
    const base = Number(revs[normKey(file)]) || 0;
    return all.slice(Math.min(base, all.length)).filter((b) => /自动模式决定/.test(b)).map(itemOf);
  }
  const out = [];
  const undated = [];
  for (const b of all.filter((x) => /自动模式决定/.test(x))) {
    const head = (b.match(/^##\s+(.+)$/m) || [])[1] || '';
    const m = head.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})/);
    if (!m) { undated.push(itemOf(b)); continue; }
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
    if (!since || t >= since - 3600000) out.push(itemOf(b));
  }
  return out.concat(undated.slice(-3));
}
/** 一个变更现在到哪了。返回 { name, line（一句话）, open（还没做的）, waiting（留给用户的）, human（要人看的页面）, decisions } */
function changeView(c, since, revs) {
  const issue = c.todo === 0 ? codeReviewIssue(c.dir) : '';
  const state = [];
  state.push('任务 ' + c.done + '/' + c.total);
  // 多轮审查开着、上一轮报了问题还没复审的：不能说"审过了"
  let loop = null;
  try { if (readConfig().reviewLoop) { const x = readState('review-rounds')['code|' + normKey(c.dir)]; if (x && !x.done) loop = x; } } catch (e) { loop = null; }
  if (c.done === 0 && c.todo > 0) state.push(require('./review-runner').waived(c.dir, 'proposal') ? '用户明确跳过提案审查，还没开工' : proposalReviewed(c.dir) ? '提案审过，还没开工' : '提案还没审');
  else if (loop) state.push('代码审了 ' + loop.rounds + ' 轮，上一轮报了 ' + (loop.issues || 0) + ' 条，还没复审');
  else if (c.todo === 0) state.push(issue ? '代码还没审完' : '代码审过，等用户自测后归档');
  else if (reviewRecord('code', c.dir)) state.push('代码审过一次');
  let ticks = {};
  try { ticks = syncTicks(c.dir); } catch (e) { ticks = {}; }
  let text = '';
  try { text = fs.readFileSync(path.join(c.dir, 'tasks.md'), 'utf8'); } catch (e) { text = ''; }
  const open = []; const waiting = []; const human = [];
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(TASK_LINE);
    if (!m) continue;
    const body = m[3].trim();
    if (m[2] === ' ') { (isDeferredTask(body) ? waiting : open).push(clip(body, 100)); continue; }
    // 验法是"人工看"的任务：这一轮里打的勾才列出来，以前打的不重复说
    if (/^(人工|用户|你|我)/.test(verifyPartOf(body)) && (ticks[taskKey(body)] || 0) >= (since || 0) - 60000 && (ticks[taskKey(body)] || 0) > 0) human.push(clip(body, 100));
  }
  return { name: c.name, dir: c.dir, done: c.done, total: c.total, line: state.join('，'), open, waiting, human, decisions: decisionsIn(path.join(c.dir, 'revisions.md'), since, revs), decisionsAll: decisionCount(path.join(c.dir, 'revisions.md')) };
}
/** revisions.md 里一共有几条"起因：自动模式决定"（不分哪一轮记的） */
function decisionCount(file) {
  try { return fs.readFileSync(file, 'utf8').split(/^(?=##\s)/m).filter((b) => /^##\s/.test(b) && /自动模式决定/.test(b)).length; } catch (e) { return 0; }
}
/** 这个会话碰过、后来归档了的变更：[{ name, dir }] */
function archivedOf(j, since) {
  const out = [];
  const known = (readState(String(j.session_id) + '-changes').dirs) || [];
  for (const k of known) {
    if (fs.existsSync(k)) continue;
    const name = path.basename(k);
    const arch = path.join(path.dirname(k), 'archive');
    let hit = '';
    try { hit = fs.readdirSync(arch).filter((n) => n.toLowerCase() === name.toLowerCase() || n.toLowerCase().endsWith('-' + name.toLowerCase())).sort().pop() || ''; } catch (e) { hit = ''; }
    if (!hit) continue;
    let when = 0;
    try { when = fs.statSync(path.join(arch, hit)).mtimeMs; } catch (e) { when = 0; }
    if (since && when && when < since - 3600000) continue;
    out.push({ name, dir: path.join(arch, hit) });
  }
  return out;
}
/**
 * 全自动模式下它改过的库。查库的工具（ttls-db-crud）每做一次写操作，在 ~/.db-crud/journal/<连接名>/<时间>-<类型>/ 留一份：
 * op.json（哪张表、几行、是不是全自动做的、在哪个项目里、新增的主键）、before.json（改前快照）、undo.sql（还原脚本）。
 * 这一轮里、这个项目里、全自动做的那几次列出来。用户 2026-09-30 定的：全自动不拦改库，但改、删要有备份脚本，
 * 新增要记下表和主键——记下的东西得让他回来一眼看得到
 */
function dbWrites(cwd, since) {
  const out = [];
  const root = path.join(os.homedir(), '.db-crud', 'journal');
  const here = normKey(cwd);
  let conns = [];
  try { conns = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return out; }
  for (const c of conns) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, c)).sort(); } catch (e) { continue; }
    for (const n of names.slice(-300)) {
      // 目录名开头是时间（20260930-201204-886-update）：这一轮开始之前的不看
      const m = n.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (!m) continue;
      const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
      if (since && at < since - 60000) continue;
      const dir = path.join(root, c, n);
      let op = null;
      try { op = JSON.parse(fs.readFileSync(path.join(dir, 'op.json'), 'utf8')); } catch (e) { continue; }
      if (!op || op.auto !== true || !op.result || !op.result.ok || !op.project) continue;
      // 别的项目里（另一个窗口）做的不算这一份报告的
      const p = normKey(String(op.project));
      if (!(p === here || p.startsWith(here + '/') || here.startsWith(p + '/'))) continue;
      out.push({ at, conn: String(op.connection || c), kind: String(op.kind || ''), table: String(op.table || ''), rows: Number(op.result.affected_rows), dir, inserted: op.inserted || null, created: op.created || null, undone: fs.existsSync(path.join(dir, 'undone.json')), undo: fs.existsSync(path.join(dir, 'undo.sql')) });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-60);
}
/** 一次改库写成一行 */
function dbLine(w) {
  const home = os.homedir();
  const short = (p) => (normKey(p).startsWith(normKey(home) + '/') ? '~' + path.sep + path.relative(home, p) : p);
  const when = stamp(w.at).slice(11);
  const undoCmd = 'db.py --conn ' + w.conn + ' exec --undo "' + short(w.dir) + '"';
  const head = when + ' 连接 ' + w.conn + '：';
  if (w.created) return head + '建了 ' + (w.created.kind || '') + ' ' + (w.created.name || '') + (w.created.table ? '（表 ' + w.created.table + '）' : '') + '。还原脚本（对应的 DROP，要你自己看过再执行）：' + short(path.join(w.dir, 'undo.sql'));
  if (w.kind === 'INSERT') {
    const ins = w.inserted || {};
    const ids = Array.isArray(ins.ids) ? ins.ids : [];
    const shown = ids.slice(0, 8).map((one) => (one.length > 1 ? '(' + one.join(', ') + ')' : String(one[0]))).join('、');
    return head + '往 ' + w.table + ' 新增了 ' + (w.rows >= 0 ? w.rows : '?') + ' 行' + (ids.length ? '，主键 ' + (ins.pk || []).join('、') + '：' + shown + (ids.length > 8 ? ' 等 ' + ids.length + ' 行' : '') : '，主键没记下来') + '。'
      + (w.undone ? '已经还原（删掉）过了。' : ids.length ? '要删掉这次新增的：' + undoCmd : '要删的话照 ' + short(path.join(w.dir, 'op.json')) + ' 里那条语句的值去找');
  }
  const verb = w.kind === 'DELETE' ? '删了' : w.kind === 'UPDATE' ? '改了' : w.kind;
  return head + verb + ' ' + w.table + ' ' + (w.rows >= 0 ? w.rows : '?') + ' 行。改前快照和还原脚本在 ' + short(w.dir) + '。' + (w.undone ? '已经还原过了。' : w.rows > 0 ? '要还原：' + undoCmd : '');
}
const FRESH_MS = 3 * 86400000;
/**
 * 合成报告，写到 .vibe/reports/。返回 { file, text, brief（给模型看的短版）, counts, empty }。
 * mine 是这个会话碰过的变更（lib/session.js 的 sessionChanges 给的）；没给就看当前目录下所有没归档的
 */
function build(j, cfg, mine) {
  const st = stateOf(j);
  const cwd = path.resolve(st.cwd || sessionHome(j));
  const since = st.round || 0;
  const now = Date.now();
  const changes = (mine || listChanges(cwd)).map((c) => changeView(c, since, st.revs));
  const archived = archivedOf(j, since);
  // 归档之后目录挪了地方：开始时数的条数记在原来的路径上
  for (const a of archived) {
    const was = st.revs ? { [normKey(path.join(a.dir, 'revisions.md'))]: st.revs[normKey(path.join(path.dirname(path.dirname(a.dir)), a.name, 'revisions.md'))] || 0 } : null;
    a.decisions = decisionsIn(path.join(a.dir, 'revisions.md'), since, was);
  }
  const by = (k) => st.items.filter((x) => x.kind === k);
  const rel = (p) => { const r = path.relative(cwd, p); return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p).split(path.sep).join('/'); };

  // 留给用户的：没推的提交、留给用户的任务、等定位置的产出、钩子记的
  const hand = [];
  const commits = [];
  for (const r of reposOf(cwd)) {
    const name = path.basename(r);
    if (since) {
      const log = git(r, ['log', '--since=' + new Date(since - 60000).toISOString(), '--format=%h %s', '-n', '40']).split(/\r?\n/).filter(Boolean);
      if (log.length) commits.push({ repo: name, list: log });
    }
    const ahead = git(r, ['rev-list', '--count', '@{u}..HEAD']).trim();
    if (Number(ahead) > 0) hand.push('push：' + name + ' 有 ' + ahead + ' 个提交还没推到远端（进到 ' + rel(r) + ' 里执行 git push）');
  }
  for (const c of changes) for (const w of c.waiting) hand.push('任务（' + c.name + '）：' + w);
  const pending = [];
  for (const r of [cwd].concat(reposOf(cwd))) {
    const d = path.join(r, '.vibe', 'pending');
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of es) { const p = path.join(d, e.name); if (!pending.some((x) => normKey(x) === normKey(p))) pending.push(p); }
  }
  for (const p of pending.slice(0, 20)) hand.push('产出放哪还没定：' + rel(p) + '（定了位置告诉它，它会挪过去并记进项目说明）');
  for (const x of by('hand')) hand.push(x.title + (x.detail ? '：' + x.detail : ''));

  const unverified = by('unverified').map((x) => x.title + (x.detail ? '：' + x.detail : ''));
  for (const c of changes) for (const h of c.human) unverified.push('要你看一眼（' + c.name + '）：' + h);
  const asks = by('ask').map((x) => x.title + (x.detail ? '（选项：' + x.detail + '）' : '') + (x.times > 1 ? '，问了 ' + x.times + ' 次' : ''));
  const bypass = by('bypass').map((x) => stamp(x.at).slice(11) + ' ' + x.title + (x.detail ? '。理由：' + x.detail : ''));
  const secrets = by('secret').map((x) => x.title + (x.detail ? '：' + x.detail : ''));
  const decisions = [];
  for (const c of changes.concat(archived)) for (const d of c.decisions || []) decisions.push('（' + c.name + '）' + d.head + (d.why ? '。起因：' + d.why : '') + (d.did ? '。改了：' + d.did : ''));
  // 这一轮没有新定的、以前几轮定过的：说清楚，不能写成"revisions.md 里没有"（议题 #7：文件里明明有 7 条，是上一轮记的）
  const earlier = changes.filter((c) => (c.decisionsAll || 0) > (c.decisions || []).length).map((c) => c.name + ' ' + (c.decisionsAll - (c.decisions || []).length) + ' 条');
  const noDecision = earlier.length ? '这一轮没有新定的。以前几轮定过的还在各自的 revisions.md 里（起因：自动模式决定）：' + earlier.join('、') + '。' : '没有（revisions.md 里没有"起因：自动模式决定"的条目）。';
  let kit = [];
  try { kit = require('./feedback.js').sessionRecords(j.session_id).filter((r) => { const t = Date.parse(String(r.meta['更新'] || r.meta['时间'] || '').replace(' ', 'T')); return !since || !t || t >= since - 60000; }).map((r) => r.meta.id + ' ' + r.title); } catch (e) { kit = []; }
  // 这一轮里它改过的库：哪张表、几行、新增的主键、还原脚本在哪
  let db = [];
  try { db = dbWrites(cwd, since).map(dbLine); } catch (e) { db = []; }

  const counts = { done: changes.reduce((a, c) => a + (c.done || 0), 0), archived: archived.length, hand: hand.length, db: db.length, asks: asks.length, bypass: bypass.length, unverified: unverified.length, decisions: decisions.length, secrets: secrets.length, kit: kit.length, commits: commits.reduce((a, c) => a + c.list.length, 0) };
  const empty = !changes.length && !archived.length && !st.items.length && !hand.length && !commits.length && !kit.length && !db.length;

  const L = [];
  L.push('# 全自动报告（' + stamp(now) + '）');
  L.push('');
  L.push('- 项目：' + cwd);
  L.push('- 这一轮：' + (since ? stamp(since) : '（不知道从什么时候开始）') + ' 到 ' + stamp(now));
  L.push('- 这份报告是套件按实际情况写的，不是 AI 写的。AI 自己的交代在最后一节。');
  L.push('');
  L.push('## 数');
  L.push('');
  L.push('| 项 | 数量 |');
  L.push('|---|---|');
  L.push('| 归档的变更 | ' + counts.archived + ' |');
  L.push('| 这一轮的提交 | ' + counts.commits + ' |');
  L.push('| 留给你做的 | ' + counts.hand + ' |');
  L.push('| 库里改过的 | ' + counts.db + ' |');
  L.push('| 它想问你、没问成的 | ' + counts.asks + ' |');
  L.push('| 没验证的 | ' + counts.unverified + ' |');
  L.push('| 放行的检查 | ' + counts.bypass + ' |');
  L.push('| 它自己定的事 | ' + counts.decisions + ' |');
  L.push('| 套件问题 | ' + counts.kit + ' |');
  L.push('');
  const sec = (title, list, none) => { L.push('## ' + title); L.push(''); if (list.length) for (const x of list) L.push('- ' + x); else L.push(none || '没有。'); L.push(''); };
  L.push('## 变更做到哪');
  L.push('');
  if (!changes.length && !archived.length) L.push('这个会话没有碰过 OpenSpec 变更。');
  for (const a of archived) L.push('- ' + a.name + '：已归档（' + rel(a.dir) + '）');
  for (const c of changes) {
    L.push('- ' + c.name + '：' + c.line + (c.waiting.length ? '，留给你 ' + c.waiting.length + ' 项' : '') + (c.open.length ? '，还没做 ' + c.open.length + ' 项' : ''));
    for (const o of c.open.slice(0, 12)) L.push('  - 还没做：' + o);
  }
  L.push('');
  sec(TITLES.hand, hand);
  sec(TITLES.db, db, '没有改过库。');
  sec(TITLES.ask, asks, '没有。');
  sec(TITLES.unverified, unverified);
  sec(TITLES.bypass, bypass, '没有放行过。');
  if (secrets.length) sec(TITLES.secret, secrets);
  sec(TITLES.decision, decisions.length && earlier.length ? decisions.concat('以前几轮定过的不重复列：' + earlier.join('、') + '，在各自的 revisions.md 里。') : decisions, noDecision);
  L.push('## 这一轮的提交');
  L.push('');
  if (!commits.length) L.push('没有。');
  for (const c of commits) { L.push('- ' + c.repo); for (const l of c.list) L.push('  - ' + l); }
  L.push('');
  let issuePort = 15730;
  try { issuePort = require('../router/service').portOf(); } catch (e) { /* 无路由时保留默认详情地址 */ }
  const kitSummary = '套件问题 ' + kit.length + ' 条，[查看详情](http://127.0.0.1:' + issuePort + '/ui#sec-issues)。';
  sec('套件问题', kit.length ? [kitSummary] : [], '没有。');
  const text = L.join('\n');

  const dir = path.join(cwd, '.vibe', 'reports');
  let file = path.join(dir, '全自动报告-' + fileStamp(since || now) + '.md');
  // 同一个目录里两个会话在同一秒开始的一轮：名字一样。那个文件不是这个会话这一轮的，就在名字后面带上会话号，不去盖别人的
  try { if (fs.existsSync(file) && normKey(st.file || '') !== normKey(file)) file = path.join(dir, '全自动报告-' + fileStamp(since || now) + '-' + String((j && j.session_id) || 'x').replace(/[^\w-]/g, '').slice(0, 8) + '.md'); } catch (e) { /* 查不了就用原来的名字 */ }
  let written = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text + '\n## AI 最后的交代\n\n（还没交代）\n');
    written = true;
    try { ensureVibeIgnored(file); } catch (e) { /* 加不上不影响 */ }
    // 报告攒多了：三天前的只留最近 20 份
    const old = fs.readdirSync(dir).filter((n) => /^全自动报告-.*\.md$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - 20))) { try { if (now - fs.statSync(path.join(dir, n)).mtimeMs > FRESH_MS) fs.unlinkSync(path.join(dir, n)); } catch (e) { /* 删不掉就留着 */ } }
  } catch (e) { hookLog('全自动报告 写不了文件：' + ((e && e.message) || e)); }

  const top = (title, list, n) => (list.length ? title + ' ' + list.length + ' 件：' + list.slice(0, n).map((x) => clip(x, 90)).join('；') + (list.length > n ? ' 等' : '') + '。' : '');
  const brief = [
    (archived.length ? '归档了 ' + archived.map((a) => a.name).join('、') + '。' : '') + changes.map((c) => c.name + ' ' + c.line + (c.open.length ? '，还没做 ' + c.open.length + ' 项' : '') + '。').join(''),
    top(TITLES.hand, hand, 4), top(TITLES.db, db, 6), top(TITLES.ask, asks, 3), top(TITLES.unverified, unverified, 3), top(TITLES.bypass, bypass, 3), top(TITLES.secret, secrets, 2), top(TITLES.decision, decisions, 3), kit.length ? kitSummary : '',
  ].filter(Boolean).join('\n');
  return { file: written ? file : '', text, brief, counts, empty, itemCount: st.items.length };
}
/** 报告交给模型了：记下来，同一轮里没有新情况不再交第二次 */
function delivered(j, r) {
  updateState(keyOf(j), (st) => { st.delivered = Date.now(); st.deliveredCount = r.itemCount; st.times = (st.times || 0) + 1; st.file = r.file; st.finalAt = 0; return st; });
}
/** AI 最后的交代接到报告后面（同一份报告只接一次，后来又说的覆盖前面的） */
function saveFinal(j, said) {
  const st = stateOf(j);
  if (!st.file || !String(said || '').trim()) return false;
  try {
    const t = fs.readFileSync(st.file, 'utf8');
    const at = t.lastIndexOf('\n## AI 最后的交代');
    if (at < 0) return false;
    fs.writeFileSync(st.file, t.slice(0, at) + '\n## AI 最后的交代\n\n' + String(said).trim() + '\n');
    updateState(keyOf(j), (s) => { s.finalAt = Date.now(); return s; });
    return true;
  } catch (e) { return false; }
}

module.exports = { begin, note, stateOf, build, delivered, saveFinal, TITLES };
