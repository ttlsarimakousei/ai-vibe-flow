'use strict';
/*
 * apply 的范围与实质提案绑定；勾选进度不改范围。
 * 2026-11-10（问题表第 76 条，仓库主人定的）：做到一半改需求是常态。
 *   - 用户开口的那一轮里改了 proposal、specs：按改后的需求重定范围、接着做，不用再说一次开工（替代 10-30 的"改需求才退回"）。
 *     不是用户开口那一轮（收工检查催着接着做的那几轮）模型自己改的，照旧退回写需求、等用户说开工。
 *   - 写别的 change 的文档不动现有的开工范围（以前目标不在范围里就把整个会话退回写需求，正在做的 change 跟着不能改、不能勾）。
 *   - 写需求那一段不改代码，不能申请放行；例外只有一种：同一个大任务里前面的 change 已经开工、范围还在（写 c2 的需求时发现 c1 不合理）。
 *   - 指纹在编辑落盘之后比（after-tool 调 valid）：以前改完要到下一次改文档才发现，中间一段状态和拦截对不上。
 */
const fs = require('fs');
const path = require('path');
const W = require('./workspace');
function planHash(dir) {
  const S = require('./session'); const rows = [];
  for (const f of S.artifactFiles(dir).filter((f) => !/revisions\.md$/.test(f))) { try { const t = fs.readFileSync(f, 'utf8'); rows.push([path.relative(dir, f), W.hash(/tasks\.md$/.test(f) ? W.progressText(t) : t)]); } catch (e) { rows.push([f, '缺失']); } }
  return W.hash(JSON.stringify(rows));
}
/**
 * 需求本身（proposal.md、specs 下的规格）的指纹。做任务时只有它变了才算"范围变了"、退回人工等用户重新说开工；
 * design 补说明、tasks 改措辞或拆子任务、修订记录不算，照旧自动，收工报告里列出改了哪些（用户 2026-10-30 定的，问题表第 22 条：
 * 以前改了任何一份需求文档开工范围就作废，Apply 自动中途掉回人工、每组都问）。planHash 照旧管提案审查的指纹
 */
function requirementHash(dir) {
  const S = require('./session'); const rows = [];
  for (const f of S.artifactFiles(dir)) {
    const a = S.artifactOf(f); if (!a || (a.kind !== 'proposal' && a.kind !== 'spec')) continue;
    try { rows.push([path.relative(dir, f), W.hash(fs.readFileSync(f, 'utf8'))]); } catch (e) { rows.push([f, '缺失']); }
  }
  return W.hash(JSON.stringify(rows));
}
/**
 * 登记开工范围。text 是用户的话（或提问框的答案）；context 是提问框的问题；
 * opts.said 是模型在用户这句话之前最后说的那段话、opts.hint 是这一步要改的文件或变更目录：
 * 用户只说"开工"、有好几个变更时（#214：两个没归档的变更，"开工"、/opsx:apply 都认不出开哪个），
 * 模型刚才那段话里只点了一个变更名的用它，再定不了就看这一步要改的是哪个变更
 */
