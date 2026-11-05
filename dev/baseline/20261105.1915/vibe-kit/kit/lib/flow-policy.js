'use strict';
/*
 * 两阶段工作流：自动条件、审查点、人工 Ask 与提示去重。只保存套件本机状态，不把执行安排写进团队任务。
 * 审查时机（问题表第 57、58 条，用户 2026-11-05 定的，替代 2026-10-14 的"每个产物、每整组 1.x 各审一次"）：
 *   需求文档：四份写完审一次整套（审查点 tasks：它的输入本来就是四份文档，旧版审过的记录接着认）。
 *   代码：这个 change 的任务全部做完，审一次整个 change 的改动（审查点 change）。
 *   单份文档（proposal、specs、design）、做完的某一组（group-N）只有用户点名才审，不算必审的点。
 */
const fs = require('fs');
const path = require('path');
const S = require('./session');
const Sc = require('./review-scope');
const W = require('./workspace');
const T = require('./task-types');
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const key = (dir, point) => S.normKey(dir) + '|' + point;
// 没有 1.1 这种编号的任务归到前一个有编号的组，开头就没编号的算第 1 组（2026-10-17 审核问题 7：没编号时一个代码审查点都没有，自动审查走不通）
function groups(dir) {
  const out = new Map(); let last = '1';
  for (const t of T.tasks(dir).filter(t => !['review', 'review-fix', 'user', 'deferred'].includes(t.kind))) {
    const m = t.text.match(/^(\d+)\./); const id = m ? m[1] : last; last = id;
    if (!out.has(id)) out.set(id, []); out.get(id).push(t);
  }
  return [...out].map(([id, tasks]) => ({ id: 'group-' + id, tasks, done: tasks.every(t => t.done) }));
}
// 用户点名审某一组时只审任务里点了名的文件；整个 change 的审查点审开工基线以来的全部改动
const CHANGE = 'change';
const DOCS = ['proposal', 'specs', 'design', 'tasks'];
function namedFiles(dir, group) {
  const roots = S.projectRootsOf(dir); const code = new Set();
  for (const t of group.tasks) for (const token of S.pathTokens(t.text.split(/(?:验|验证|验收)\s*[:：]/)[0])) {
    for (const root of roots) { const f = path.resolve(root, token); const checked = W.pathStatus(f, root); if (checked.safe && !checked.missing && !/[\\/](?:openspec|\.vibe)[\\/]/.test(f)) code.add(f); }
  }
  return [...code];
}
/** 开工基线以来改过的代码文件（绝对路径）：和审查执行器取代码材料的范围一致，不含 .vibe、openspec。没有基线返回空 */
function changedCode(dir) {
  const saved = S.readState('work-baselines')[S.normKey(dir)]; if (!saved) return [];
  const out = [];
  for (const repo of saved.repos || []) {
    if (!repo.ref) continue;
    const files = W.git(repo.root, ['diff', '--name-only', '-z', repo.ref]).split('\0').concat(W.git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'));
    for (const f of new Set(files)) if (f && !/^(?:\.vibe|openspec)\//.test(f)) out.push(path.join(repo.root, f));
  }
  return out;
}
// 指纹不看的目录和文件，和 workspace.js 的 fingerprintOne 一样：构建输出变了不让审过的结论失效（复审 20261105 第 6 条）
const NOT_INPUT = /(^|[\\/])(\.vibe|router-data|node_modules|target|build|dist|out)([\\/]|$)|(^|[\\/])(secrets\.json|\.env(?:\.[^\\/]*)?)$/i;
/** 整个 change 的代码范围：任务点了名的文件，加开工基线以来改过的文件 */
function changeFiles(dir) {
  const out = new Map();
  for (const g of groups(dir)) for (const f of namedFiles(dir, g)) out.set(S.normKey(f), f);
  for (const f of changedCode(dir)) if (!NOT_INPUT.test(f)) out.set(S.normKey(f), f);
  return [...out.keys()].sort().map((k) => out.get(k));
}
/** 一个文件的指纹：太大的不读内容，看大小和修改时间 */
function fileRow(f) {
  try { const st = fs.statSync(f); return st.size > 8 * 1024 * 1024 ? [S.normKey(f), st.size, st.mtimeMs] : [S.normKey(f), W.hash(fs.readFileSync(f))]; } catch (e) { return [S.normKey(f), '缺失']; }
}
/**
 * 跨 change 的修改点（用户 2026-11-03 定的）：别的 change 的 revisions.md "影响 change"列到这个 change 的，算这个 change 的一个审查点，
 * 只审那处修改对它的影响。没列的靠全面自测。这个 change 还没做出代码的不算。指纹只看那一节，改代码不会把审过的点又打开。
 */
function crossPoints(dir) {
  try {
    const B = require('./big-task'); const name = path.basename(dir);
    const task = B.ofChange(path.resolve(dir, '../../..'), name); if (!task) return [];
    const out = [];
    for (const c of task.changes) {
      if (c.name === name || !c.exists) continue;
      let text = ''; try { text = fs.readFileSync(path.join(c.dir, 'revisions.md'), 'utf8'); } catch (e) { continue; }
      for (const sec of text.split(/^(?=##\s)/m)) {
        const m = /影响 change\s*[:：]\s*(.+)/.exec(sec);
        if (m && m[1].split(/[、,，\s]+/).includes(name)) out.push({ id: 'cross-' + c.name + '-' + W.hash(sec).slice(0, 8), from: c.name, text: sec.trim() });
      }
    }
    return out;
  } catch (e) { return []; }
}
const isCross = (point) => /^cross-/.test(String(point || ''));
function crossText(dir, point) { const c = crossPoints(dir).find((x) => x.id === point); return c ? c.from + ' 的修改：\n' + c.text : ''; }
/** 写好了哪几份需求文档（按顺序）。写好不等于要审：要审的点看 points */
function written(dir) {
  const files = S.artifactFiles(dir);
  return DOCS.filter(p => files.some(f => p === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === p + '.md'));
}
/** 必审的点。需求文档：tasks 写了才有，审整套。代码：任务全部做完才有 */
function points(dir, mode) {
  if (mode === 'code') { const all = groups(dir); return all.length && all.every(g => g.done) ? [CHANGE].concat(crossPoints(dir).map((c) => c.id)) : []; }
  return written(dir).includes('tasks') ? ['tasks'] : [];
}
/** 能审的点：必审的，加上用户点名才审的单份文档、做完的组 */
function reviewable(dir, mode) {
  if (mode === 'code') return groups(dir).filter(g => g.done).map(g => g.id).concat(points(dir, 'code'));
  return written(dir);
}
function pointFiles(dir, point) {
  const files = S.artifactFiles(dir).filter(f => !/revisions\.md$/.test(f));
  const rank = DOCS.indexOf(point);
  if (rank >= 0) return files.filter(f => { const p = /[\\/]specs[\\/]/.test(f) ? 'specs' : path.basename(f, '.md'); return DOCS.indexOf(p) >= 0 && DOCS.indexOf(p) <= rank; });
  // 整个 change：材料取开工基线以来的全部改动，不按文件筛
  if (point === CHANGE || isCross(point)) return [];
  const group = groups(dir).find(g => g.id === point); if (!group) return files;
  return namedFiles(dir, group);
}
function fingerprint(dir, point) {
  if (isCross(point)) return W.hash(JSON.stringify([point, crossText(dir, point)]));
  // 整个 change：文档和任务一段、代码一段，sameInput 要分开比
  if (point === CHANGE) {
    // 一次钩子调用里只算一次：要跑 git、读文件，settled、instruction 会反复问
    return require('./invocation').memo('change-fingerprint|' + S.normKey(dir), () => {
      const plan = W.hash(JSON.stringify([groups(dir).map(g => g.tasks.map(t => t.text)), pointFiles(dir, 'design').map(f => [S.normKey(f), W.hash(read(f))])]));
      const files = changeFiles(dir);
      return plan + ':' + (files.length ? W.hash(JSON.stringify(files.map(fileRow))) : W.fingerprint(dir, 'code').hash);
    });
  }
  const group = groups(dir).find(g => g.id === point); const files = pointFiles(dir, point);
  const rows = files.map(f => [S.normKey(f), W.hash(path.basename(f) === 'tasks.md' ? W.progressText(read(f)) : read(f))]);
  if (group) {
    rows.push(['任务', group.tasks.map(t => t.text)]);
    for (const f of pointFiles(dir, 'design')) rows.push([S.normKey(f), W.hash(read(f))]);
    if (!files.length) rows.push(['代码', W.fingerprint(dir, 'code').hash]);
  }
  return W.hash(JSON.stringify(rows));
}
// 记录带着变更目录的创建时间：旧变更归档后新建同名变更，路径一样，不能接着用旧轮数（2026-10-17 审核问题 5）。没有 born 的旧记录照认
function live(dir, r) { return r && (!r.born || r.born === S.changeBorn(dir)) ? r : {}; }
function record(dir, point) { return live(dir, S.readState('review-points')[key(dir, point)]); }
// 没有 P1、P2 就算过（问题表第 37 条，用户 2026-11-02 定的）：P3 记在审查记录里，不为它再审一轮。升级前的记录没有 blocking，按总数算
const blockingOf = (r) => (r.blocking === undefined ? Number(r.issues) || 0 : Number(r.blocking) || 0);
/**
 * 这个变更开工之后，同一个项目里又有别的变更开工了。工作区的改动从这时起算后面那个变更的：
 * 前面的 change 审过之后不因为它重开，跨 change 的影响走 revisions.md 的"影响 change"和全面自测（用户 2026-11-03 定的）
 */
function laterStarted(dir) {
  const all = S.readState('work-baselines'); const k = S.normKey(dir); const me = all[k];
  if (!me) return false;
  const roots = new Set((me.repos || []).map(r => S.normKey(r.root)));
  // 目录不在的（归档了、删了）不算：做完归档了的热修不该让这个 change 的改动从此不再复审（复审 20261105 第 4 条）
  return Object.keys(all).some(o => o !== k && all[o] && (Number(all[o].at) || 0) > (Number(me.at) || 0) && (all[o].repos || []).some(r => roots.has(S.normKey(r.root))) && fs.existsSync(o));
}
/** 旧版按组审完的 change：每组都过了；没点名的文件有改动的，还要 group-rest 审过（2026-10-17 审核问题 6：不能把没审的记成审过） */
function reviewedByGroups(dir) {
  const all = groups(dir);
  if (!all.length || !all.every(g => settled(dir, g.id))) return false;
  const named = new Set();
  for (const g of all) { const files = namedFiles(dir, g); if (!files.length) return true; files.forEach(f => named.add(S.normKey(f))); } // 有一组一个文件都没点名：那一组审的就是全部改动
  if (!changedCode(dir).some(f => !NOT_INPUT.test(f) && !named.has(S.normKey(f)))) return true;
  const rest = record(dir, 'group-rest');
  return rest.status === 'resolved' || rest.status === 'completed' && blockingOf(rest) === 0;
}
/** 审过的输入和现在一样吗。整个 change 的点：后面的变更开工了只比文档和任务，代码那一段不比 */
function sameInput(dir, point, saved) {
  const now = fingerprint(dir, point);
  if (saved === now) return true;
  return point === CHANGE && !!saved && String(saved).split(':')[0] === now.split(':')[0] && laterStarted(dir);
}
function passed(dir, point) { const r = record(dir, point); return r.status === 'completed' && blockingOf(r) === 0 && sameInput(dir, point, r.fingerprint) && require('./review-runner').inputsCurrent(r.materialInputs); }
function settled(dir, point) {
  const r = record(dir, point);
  if (passed(dir, point) || r.status === 'resolved' && sameInput(dir, point, r.resolvedFingerprint) && require('./review-runner').inputsCurrent(r.materialInputs)) return true;
  // 旧版按组审完的 change（或者用户点名把每组都审了）不再整个重审一遍
  return point === CHANGE && !r.status && reviewedByGroups(dir);
}
const modeOfPoint = (p) => (DOCS.includes(p) ? 'proposal' : 'code');
/**
 * 子代理连续 3 次拿不到结论（用户 2026-11-03 定的）：不再催，不算通过，也不挡提交、不挡往下一组走；收工报告里写着没审成。用户自己说审，照样能审，审成了清零。
 * 审出问题不算：P1、P2 审修不设上限，出口只有没有 P1、P2、逐条处理完（resolve，驳回要写依据）、用户说提交。
 */
function halted(dir, point) { const r = record(dir, point); return (r.failStreak || 0) >= 3 && !settled(dir, point); }
function pending(dir, mode) { return points(dir, mode).find(p => !settled(dir, p) && !halted(dir, p)) || ''; }
/**
 * 这个点的审查"没收尾"：审出了问题、还没处理完。提交等它收尾（审查过程不进提交）。
 * 审过（零问题或处理完）之后代码又改了的不算没收尾（问题表第 25 条，2026-10-31）：以前也算，任务全勾完后改用户报的 bug，
 * 人工模式下用户不让重审，提交方式"自动"就永远提交不了
 */
// 会话开着自动时，"修了、还没复审"（needs_review）也算没收尾：自动会接着复审，等它审完一起提交（复审 V6）。人工模式不算：用户不让复审时会一直提交不了（第 25 条）
function fixPending(dir, point, cfg) {
  const r = record(dir, point);
  const open = r.status === 'completed' && blockingOf(r) > 0 || r.status === 'needs_review' && !!(cfg && cfg.autoMode);
  // 用户点名审的组：整个 change 审过了就不算没收尾（自动模式不会再回去复审那一组）
  if (open && /^group-/.test(String(point)) && settled(dir, CHANGE)) return false;
  return open && !settled(dir, point) && !halted(dir, point);
}
function allPassed(dir, mode) { const ps = points(dir, mode); return ps.length > 0 && ps.every(p => settled(dir, p)); }
/** 每个点都有结果了：过了，或者子代理连续没交结论停了（自动模式靠它往下走，没过的写进报告） */
function allDone(dir, mode) { const ps = points(dir, mode); return ps.length > 0 && ps.every(p => settled(dir, p) || halted(dir, p)); }
// rounds 只记录，不限次数（用户 2026-11-03 定的）：轮数只数"审出问题、修了再审"这一串，上一轮零问题通过了，这次重审从头数。
function concluded(r) { return r.status === 'completed' && blockingOf(r) === 0; }

function begin(dir, point, id, inputHash) {
  S.updateState('review-points', o => { const k = key(dir, point); const previous = live(dir, o[k]); const base = concluded(previous) ? 0 : previous.rounds || 0; o[k] = { rounds: base + 1, status: 'running', key: id, fingerprint: inputHash, born: S.changeBorn(dir), at: Date.now(), failStreak: previous.failStreak || 0 }; });
}
function noteResult(dir, point, result, inputHash) {
  S.updateState('review-points', o => {
    const k = key(dir, point); const previous = live(dir, o[k]);
    const rounds = previous.key === result.id && previous.status === 'running' ? previous.rounds || 1 : (concluded(previous) ? 0 : previous.rounds || 0) + 1;
    const block = Sc.blocking(result.issues);
    // 审成了清零；没审成（材料有问题、部分覆盖）算一次，取消、审查期间文件变了不算
    const failStreak = result.status === 'completed' ? 0 : ['failed', 'partial'].includes(result.status) ? (previous.failStreak || 0) + 1 : previous.failStreak || 0;
    o[k] = { rounds, status: result.status, issues: result.issues.length, blocking: block, failStreak, fingerprint: inputHash, report: result.file, key: result.id, materialInputs: result.materialInputs, born: S.changeBorn(dir), at: Date.now() };
  });
}
/** 子代理没交结论：一轮记一次（roundId 同一个的不重复记）。一轮 3 个角度都被打断也只算一次（复审 20261104 R2） */
function noteFail(dir, point, roundId) { S.updateState('review-points', o => { const k = key(dir, point); if (!o[k]) return; if (roundId && o[k].failRound === roundId) return; o[k].failRound = roundId || ''; o[k].failStreak = (o[k].failStreak || 0) + 1; }); }
/**
 * 开着自动、需求文档审修完：直接开工（第 41 条：以前有一个条件不满足就落到"问能不能开工"）。
 * 探索记录要写完（老会话 planReady 还认）；当前 change 按大任务的表算，几个 change 也能开工。
 * 提交方式是"自动"的等提交一次（planNext 催），提交不成也往下走；关、询问不等（用户 2026-11-03 定的）。
 */
function automaticApply(j) {
  const cfg = S.readConfig(j); const st = S.flowState(j);
  if (!cfg.autoRequirements || !cfg.autoApply || st.stage !== 'plan' || st.waiting || st.paused || st.holdApply) return false;
  const B = require('./big-task');
  const task = B.forSession(j);
  let c = null;
  if (task) {
    if (cfg.autoSession === true ? B.exploreOpen(task) : B.exploreIssues(task).length) return false;
    const name = B.phaseFor(j, task).change;
    c = name ? S.allChanges(j.cwd).find((x) => x.name === name) : null;
  } else if (st.planReady || cfg.autoSession === true) {
    const changes = S.allChanges(j.cwd).filter((x) => S.flowChanges(j).includes(S.normKey(x.dir)));
    if (changes.length === 1) c = changes[0];
  }
  if (!c || written(c.dir).length !== 4 || !allDone(c.dir, 'proposal')) return false;
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  if (inGit(root) && S.commitModeOf(cfg) === 'auto' && j.session_id && S.readState(j.session_id + '-workflow-prompts')['plan-commit|' + c.dir] !== fingerprint(c.dir, 'tasks')) {
    try { if (!W.checkedGit(root, ['ls-files', '--', rel + '/tasks.md']).trim() || W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim()) return false; } catch (e) { /* 查不了就不等 */ }
  }
  if (!require('./apply-scope').grant(j, c.name, '').ok) return false;
  S.setFlow(j, true, '自动：文档审修完开工', 'apply'); return true;
}
/**
 * 这个 change 的任务是这个会话碰它之前就勾完的（早做完的旧 change，这一轮只改了它的规格、revisions）：没有代码要审，不催（第 69 条）。
 * 已经开始审的接着审；跨 change 的影响走 revisions.md 的"影响 change"。记录里没有碰它的时间的（升级前开着的会话）照旧
 */
function oldDone(j, dir) {
  const st = S.flowState(j);
  const at = (st.touchedAt || {})[S.normKey(dir)];
  if (!at || record(dir, CHANGE).status || st.current === path.basename(dir)) return false;
  const all = T.tasks(dir);
  if (!all.length || T.automatedLeft(dir).length) return false;
  try {
    if (fs.statSync(path.join(dir, 'tasks.md')).mtimeMs >= at) return false;
    // 碰过之后又改了代码的不算旧（修用户报的问题）。后面的 change 开工了，工作区的改动算它的
    if (!laterStarted(dir) && changedCode(dir).some((f) => { try { return fs.statSync(f).mtimeMs >= at; } catch (e) { return true; } })) return false;
    return true;
  } catch (e) { return false; }
}
/** 开着自动、写需求这一段还没生效的原因：探索记录没写完。说清缺什么，不让用户"看一看"（第 67 条）。不是这个原因的返回 '' */
function autoBlocked(j) {
  try {
    const B = require('./big-task'); const t = B.forSession(j);
    const left = t && B.exploreOpen(t) ? B.exploreIssues(t) : [];
    return left.length ? '这个会话开着自动，但探索还没完：' + left.join('；') + '。写进探索记录，自动才生效，然后接着写到 tasks；有疑问用提问框问。不用停下来等用户看文档。' : '';
  } catch (e) { return ''; }
}
/** 往上找得到 .git（目录或 worktree 的文件）才算在 git 仓库里；不调 git，出错不会被当成"不是仓库" */
function inGit(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) return true; if (path.dirname(d) === d) return false; }
}
/** 这一轮用户在写完 tasks 那一问里怎么选的（用户 2026-10-30 定的：定稿和开工合成一问）：'go' 定稿并开工、'only' 只定稿、'' 没选 */
function finalizeChoice(j) {
  let out = '';
  try {
    for (const v of S.turnVoices(entriesOf(j))) {
      const t = v.kind === 'answer' ? v.answers.map((a) => a.a).join('；') : String(v.text || '');
      if (/定稿并开工|定稿[，,、\s]*(?:然后|再|就)?开工/.test(t)) out = 'go';
      // 旧选项"就这样定稿"不算：旧流程里选完还要再问开工，照旧问
      else if (/只定稿|先定稿/.test(t)) out = 'only';
    }
  } catch (e) { out = ''; }
  return out;
}
function planNext(j, c) {
  // 开着自动不问开工（第 41 条）：能开工的 automaticApply 已经开了，这里只催"自动"档提交一次
  const cfgNow = S.readConfig(j); const auto = cfgNow.autoRequirements && cfgNow.autoApply;
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  // 壳子本身可以不是 git 仓库（openspec 在壳子根，代码在子项目）：没有可提交的，直接问开工（2026-10-17 审核问题 12）
  const git = inGit(root); let dirty = '';
  if (git) { try { dirty = W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim(); } catch (e) { return ''; } }
  if (dirty) {
    // 提交方式（用户 2026-10-17 定的）：自动——提交一次；询问——问用户一次；关——不提交。问过、不提交的接着给开工选项（审核问题 2：不能自己提交）
    const mode = S.commitModeOf(S.readConfig());
    const msg = mode === 'off' || (mode === 'ask' && auto) ? '' : once(j, 'plan-commit|' + c.dir, fingerprint(c.dir, 'tasks'), mode === 'ask'
      ? '同一套需求文档已定稿。提交方式是"询问"：用 Ask 问用户是否提交 docs: 提案 ' + c.name + '（选项"提交定稿"和"先不提交"），用户说提交再提交；' + (finalizeChoice(j) === 'go' ? '用户在定稿那一问里已经选了"定稿并开工"，提交这一问答完就开工，不再问开工。' : finalizeChoice(j) === 'only' ? '用户选的是"只定稿"，不开工、也不再问开工。' : '然后给出开工选项。')
      : '同一套需求文档已定稿，提交本变更的产物和用例一次 docs: 提案 ' + c.name + '。');
    if (msg) return msg;
    if (mode === 'auto') return '';
  }
  if (auto || S.flowState(j).holdApply) return '';
  const done = !git ? '文档已经定稿（' + c.name + ' 所在的目录不是 git 仓库，没有要提交的）。' : dirty ? '文档已经定稿（还没提交，提不提交由用户定）。' : '文档已经定稿提交。';
  // 定稿和开工合成一问（用户 2026-10-30 定的，审核第四节第 10 条）：用户在定稿那一问里选过的，不再另问开工
  const fin = finalizeChoice(j);
  if (fin === 'only') return '';
  if (fin === 'go') return once(j, 'plan-go|' + c.dir, fingerprint(c.dir, 'tasks'), done + '用户在定稿那一问里选了"定稿并开工"：直接开工（/opsx:apply ' + c.name + '），不再问开工。');
  return once(j, 'plan-apply|' + c.dir, fingerprint(c.dir, 'tasks'), done + '用提问框问能不能开工（选项写"开工""还要改""先不做"）。');
}
function instruction(dir, point) {
  const mode = modeOfPoint(point); const rec = record(dir, point);
  if (halted(dir, point)) return '审查点 ' + point + ' 的子代理连续 ' + rec.failStreak + ' 次没交结论，不再催：这个点算没审过，收工报告里写明"' + point + ' 没审成"；用户说审再审。';
  const what = point === 'tasks' ? '四份需求文档写完了，审一次整套。' : point === CHANGE ? '这个 change 的任务全部做完了，审一次整个 change 的改动。' : '';
  return what + '审查点 ' + point + '：执行 review.js prepare --change ' + path.basename(dir) + ' --mode ' + mode + ' --point ' + point + '，照输出开 vk-reviewer 子代理。自动核验、修改、复验，第二轮起只审改过的地方，没有 P1、P2 就算过。需求变化先沟通并同步相关产物和用例。';
}
function entriesOf(j) { return j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : []; }
function explicit(j, action) { return S.userSaid(entriesOf(j), action).ok; }
// 提示只记发过哪条，不生成“未审查/未测试”任务，也不登记放弃状态。
function oncePrompt(j, id, signature, text) { return once(j, id, signature, text); }
function once(j, id, signature, text) {
  if (!j.session_id) return text;
  let fresh = false; S.updateState(j.session_id + '-workflow-prompts', o => { if (o[id] !== signature) { o[id] = signature; fresh = true; } });
  return fresh ? text : '';
}
// 人工模式的提示每个用户要求最多问一次（用户 2026-10-16 定的）：同一个要求里后面又改了也不再问，只把记下的内容跟到最新；
// 用户提新要求时，内容比上次记下的又变了才再问。turn 是这一轮用户消息的编号，取不到时只按内容判断。
function askOnce(j, id, signature, turn, text) {
  if (!j.session_id) return text;
  let fresh = false;
  S.updateState(j.session_id + '-workflow-prompts', o => {
    const prev = typeof o[id] === 'string' ? { sig: o[id], turn: '' } : o[id] || null;
    if (turn && prev && prev.turn === turn) { prev.sig = signature; o[id] = prev; return; }
    if (!prev || prev.sig !== signature) { o[id] = { sig: signature, turn: turn || '' }; fresh = true; }
  });
  return fresh ? (typeof text === 'function' ? text() : text) : '';
}
// quickPending：改了代码、最后一次修改之后还没跑过快检（verify-gate 算）。这时一起问要不要跑快检，不强制（用户 2026-10-16 定的）
const QUICK_ASK = '跑快检（项目说明里的快检命令，编译级；这个命令本身要跑测试的，问的时候说明）、要不要';
/** 这一份需求文档自己的文件最后一次写入的时间 */
function writtenAt(dir, point) {
  const own = pointFiles(dir, point).filter(f => point === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === point + '.md');
  return Math.max(0, ...own.map(f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }));
}
// 用户说不要之后（v 是那一次开口），at 这个时间点的改动还在不在那之前：在之前就别再问（#220）
const stillDeclined = (v, at) => !!v && !(Number(at) > (Number(v.at) || 0));
/** 这个会话在做任务那一段，dir 又是当前该做的 change（不是大任务的按这一段算）：一项都还没勾也算在做 */
function applyingNow(j, dir) {
  if (S.flowStage(j) !== 'apply') return false;
  const B = require('./big-task');
  const task = B.forSession(j);
  return !task || B.phaseFor(j, task).change === path.basename(dir);
}
/** lastEditAt：这一轮最后一次改代码、页面的时间（收工检查算），用户说不用审、不用测之后又改了才再问 */
function stop(j, touched, codeChanged, turn, quickPending, lastEditAt) {
  const quick = () => typeof quickPending === 'function' && quickPending() ? QUICK_ASK : '';
  const cfg = S.readConfigFor(j); const out = [];
  // 这一轮用户最后的表态是不审、不测（提问框选了"就这样定稿""直接写下一份""不用"，或者原话说了不用）：那一份不再问
  const noReview = cfg.autoMode ? null : S.userDeclined(entriesOf(j), 'review');
  const noTest = cfg.autoMode ? null : S.userDeclined(entriesOf(j), 'test');
  const dirs = [...new Set([...touched, ...S.flowChanges(j)].filter(d => fs.existsSync(d)))];
  for (const dir of dirs) {
    // 自动下每个 change 按自己走到哪算（回改前面的 change、接下一个时，几个 change 不在同一段）
    const mode = cfg.autoMode ? (S.changeStarted(dir) || applyingNow(j, dir) ? 'code' : 'proposal') : S.flowStage(j) === 'apply' ? 'code' : 'proposal';
    if (oldDone(j, dir)) continue;
    // 子代理连续没交结论的点：说一次不再催、写进报告，接着往下
    if (cfg.autoMode) for (const p of points(dir, mode).filter((x) => halted(dir, x))) { const m = once(j, key(dir, p) + '|limit', fingerprint(dir, p) + ':' + (record(dir, p).failStreak || 0), instruction(dir, p) + '接着往下做。'); if (m) out.push(m); }
    // 有角度正在跑（2.1.259 起子代理在后台）：不催，也别再开一个
    if (require('./review-runner').inFlight(dir, mode)) continue;
    // 开着自动、这一段没生效（探索记录没写完、用户说了停）：不当人工那样让用户看一看（第 67 条）
    if (!cfg.autoMode && cfg.autoSession === true && mode === 'proposal') { const why = autoBlocked(j); const m = why ? once(j, key(dir, 'auto-blocked'), why, why) : ''; if (m) out.push(m); continue; }
    // 自动写需求：tasks 写完才审，中间不审、不停（问题表第 57 条）。模型停下了就催它接着写，同一份内容只催一次
    const docs = mode === 'proposal' ? written(dir) : [];
    if (cfg.autoMode && mode === 'proposal' && docs.length && !docs.includes('tasks')) {
      const nextDoc = DOCS.find(p => !docs.includes(p));
      const msg = once(j, key(dir, 'next-doc'), docs.join() + ':' + fingerprint(dir, docs[docs.length - 1]), '自动模式：接着写下一份 ' + nextDoc + '（openspec instructions ' + nextDoc + ' --change "' + path.basename(dir) + '"），写到 tasks 再审一次整套，中间不审、不停。');
      if (msg) out.push(msg);
      continue;
    }
    // 人工写需求：tasks 没写的看最新写的那一份（提醒看一看），写了的看整套（问要不要审）
    const manualPoint = () => (mode === 'code' ? points(dir, mode).slice().reverse().find(p => !settled(dir, p)) : docs.includes('tasks') ? (settled(dir, 'tasks') ? '' : 'tasks') : docs[docs.length - 1]);
    const point = cfg.autoMode ? pending(dir, mode) : manualPoint();
    if (!point) continue;
    if (!cfg.autoMode && (mode === 'proposal' ? stillDeclined(noReview, writtenAt(dir, point)) : stillDeclined(noReview, lastEditAt) && stillDeclined(noTest, lastEditAt))) {
      // 记成问过了：同一份内容以后也不再问
      askOnce(j, key(dir, point), fingerprint(dir, point), turn, '');
      continue;
    }
    // 代码审查点：这一轮用户已经说了审查、自测，收工不再提示去问（审核第四节第 2 条）；没做的由用户的原话管，不靠这里催
    if (!cfg.autoMode && mode === 'code' && S.userSaid(entriesOf(j), 'review').ok && S.userSaid(entriesOf(j), 'test').ok) continue;
    if (!cfg.autoMode) {
      // 壳子里几个子项目可能有同名变更：变更不在会话启动的那个项目里时，带上项目的相对路径
      const root = path.resolve(dir, '../../..'); const rel = path.relative(path.resolve(j.cwd || root), root).replace(/\\/g, '/');
      const name = '当前 ' + path.basename(dir) + (rel ? '（' + rel + '）' : '');
      const where = name + ' 的 ' + point;
      const after = '选择放弃就继续，不写未审查或未测试记录、不催补做。审查后先展示全部问题，再用一个提问框逐条选（一条一个问题，一框最多 4 条，多了分几框）：改（推荐）/不改/自行输入；用户选了"改"的，改完直接复验，不再问；没选"改"的复验，这一轮用户已经要求过的直接做，没要求过的先问。';
      // 需求文档一份一份来（用户 2026-10-17 定的）：写完一份停下提醒用户看一看，引导下一步，用户选了才写下一份；中间不问审查，tasks 写完才问（用户 2026-11-05 定的）
      const nextDoc = DOCS[DOCS.indexOf(point) + 1];
      const msg = askOnce(j, key(dir, point), fingerprint(dir, point), turn, () => mode === 'code'
        ? (point === CHANGE ? name + ' 的任务全部做完了' : where + ' 已完成') + '。用一个提问框问，一件事一个问题：要不要' + quick() + '审查、要不要按验收用例自测；用户已明确要求的直接执行。' + after
        : point === 'tasks'
          ? name + ' 的四份需求文档写完了（proposal、specs、design、tasks）。交代写了什么，用 Ask 问要不要审整套（选项写"审一下""定稿并开工""只定稿""我要改"；定稿和开工在这一问里一起定，不再另问开工），用户已明确要求审查的直接审。' + after
          : where + ' 写完了。停下提醒用户看一看：交代写了什么、哪里要留意，用 Ask 引导下一步（选项写"写下一份（' + nextDoc + '）""我要改"）。这里不问审查，四份写完再问；用户自己说审的照做。');
      if (msg) out.push(msg);
    } else { const msg = once(j, key(dir, point), fingerprint(dir, point) + ':' + (record(dir, point).rounds || 0) + ':' + (record(dir, point).failStreak || 0), instruction(dir, point)); if (msg) out.push(msg); }
  }
  // 人工模式、不在 OpenSpec 任务组里的代码改动：改完问一次审查、自测。用户答了不用，这个会话后面再改代码不再问那一样
  // （用户 2026-10-30 定的，替代 2026-10-16"新要求、内容变了才再问"）。验收用例只写在走 OpenSpec 的 design.md 里，这里只说自测（审核第三节第 7 条）
  // /vk-fix（小改动快车道，用户 2026-10-30 定的斜杠命令）这一轮：不问审查、自测，命令里写明了最后只问一次提交
  const vkFix = (() => { try { return S.turnVoices(entriesOf(j)).some((v) => (v.kind === 'command' && /^vk-fix$/i.test(String(v.command || ''))) || /^\s*\/vk-fix\b/i.test(String(v.text || ''))); } catch (e) { return false; } })();
  if (!cfg.autoMode && codeChanged && !dirs.length && !explicit(j, 'test') && !vkFix) {
    const keyD = j.session_id && j.session_id !== 'unknown' ? String(j.session_id) + '-plain-declined' : '';
    let sess = keyD ? S.readState(keyD) : {};
    if (keyD && ((noReview && !sess.review) || (noTest && !sess.test))) { S.updateState(keyD, (o) => { if (noReview && !o.review) o.review = Date.now(); if (noTest && !o.test) o.test = Date.now(); }); sess = S.readState(keyD); }
    const askReview = !sess.review && !stillDeclined(noReview, lastEditAt);
    const askTest = !sess.test && !stillDeclined(noTest, lastEditAt);
    if (askReview || askTest) {
      const what = askReview && askTest ? '审查、要不要自测' : askReview ? '审查' : '自测';
      const msg = askOnce(j, 'plain-test', W.fingerprint(j.cwd, 'code').hash, turn, () => { const q = quick(); return '本次代码已修改' + (q ? '，最后一次修改之后还没跑过快检' : '') + '。用一个提问框问，一件事一个问题：要不要' + q + what + '；用户说不用就直接继续，这个会话里不再问这一样，不记待办、不反复提醒。'; }); if (msg) out.push(msg);
    }
  }
  return out;
}
/**
 * 这条命令真的在备审查：拆开的命令段里有"node <套件的 tools/review.js> prepare"（run 是别名）。以前对整条命令文字匹配，
 * 记问题反馈、写提交信息时正文里引用了这几个字也被当成要审查（旧第 5 类，#187 第 6 点；同类的 #153 只改了审查预算那一处）
 */
function reviewRun(j, cmd, ps) {
  if (!/review\.js/i.test(cmd)) return false;
  try {
    const G = require('../hooks/guard-commit');
    for (const seg of G.splitCommand(G.preprocess(cmd, ps).s, ps).flat()) {
      const ws = G.words(G.scanRedirects(seg).rest, ps).map(w => String(w.text));
      let k = 0;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k] || '')) k++;
      if (!/^node(?:\.exe)?$/i.test(path.basename(String(ws[k] || '').replace(/\\/g, '/')))) continue;
      const script = String(ws[k + 1] || '');
      if (!/(?:^|[\\/])review\.js$/i.test(script)) continue;
      // 认套件的那份；路径里带着套件目录名的也算（写的是 $HOME/.claude/vibe-kit/tools/review.js 这类）
      const kitOwn = S.normKey(path.resolve(j.cwd || process.cwd(), S.expandHome(script))) === S.normKey(path.join(S.KIT, 'tools/review.js')) || /vibe-kit[\\/]+tools[\\/]+review\.js$/i.test(script);
      if (kitOwn && ['run', 'prepare'].includes(ws[k + 2])) return true;
    }
  } catch (e) { return /review\.js["']?\s+(?:run|prepare)\b/.test(cmd); }
  return false;
}
function actionIssue(j) {
  const cfg = S.readConfigFor(j); let inp = j.tool_input || {}; let name = String(j.tool_name || '');
  const cmd = String(inp.command || '');
  const runsReview = /^(Bash|PowerShell)$/.test(name) && reviewRun(j, cmd, name === 'PowerShell');
  const reviewer = /^(Agent|Task)$/.test(name) && /(?:vk|ttls|vibe)-reviewer/.test(inp.subagent_type || '');
  const reviewTask = reviewer ? require('./review-runner').taskOf(inp.prompt) : null;
  const review = reviewer || runsReview || name === 'Skill' && /cross-review/.test(inp.skill || '');
  const shellTest = /^(Bash|PowerShell)$/.test(name) && testCommand(cmd, name === 'PowerShell');
  const test = !review && (shellTest || name === 'Skill' && /see-page/.test(inp.skill || ''));
  if (!review && !test) return '';
  // 备审查之前先清一遍：前台子代理结束了、没交结论的还记着"在跑"，不清的话 prepare 会让它等一个不会来的通知（复审 20261105-2 第 1 条）
  if (runsReview) { try { require('./review-runner').sweep(S.tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain), j.cwd || process.cwd()); } catch (e) { /* 看不了：照原来的判 */ } }
  // 裸开审查子代理拦下：结论对不上任务，入不了账（手工模式也一样）
  if (reviewer && !reviewTask) return '审查子代理要用 review.js prepare 输出的提示（第三行"审查任务：…"）：先跑 review.js prepare，再照它的 agents 开。任务已经交齐或作废的不用再开。';
  // 开审查子代理：同时在跑的最多 3 个（第 52 条），满了拦下、说等前面的交了再开
  // 满了的时候先看一眼会话记录：前台子代理的结果已经回来、没交结论的（崩了、被打断），算没交、让出位子（复审第 6 条），再判一次
  const sent = () => {
    if (!reviewTask) return '';
    const RR = require('./review-runner');
    let why = RR.claim(reviewTask.id, reviewTask.lens, j.tool_use_id, j.session_id);
    if (why) { try { RR.sweep(S.tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain), j.cwd || process.cwd()); } catch (e) { /* 看不了：照原来的判 */ } why = RR.claim(reviewTask.id, reviewTask.lens, j.tool_use_id, j.session_id); }
    return why;
  };
  // 开着 /vk-auto、在 OpenSpec 流程里：审查不用先问用户（第 68 条）。这一轮算不算自动（插了句话、探索记录还有没定的）不影响；用户说了停、普通改动除外
  const flowNow = S.flowState(j);
  const sessionAuto = review && cfg.autoSession === true && flowNow.on === true && !flowNow.paused;
  if (cfg.autoMode || sessionAuto) {
    if (runsReview) {
      const m = cmd.match(/--change\s+["']?([^\s"']+)/); const p = cmd.match(/--point\s+([\w-]+)/);
      const change = m && S.allChanges(j.cwd).find(c => c.name === m[1]);
      const mode = /--mode\s+proposal/.test(cmd) ? 'proposal' : 'code';
      if (change && !p) return '自动审查必须指定当前审查点 --point ' + (pending(change.dir, mode) || (mode === 'proposal' ? 'tasks' : CHANGE));
      // 单份文档、某一组不单独审：用户点名的除外
      if (change && !points(change.dir, mode).includes(p[1]) && !explicit(j, 'review')) return '自动模式不单独审 ' + p[1] + '：需求文档 tasks 写完审一次整套（--point tasks），代码等这个 change 的任务全部做完审一次（--point change）。现在接着做，到时候钩子会提醒。';
    }
    return sent();
  }
  let used = '';
  if (explicit(j, review ? 'review' : 'test')) {
    if (!review) return '';
    const permit = require('./permissions').allow(j, 'review', j.cwd, j.tool_use_id);
    if (permit.ok) return sent();
    // 上一次审查已经用掉了这次许可：说清楚，免得模型以为是没认出提问框
    // 1028 起同一句"审查"这一轮里能用好几次（问题反馈表第 16 条），走到这里是别的原因（多个变更没点名这类）：原样说
    used = permit.reason ? '（' + permit.reason + '）' : '';
  }
  // 开关开着、这一轮又不算自动：说清为什么（#227、问题反馈表第 8 条：提示只写"人工模式"，用户和模型都以为套件没读到新开关）
  let why = '';
  if (cfg.autoApply || cfg.autoRequirements) {
    try {
      const v = S.flowView(j);
      why = '（' + (cfg.autoSession ? '这个会话开着自动' : '配置开了' + [cfg.autoRequirements ? '需求自动' : '', cfg.autoApply ? 'Apply 自动' : ''].filter(Boolean).join('、')) + '，但这一轮不算自动：'
        + (v.waiting ? v.waiting : v.phase === '需求与提案' ? (cfg.autoApply && !cfg.autoRequirements ? '这个会话还在需求与提案阶段，Apply 自动要用户说"开工"（或"开始实施"、敲 /vk-go、/opsx:apply）之后才算' : '探索记录还没写完（"还没定的"清空、"范围"写好才算），或者需求文档还没写到能自动审修的那一步') : '这一轮不在 OpenSpec 流程里（问答、插进来的一句话不算）') + '）';
    } catch (e) { why = ''; }
  }
  // 这段话用户也看得到（问题表第 32 条：只说了"启动OA"，看到"人工模式：先用 Ask 询问是否自测或复验及范围"摸不着头脑）：直说用户这一轮没要求什么。
  // 只是起服务的单独说：问要不要起，不问范围
  const statusNote = '用户问服务起着没有：先 devserver.js status，起着的直接给地址，没起的问一次要不要起，不分几次问。';
  if (!review && shellTest && startCommand(cmd, name === 'PowerShell')) {
    return '用户这一轮没说要起服务' + why + '：先用 Ask 问一次要不要起，得到用户明确要求后执行' + used + '。选项写成"起（服务名）"和"不用"，不问范围，用户选了起就直接起；用户在对话里说"启动 OA""重启后端""把服务起起来""我要看看系统"也算。' + statusNote + '用户放弃就继续，不记录未测试或待办。';
  }
  // 说清楚用户怎么答才算（#210、#212：只说"先 Ask"，模型和用户都不知道哪句话算数，去翻套件源码找口令）
  return '用户这一轮没说要' + (review ? '审查' : '自测') + why + '：先用 Ask 询问是否' + (review ? '审查' : '自测或复验') + '及范围，得到用户明确要求后执行' + used + '。'
    + (review ? '选项写成"审查（范围）"和"不用"，用户选了审查就直接执行；用户在对话里说"审查""审一下""再审一次"也算。'
      : '选项写成"自测（范围）"和"不用"，用户选了自测就直接跑；用户在对话里说"自测""跑测试""跑复验""把服务起起来""我要看看系统"也算。' + statusNote)
    + '用户放弃就继续，不记录未审查、未测试或待办。';
}
// 人工模式要先 Ask 的"自测"：跑测试、起服务、看页面。编译、类型检查、静态检查算写代码的一部分，直接跑（用户 2026-10-16 定的）。
function testCommand(cmd, ps) {
  const G = require('../hooks/guard-commit');
  return G.splitCommand(G.preprocess(cmd, ps).s, ps).flat().some(seg => selfTestWords(G.words(seg, ps).map(w => w.text)));
}
/** 这条命令只是在起服务，没有跑测试（devserver start、spring-boot:run、npm run dev 这类） */
function startCommand(cmd, ps) {
  const G = require('../hooks/guard-commit');
  const segs = G.splitCommand(G.preprocess(cmd, ps).s, ps).flat().map(seg => G.words(seg, ps).map(w => String(w.text)));
  const hits = segs.filter(selfTestWords);
  return hits.length > 0 && hits.every(startWords);
}
function startWords(words) {
  const base = w => path.basename(String(w || '').replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat|sh)$/i, '').toLowerCase();
  const low = words.map(w => String(w).toLowerCase());
  // 前面的环境变量、env、cross-env 跳过（selfTestWords 也是这么看的）
  let k = 0; while (/^[a-z_][a-z0-9_]*=/.test(low[k] || '') || /^(?:env|cross-env)$/.test(base(low[k]))) k++;
  const exe = base(low[k]); const args = low.slice(k + 1);
  if (exe === 'node') return args.some((a, i) => base(a) === 'devserver.js' && args[i + 1] === 'start');
  if (/^mvnw?$/.test(exe)) return args.some(a => /^[\w.-]+:(?:run|start)$/.test(a)) && !args.some(a => /^(?:test|integration-test|verify)$/.test(a));
  if (/^gradlew?$/.test(exe)) return args.some(a => /^(?:[\w:-]*:)?(?:bootrun|run|apprun)$/.test(a)) && !args.some(a => /^(?:test|check|build)$/.test(a));
  if (/^(?:npm|pnpm|yarn)$/.test(exe)) return args.some(a => /^(?:dev|start|serve|preview)(?:[:_-].*)?$/.test(a));
  return false;
}
const SCRIPT_EXT = /\.(?:[cm]?js|ts|py)$/i;
// 脚本只看文件名，目录只认 test、tests、__tests__、spec：test-package/publish.js 不是自测
function testScript(file) {
  const parts = String(file).replace(/[\\/]+$/, '').split(/[\\/]+/); const name = parts[parts.length - 1];
  return parts.slice(0, -1).some(d => /^(?:tests?|__tests__|spec)$/i.test(d)) || SCRIPT_EXT.test(name) && /(?:^|[-_.])(?:tests?|spec|scenario|probe)(?:[-_.]|$)/i.test(name.replace(SCRIPT_EXT, ''));
}
function selfTestWords(words) {
  const base = w => path.basename(String(w || '')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  let ws = words.slice();
  // 前面的环境变量赋值、env / cross-env 包一层的，看里面真正跑的命令
  for (let k = 0; ;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k] || '')) { k++; continue; }
    if (/^(?:env|cross-env)$/.test(base(ws[k]))) { k++; while (/^-/.test(ws[k] || '')) { if (/^(?:-C|--chdir|-u|--unset)$/.test(ws[k])) k++; k++; } continue; }
    ws = ws.slice(k); break;
  }
  let exe = base(ws[0]); let args = ws.slice(1);
  if (/^(?:npx|pnpx)$/.test(exe)) { args = args.filter(a => !/^(?:-y|--yes|--no-install)$/.test(a)); exe = base(args[0]); args = args.slice(1); }
  if (/^(?:pytest|jest|vitest|mocha|ava|karma|cypress)$/.test(exe)) return true;
  if (exe === 'playwright') return args.includes('test');
  // 后面跟目录、文件、模块名的开关，它的取值不当子命令
  const plainOf = (valued) => { const out = []; for (let i = 0; i < args.length; i++) { if (valued.test(args[i])) { i++; continue; } if (!/^-/.test(args[i])) out.push(args[i].toLowerCase()); } return out; };
  if (/^(?:npm|pnpm|yarn)$/.test(exe)) {
    const w = plainOf(/^(?:--prefix|--cwd|--dir|-C|--filter|-F|--workspace|-w)$/); const sub = w[0] || '';
    const script = /^(?:run|run-script|rum|urn)$/.test(sub) ? w[1] || '' : sub;
    return /^(?:t|tst|test)$/.test(sub) || /^(?:test|e2e|cypress|playwright)(?:[:_-].*)?$/.test(script) || /^(?:dev|start|serve|preview)(?:[:_-].*)?$/.test(script);
  }
  if (/^mvnw?$/.test(exe)) {
    const goals = plainOf(/^(?:-f|--file|-pl|--projects|-s|--settings|-gs|--global-settings|-rf|--resume-from|-T|--threads|-t|--toolchains|-l|--log-file|-P|--activate-profiles|-D|--define)$/);
    const skip = args.some(a => /^-D(?:skipTests|maven\.test\.skip)(?:=true)?$/i.test(a));
    return goals.some(g => /^[\w.-]+:(?:run|start)$/.test(g)) || !skip && goals.some(g => /^(?:test|integration-test|verify|package|install|deploy)$/.test(g) || /:(?:test|integration-test)$/.test(g));
  }
  if (/^gradlew?$/.test(exe)) {
    const excluded = args.filter((a, i) => i > 0 && /^(?:-x|--exclude-task)$/.test(args[i - 1])).map(a => a.toLowerCase().split(':').pop());
    const tasks = plainOf(/^(?:-x|--exclude-task|-p|--project-dir|-b|--build-file|-c|--settings-file|-g|--gradle-user-home|-I|--init-script)$/).map(t => t.split(':').pop());
    const skipTest = excluded.includes('test');
    return tasks.some(t => /^(?:test|check|build)$/.test(t) ? !skipTest : /^(?:integrationtest|connectedcheck|bootrun|run|apprun)$/.test(t));
  }
  if (exe === 'node') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--test') return true;
      if (/^(?:-e|--eval|-p|--print|-c|--check)$/.test(a)) return false;
      if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(a)) { i++; continue; }
      if (/^-/.test(a)) continue;
      if (/[\\/]skills[\\/](?:vk-db-crud|vk-redis)[\\/]/i.test(a)) return false;
      if (base(a) === 'devserver.js') return String(args[i + 1] || '').toLowerCase() === 'start';
      return testScript(a);
    }
    return false;
  }
  if (/^(?:python3?|py)$/.test(exe)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m') return /^(?:pytest|unittest|nose2?|tox)$/i.test(args[i + 1] || '');
      if (a === '-c') return false;
      if (/^-/.test(a)) continue;
      if (/[\\/]skills[\\/](?:vk-db-crud|vk-redis)[\\/]/i.test(a)) return false;
      return testScript(a) || base(a) === 'manage.py' && String(args[i + 1] || '').toLowerCase() === 'test';
    }
    return false;
  }
  return false;
}
module.exports = { oncePrompt, groups, isCross, crossText, CHANGE, autoBlocked, oldDone, written, points, reviewable, pointFiles, fingerprint, sameInput, record, passed, settled, halted, fixPending, pending, allPassed, allDone, begin, noteResult, noteFail, automaticApply, planNext, instruction, stop, actionIssue, explicit, testCommand };