function grant(j, text, context, opts) {
  const S = require('./session'); const o = opts || {}; const all = S.allChanges(j.cwd || process.cwd()); const named = all.filter((c) => S.mentionsChange(text, c.name));
  const asked = all.filter((c) => S.mentionsChange(context || '', c.name));
  if (!named.length && asked.length > 1) return refuse(j, '提问里有 ' + asked.map((c) => c.name).join('、') + ' 几个变更，用户选开工时没说开哪个：提问框的选项写明变更名（例："开工 ' + asked[0].name + '"）', all);
  const touched = all.filter((c) => S.flowChanges(j).includes(S.normKey(c.dir)));
  // /opsx:apply 技能的参数里点了名的（模型照用户的"开工"调技能时带上的变更名）
  const argued = all.filter((c) => S.mentionsChange(o.args || '', c.name));
  const spoken = all.filter((c) => S.mentionsChange(o.said || '', c.name));
  // 要改的文件在哪个变更目录里就认哪个；不在变更目录里的（业务代码），只有一个变更的项目包含它时才认
  const hk = o.hint ? S.normKey(o.hint) : '';
  const under = (k, d) => k === d || k.startsWith(d + '/');
  const inChange = hk ? all.filter((c) => under(hk, S.normKey(c.dir))) : [];
  const hinted = !hk ? [] : inChange.length ? inChange : all.filter((c) => S.projectRootsOf(c.dir).some((r) => under(hk, S.normKey(r))));
  let targets = named.length ? named : argued.length === 1 ? argued : asked.length === 1 ? asked : all.length === 1 ? all : touched.length === 1 ? touched : spoken.length === 1 ? spoken : hinted.length === 1 ? hinted : [];
  // 大任务里几个 change 是一件事（用户 2026-11-03 定的）：开工范围是整个大任务，回改前面的 change、接下一个都不用再认一次
  let task = null;
  try { const B = require('./big-task'); task = targets[0] ? B.ofChange(j.cwd || process.cwd(), targets[0].dir || targets[0].name) : B.forSession(j); } catch (e) { task = null; }
  if (task) { const own = all.filter((c) => task.changes.some((x) => S.normKey(x.dir) === S.normKey(c.dir))); if (own.length) targets = own; }
  if (!targets.length) return refuse(j, all.length ? '有 ' + all.map((c) => c.name).slice(0, 5).join('、') + ' 几个变更，用户说开工时没点名：让用户说"开工 ' + all[0].name + '"这样带上变更名，或者在提问框的选项里写明' : '没有当前变更，按普通任务沟通', all);
  const scope = { at: Date.now(), dirs: {}, roots: [], task: task ? task.name : '' };
  for (const c of targets) { scope.dirs[S.normKey(c.dir)] = { hash: planHash(c.dir), req: requirementHash(c.dir) }; for (const root of S.projectRootsOf(c.dir)) if (!scope.roots.includes(S.normKey(root))) scope.roots.push(S.normKey(root)); }
  const voice = j.transcript_path && S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
  const saved = S.updateState(j.session_id + '-flow', (s) => { delete s.applyRefused; s.applyScope = scope;
    // 表外的 change 开工：状态栏跟着它（第 50 条）。点名了别的 change：之前切的不算了
    if (!task && targets.length === 1) { s.current = targets[0].name; s.currentDir = targets[0].dir; delete s.task; } else if (s.current && (named.length === 1 ? s.current !== named[0].name : task && !task.changes.some((c) => c.name === s.current))) { delete s.current; delete s.currentDir; }
    if (s.keepCurrent && s.keepCurrent !== s.current) delete s.keepCurrent;
    s.waiting = ''; s.lastApplyAt = scope.at; s.applySource = { text: String(text).slice(0, 500), targets: targets.map((c) => c.name), at: scope.at }; if (voice) { s.applyVoice = S.voiceKey(voice); s.applyVoiceSchema = 2; } });
  if (!saved) return { ok: false, reason: '开工范围暂时不能保存，请重试' };
  // 基线记真正开工的那一刻（复审 20261105 第 1、2 条）：大任务只记现在要做的这个 change，点名的优先。后面的 change 轮到它时会再走到这里，
  // 那时前面 change 没提交的改动才记成"开工前就有"，审查不把它们当成这个 change 的
  try {
    let now = targets;
    if (task) { let current = ''; try { current = require('./big-task').phaseFor(j, task).change; } catch (e) { current = ''; } const picked = targets.filter((c) => named.includes(c) || c.name === current); if (picked.length) now = picked; }
    require('./review-runner').baseline(j, now.map((c) => c.dir));
  } catch (e) { /* 审查缺基线时明确降级 */ }
  return { ok: true, targets: targets.map((c) => c.name) };
}
/** 开工没认下来：原因记进流程状态（绑定是哪一次开口），拦"还没开工"的地方照着说，不再只说"用户还没说开工" */
function refuse(j, reason, all) {
  try {
    const S = require('./session');
    const v = j.transcript_path && S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
    if (j.session_id) S.updateState(j.session_id + '-flow', (s) => { s.applyRefused = { reason, voice: v ? S.voiceKey(v) : '', at: Date.now() }; });
  } catch (e) { /* 记不了：拦截提示照旧 */ }
  return { ok: false, reason, changes: (all || []).map((c) => c.name) };
}
/** 用户最后一句是开工、却没认下来的原因；没有返回 '' */
function refusal(j) {
  try {
    const S = require('./session'); const st = S.flowState(j); const r = st.applyRefused;
    if (!r || !r.reason || !j.transcript_path) return '';
    const v = S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
    return v && S.voiceKey(v) === r.voice ? r.reason : '';
  } catch (e) { return ''; }
}
/** 用户开口的那一轮：用户最后一次说话（含提问框答案）之后这个会话还没收过工。没有会话记录的（状态栏）算不是 */
function userTurn(j) { return turnStartedAt(j) > 0; }
/** 这一轮用户开口的时间；不是用户开口的那一轮返回 0。钩子预算用完往外抛（交给钩子入口放行），不当成"不是"（复审 P2-7） */
function turnStartedAt(j) {
  const S = require('./session');
  if (!j || !j.transcript_path || !j.session_id) return 0;
  try {
    const v = S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
    if (!v) return 0;
    const stop = Number(S.readState(String(j.session_id) + '-last-stop').at) || 0;
    const at = Number(v.at) || 0;
    return !stop || at > stop ? at || 1 : 0;
  } catch (e) { if (e && e.code === 'VIBE_HOOK_BUDGET') throw e; return 0; }
}
/** 这个变更的需求文档（proposal、specs）最后一次改动的时间：文件和 specs 目录的修改时间里最晚的（删了规格文件，目录的时间会变） */
function requirementMtime(dir) {
  const S = require('./session'); let m = 0;
  const see = (p) => { try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch (e) { /* 不在了 */ } };
  for (const f of S.artifactFiles(dir)) { const a = S.artifactOf(f); if (a && (a.kind === 'proposal' || a.kind === 'spec')) { see(f); if (a.kind === 'spec') see(path.dirname(f)); } }
  see(path.join(dir, 'specs'));
  return m;
}
function valid(j) {
  const S = require('./session'); const st = S.flowState(j); if (!st.applyScope) return { ok: st.stage === 'apply' };
  const changed = []; const fresh = [];
  for (const [dir, p] of Object.entries(st.applyScope.dirs || {})) {
    if (!fs.existsSync(dir)) return { ok: false, reason: '变更目录没了，先沟通新范围，再明确 apply' };
    // 20261030 以前登记的范围没有 req，照旧按整套文档比
    if (!(p.req ? requirementHash(dir) !== p.req : planHash(dir) !== p.hash)) continue;
    // 大任务里开工之后才并进来的 change（inScope 记的 joined）、还没开过工：它是在第一次写需求，不是"需求改了"，指纹跟着走（复审 P2-5）
    if (p.joined && !S.changeStarted(dir)) { fresh.push(dir); continue; }
    changed.push([dir, p]);
  }
  if (fresh.length && j && j.session_id) S.updateState(j.session_id + '-flow', (s) => { if (!s.applyScope) return; for (const dir of fresh) if (s.applyScope.dirs[dir]) s.applyScope.dirs[dir] = { hash: planHash(dir), req: requirementHash(dir), joined: true }; });
  if (!changed.length) return { ok: true };
  // 会话里开了自动（问题表第 24 条，用户 2026-10-31 定的）：用户测试时报的需求变更照改，按改后的需求重定范围、接着自动，
  // 不退回人工等用户再说一遍开工。改了什么、因为用户哪句话，revisions.md 里要写（收工检查查），收工报告里列出来
  // 人工模式（第 76 条，用户 2026-11-10 定的）：用户开口的那一轮里改的也一样，不用再说一次开工。reqEdited 给状态栏标"需求改过"
  // 只认"改动发生在这一轮用户开口之后"（复审 P1-1）：收工之后模型自己改的，等用户随便说句话再来这里，文档的修改时间在那句话之前，不认
  const auto = S.sessionAuto(j) === true;
  const since = auto ? 0 : turnStartedAt(j);
  if (auto || (since > 0 && changed.every(([dir]) => requirementMtime(dir) >= since))) {
    const at = Date.now();
    S.updateState(j.session_id + '-flow', (s) => { if (!s.applyScope) return; for (const [dir] of changed) if (s.applyScope.dirs[dir]) { s.applyScope.dirs[dir] = { hash: planHash(dir), req: requirementHash(dir) }; s.reqEdited = Object.assign({}, s.reqEdited, { [dir]: at }); } s.waiting = ''; });
    if (auto) for (const [dir] of changed) { try { require('./report').note(j, { kind: 'docEdit', title: '做任务时需求文档（proposal、specs）改了：' + path.basename(dir) + '，按改后的需求接着自动做（会话开着自动）', change: path.basename(dir) }); } catch (e) { /* 记不了不影响 */ } }
    S.hookLog((auto ? '自动模式' : '用户开口的这一轮') + ' 需求改了，按改后的需求重定开工范围：' + changed.map(([d]) => path.basename(d)).join('、'));
    return { ok: true, rebased: true };
  }
  const p = changed[0][1];
  return { ok: false, changed: true, reason: p.req ? '需求本身（proposal.md、specs 里的要求）改了，先和用户沟通新范围，再明确 apply' : '需求、设计或任务验法已变化，先沟通新范围，再明确 apply' };
}
/** 这个变更在开工范围里：登记过的；或者属于同一个大任务（开工之后才建的 change 自动并入） */
function inScope(scope, a, j) {
  const S = require('./session');
  if (scope.dirs[S.normKey(a.dir)]) return true;
  if (!scope.task) return false;
  try { const t = require('./big-task').ofChange(j.cwd || a.root, a.dir || a.name); if (!t || t.name !== scope.task) return false; } catch (e) { return false; }
  S.updateState(j.session_id + '-flow', (s) => { if (s.applyScope) s.applyScope.dirs[S.normKey(a.dir)] = { hash: planHash(a.dir), req: requirementHash(a.dir), joined: true }; });
  scope.dirs[S.normKey(a.dir)] = { hash: planHash(a.dir), req: requirementHash(a.dir), joined: true };
  return true;
}
/** 这次编辑是不是在给 tasks.md 打勾 */
function ticking(j, target, a) {
  if (!a || a.kind !== 'tasks') return false;
  const S = require('./session'); const input = (j && j.tool_input) || {};
  let old = ''; try { old = fs.readFileSync(target, 'utf8'); } catch (e) { /* 新产物 */ }
  const next = input.content !== undefined ? String(input.content) : input.edits ? input.edits.reduce((s, e) => s.replace(String(e.old_string || ''), String(e.new_string || '')), old) : old.replace(String(input.old_string || ''), String(input.new_string || ''));
  return S.tickedLines(old, next).length > 0;
}
function check(j, target) {
  const S = require('./session'); const st = S.flowState(j);
  if (st.on && st.stage === 'plan' && st.waiting === 'scope' && !S.artifactOf(target)) return '需求文档是模型自己改的（不是用户开口的那一轮），业务代码要用户重新说开工；可以继续修改提案和修订记录';
  if (!st.on || st.stage !== 'apply' || !st.applyScope) return '';
  const file = S.normKey(target); const a = S.artifactOf(target);
  // 别的 change 的文档随时能写（它自己没开工，只是不能打勾），不动现有的开工范围
  if (a && !inScope(st.applyScope, a, j)) return ticking(j, target, a) ? '这个变更不在当前 apply 许可里，先沟通范围并单独开工' : '';
  // 传进来的是变更目录：guard-spec 认出这次编辑打了勾才这么调（它的模拟比上面的 ticking 准：新建带勾的 tasks.md、CRLF、顺手改了任务文字都认，复审 P2-3）
  const asDir = a ? null : S.artifactOf(path.join(String(target), 'tasks.md'));
  if (asDir && S.normKey(asDir.dir) === file && !inScope(st.applyScope, asDir, j)) return '这个变更不在当前 apply 许可里，先沟通范围并单独开工';
  const v = valid(j); if (!v.ok) return v.reason;
  if (!a && !(st.applyScope.roots || []).some((r) => file === r || file.startsWith(r + '/'))) return '目标项目不在当前 apply 许可里，不能借用另一个项目的全自动状态';
  return '';
}
// 修订产物时退出失效的实施范围；源码与任务打勾仍必须有新版开工许可。
function prepareEdit(j, target) {
  const S = require('./session'); const st = S.flowState(j); const a = S.artifactOf(target);
  if (!a || !st.on || st.stage !== 'apply' || !st.applyScope) return;
  if (ticking(j, target, a)) return;
  // 写别的 change 的文档：不动现有的开工范围（第 76 条）
  if (!inScope(st.applyScope, a, j)) return;
  // 会话开着自动、用户开口的那一轮：改需求文档不退回提案阶段（valid 里按改后的内容重定范围）
  if (valid(j).ok || S.sessionAuto(j) === true) {
    // 做任务时改 design、tasks、修订记录：不退出自动，收工报告里列出来（改 proposal、specs 的，改完 valid 就不过了，下一次改需求文档时退回提案阶段）
    if (a.kind !== 'proposal' && a.kind !== 'spec') { try { require('./report').note(j, { kind: 'docEdit', title: '做任务时改了 ' + a.name + '/' + a.rel + '（需求本身没变，没退出自动）', change: a.name }); } catch (e) { /* 记不了不影响改文件 */ } }
    return;
  }
  demote(j, a.name);
}
function demote(j, name) {
  const S = require('./session');
  S.updateState(j.session_id + '-flow', (s) => { s.stage = 'plan'; s.waiting = 'scope'; s.why = '修订提案，旧开工范围失效'; delete s.applyScope; });
  S.hookLog('范围回到提案阶段：' + name);
}
/**
 * 改文件、跑命令的工具做完之后（after-tool）：比一次指纹。该重定的 valid 里已经重定；需求改了又不该认的（不是用户开口之后改的、没开自动），
 * 当场退回写需求，不等下一次改文档（复审 P1-1：以前留着"做任务、范围失效"的半截状态，用 Bash 改文档、改完只碰代码的一直退不回去）
 */
function settle(j) {
  const S = require('./session'); const st = S.flowState(j);
  if (!st.on || st.stage !== 'apply' || !st.applyScope) return;
  const v = valid(j);
  if (!v.ok && v.changed) demote(j, '需求文档改了（不是用户开口之后改的）');
}
/**
 * 开工时刚记的基线里，工作区有没提交的改动（需求文档、.vibe、.claude 不算）：用户 2026-11-10 定的——开工前提示要不要先提交，
 * 不提交的之后算用户自己的改动，套件不自动提交。只说一次（dirtyTold）。说开工、提问框选开工、/vk-resume、自动开工都从这里拿（复审 P2-6）
 */
const NOT_USER_DIRTY = /^"?(?:openspec|\.vibe|\.claude)\//;
function dirtyNote(j) {
  try {
    const S = require('./session'); const st = S.flowState(j);
    if (!st.on || !st.applyScope || !j || !j.session_id) return null;
    const all = S.readState('work-baselines'); const out = new Set();
    const told = Number(st.dirtyTold) || 0; let newest = 0;
    for (const d of Object.keys(st.applyScope.dirs || {})) {
      const b = all[d]; const at = (b && Number(b.at)) || 0;
      // 只说这个会话刚记的（五分钟内）：升级前记的老基线不翻出来说
      if (!b || b.session !== j.session_id || at <= told || Date.now() - at > 300000) continue;
      newest = Math.max(newest, at);
      for (const r of b.repos || []) for (const f of r.dirtyFiles || []) if (!NOT_USER_DIRTY.test(f)) out.add(f);
    }
    if (newest) S.updateState(String(j.session_id) + '-flow', (s) => { s.dirtyTold = newest; });
    const dirty = [...out];
    if (!dirty.length) return null;
    const names = dirty.slice(0, 6).join('、') + (dirty.length > 6 ? ' 等 ' + dirty.length + ' 个' : '');
    return { user: '工作区有开工前没提交的改动：' + names + '。', model: '工作区有开工前就没提交的改动（' + names + '）：接着做任务之前先用提问框问用户要不要先提交这些（选项写"先提交""不提交，接着开工"）。选先提交的，提交完再做任务；选不提交的，这些文件算用户自己的改动，之后提交时不要带上它们，套件也不会自动提交。' };
  } catch (e) { if (e && e.code === 'VIBE_HOOK_BUDGET') throw e; return null; }
}
const SOURCE = /\.(java|kt|groovy|js|mjs|cjs|ts|py|go|cs|xml|sql|vue|jsx|tsx|html?|css|scss|sass|less|styl|jsp|jspx|tag|ftl|vm|properties|ya?ml)$/i;
const NOT_SOURCE = /(^|[\\/])(\.vibe|openspec|\.claude|node_modules)[\\/]/;
/**
 * 会话在写后面 change 的需求，目标却是同一个大任务里已经开工的（用户 2026-11-10 定的："有关联属于一个集合任务那么就要能正常修改，
 * 有时候写c2的需求才发现c1的不合理"；不相干的 change 他不在一个会话里做，照旧拦）：
 * 开工范围还在、是按大任务登记的、范围没失效；target 是范围里某个开过工的 change（打勾用），或者是范围内项目里的文件、范围里有开过工的 change。
 */
function startedInScope(j, target) {
  try {
    const S = require('./session'); const st = S.flowState(j); const sc = st.applyScope;
    // 用户说了"先别开工""只写需求"的（holdApply）不算
    if (!st.on || !sc || !sc.task || st.holdApply || !valid(j).ok) return false;
    const key = S.normKey(target); const a = S.artifactOf(target);
    const dir = a ? S.normKey(a.dir) : sc.dirs[key] ? key : '';
    if (dir) return !!sc.dirs[dir] && S.changeStarted(dir);
    // 只认开过工的 change 所在的项目（复审 P2-4：以前按整个大任务的项目算，c2 自己的子项目也放了）
    const roots = Object.keys(sc.dirs).filter((d) => S.changeStarted(d)).flatMap((d) => S.projectRootsOf(d)).map((r) => S.normKey(r));
    return roots.some((r) => key === r || key.startsWith(r + '/'));
  } catch (e) { if (e && e.code === 'VIBE_HOOK_BUDGET') throw e; return false; }
}
/** 流程里、写需求那一段、用户没说开工：不改源码（第 44 条：说是需求阶段却在动代码）。不能申请放行（用户 2026-11-10："写需求的任何情况下都不能动代码"）。不在流程里不管 */
function notStarted(j, target) {
  const S = require('./session'); const st = S.flowState(j);
  if (!st.on || st.stage !== 'plan' || st.waiting === 'scope') return '';
  if (S.artifactOf(target) || !SOURCE.test(String(target)) || NOT_SOURCE.test(String(target))) return '';
  if (startedInScope(j, target)) return '';
  return '现在在写需求这一段，用户还没说开工，不改代码（这一条不能申请放行）。这个改动该走需求就写进文档；用户说开工（或敲 /vk-go）再改。用户说不走流程了，告诉他说"退出流程"。';
}
module.exports = { grant, refusal, valid, settle, check, notStarted, startedInScope, userTurn, turnStartedAt, dirtyNote, NOT_USER_DIRTY, planHash, requirementHash, prepareEdit };
