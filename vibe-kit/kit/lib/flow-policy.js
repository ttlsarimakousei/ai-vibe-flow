'use strict';
/* 两阶段工作流：自动条件、逐产物/任务组审查点、人工 Ask 与提示去重。只保存套件本机状态，不把执行安排写进团队任务。 */
const fs = require('fs');
const path = require('path');
const S = require('./session');
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
// 各组只审任务里点了名的文件。开工以来改了、没被任何一组点名的文件，所有组做完后并成一个审查点 group-rest：
// 不审就记成"代码审过了"是 2026-10-17 审核问题 6。有哪一组一个文件都没点名的，那一组本来就审全部改动，不再另设
const REST = 'group-rest';
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
function restFiles(dir) {
  const all = groups(dir); if (!all.length || !all.every(g => g.done)) return [];
  const named = new Set(); for (const g of all) { const files = namedFiles(dir, g); if (!files.length) return []; files.forEach(f => named.add(S.normKey(f))); }
  return changedCode(dir).filter(f => !named.has(S.normKey(f)));
}
function points(dir, mode) {
  if (mode === 'code') { const done = groups(dir).filter(g => g.done).map(g => g.id); return restFiles(dir).length ? done.concat(REST) : done; }
  const files = S.artifactFiles(dir);
  return ['proposal', 'specs', 'design', 'tasks'].filter(p => files.some(f => p === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === p + '.md'));
}
function pointFiles(dir, point) {
  const files = S.artifactFiles(dir).filter(f => !/revisions\.md$/.test(f));
  const order = ['proposal', 'specs', 'design', 'tasks']; const rank = order.indexOf(point);
  if (rank >= 0) return files.filter(f => { const p = /[\\/]specs[\\/]/.test(f) ? 'specs' : path.basename(f, '.md'); return order.indexOf(p) >= 0 && order.indexOf(p) <= rank; });
  if (point === REST) return restFiles(dir);
  const group = groups(dir).find(g => g.id === point); if (!group) return files;
  return namedFiles(dir, group);
}
function fingerprint(dir, point) {
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
function passed(dir, point) { const r = record(dir, point); return r.status === 'completed' && r.issues === 0 && r.fingerprint === fingerprint(dir, point) && require('./review-runner').inputsCurrent(r.materialInputs); }
function settled(dir, point) { const r = record(dir, point); return passed(dir, point) || r.status === 'resolved' && r.resolvedFingerprint === fingerprint(dir, point) && require('./review-runner').inputsCurrent(r.materialInputs); }
function pending(dir, mode) { return points(dir, mode).find(p => !settled(dir, p)) || ''; }
function allPassed(dir, mode) { const ps = points(dir, mode); return ps.length > 0 && ps.every(p => settled(dir, p)); }
function limit(cfg, mode) { return Math.min(20, Math.max(1, Number(mode === 'proposal' ? cfg.requirementsReviewMaxRounds : cfg.applyReviewMaxRounds) || 3)); }
// 轮数只数"审出问题、修了再审"这一串：上一轮已经零问题通过、或者问题处理完了，这次重审是因为后面的组改到了同一个文件，从头数。
// 否则全程零问题也会被复审耗光轮数，提交被永久拦下（2026-10-17 审核问题 4）
function concluded(r) { return r.status === 'completed' && r.issues === 0 || r.status === 'resolved'; }
function begin(dir, point, id, inputHash) {
  S.updateState('review-points', o => { const k = key(dir, point); const previous = live(dir, o[k]); const base = concluded(previous) ? 0 : previous.rounds || 0; o[k] = { rounds: base + 1, status: 'running', key: id, fingerprint: inputHash, born: S.changeBorn(dir), at: Date.now() }; });
}
function noteResult(dir, point, result, inputHash) {
  S.updateState('review-points', o => {
    const k = key(dir, point); const previous = live(dir, o[k]);
    const rounds = previous.key === result.id && previous.status === 'running' ? previous.rounds || 1 : (concluded(previous) ? 0 : previous.rounds || 0) + 1;
    o[k] = { rounds, status: result.status, issues: result.issues.length, fingerprint: inputHash, report: result.file, key: result.id, materialInputs: result.materialInputs, born: S.changeBorn(dir), at: Date.now() };
  });
}
function qualify(j, assessment) {
  if (!j.session_id || j.session_id === 'unknown') throw new Error('自动条件评估需要当前会话编号');
  const cfg = S.readConfig(); if (!cfg.autoRequirements) throw new Error('需求自动模式未开启');
  const a = assessment || {}; const fields = ['description', 'scope', 'acceptance'];
  if (fields.some(k => typeof a[k] !== 'string' || a[k].trim().length < 6) || !Array.isArray(a.unresolved)) throw new Error('自动条件评估需要 description、scope、acceptance 和 unresolved；先探索并明确用户要求');
  const entries = j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : [];
  const st = S.flowState(j); const since = Number(st.explorationAt) || 0;
  const explored = S.toolCalls(entries.filter(e => !since || (Date.parse(e.timestamp || '') || 0) >= since), 0);
  if (!S.lastUserVoice(entries) || !S.projectReads(explored).length) throw new Error('还没有用户描述或实际探索记录，先读相关代码并沟通');
  const open = openQuestion(entries);
  const ready = a.unresolved.length === 0 && !open;
  S.updateState(j.session_id + '-flow', st => { st.planReady = ready; st.planAssessment = { description: a.description, scope: a.scope, acceptance: a.acceptance, unresolved: a.unresolved, onlyPlan: a.onlyPlan === true, at: Date.now() }; st.waiting = ready ? '' : '需求仍有疑问'; });
  return { ready, next: ready ? '逐个产物完成审修，验收用例随需求和设计完善' : open ? open + '，明确后重新评估' : '先用 Ask 沟通 unresolved，明确后重新评估' };
}
/**
 * 需求自动的资格不能只凭模型自报（用户 2026-10-17 定的）：用户最近一句是问句、或者模型最近一次提问框还没得到回答，都不算明确。
 * 返回没明确的原因，明确了返回空串
 */
function openQuestion(entries) {
  const v = S.lastUserVoice(entries);
  if (v && v.kind === 'prompt' && /(?:[？?]|吗|么|呢|是不是|要不要|能不能|行不行|对不对|好不好)[\s。.!！~～]*$/.test(String(v.text || '').trim())) return '用户最近一句是问句，先回答';
  const asks = S.toolCalls(entries, 0).filter(c => c.name === 'AskUserQuestion');
  if (asks.length) { const r = S.toolResults(entries).get(asks[asks.length - 1].id); if (!r || r.error || !S.ANSWERED.test(r.text)) return '最近一次提问框还没得到回答，先等用户回答'; }
  return '';
}
function automaticApply(j) {
  const cfg = S.readConfig(); const st = S.flowState(j);
  if (!cfg.autoRequirements || !cfg.autoApply || !st.planReady || st.stage !== 'plan' || st.waiting || st.planAssessment && st.planAssessment.onlyPlan) return false;
  const changes = S.allChanges(j.cwd).filter(c => S.flowChanges(j).includes(S.normKey(c.dir)));
  if (changes.length !== 1) return false;
  const c = changes[0]; if (points(c.dir, 'proposal').length !== 4 || !allPassed(c.dir, 'proposal')) return false;
  // 写文档期间用户又问了问题、或者提问框还没回答：照人工给选项，不自动开工
  if (openQuestion(entriesOf(j))) return false;
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  // 不是 git 仓库的壳子没有"提交"这一步，审完就算定稿。提交方式是"询问""自动"的，等文档提交了再开工（询问要等用户答了提交）；
  // "关"的，文档提不提交由用户自己来，不等
  if (inGit(root) && S.commitModeOf(cfg) !== 'off') { try { if (!W.checkedGit(root, ['ls-files', '--', rel + '/tasks.md']).trim() || W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim()) return false; } catch (e) { return false; } }
  if (!require('./apply-scope').grant(j, c.name, '').ok) return false;
  S.setFlow(j, true, '两阶段自动：文档逐点审修并定稿提交后开工', 'apply'); return true;
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
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  // 壳子本身可以不是 git 仓库（openspec 在壳子根，代码在子项目）：没有可提交的，直接问开工（2026-10-17 审核问题 12）
  const git = inGit(root); let dirty = '';
  if (git) { try { dirty = W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim(); } catch (e) { return ''; } }
  if (dirty) {
    // 提交方式（用户 2026-10-17 定的）：自动——提交一次；询问——问用户一次；关——不提交。问过、不提交的接着给开工选项（审核问题 2：不能自己提交）
    const mode = S.commitModeOf(S.readConfig());
    const msg = mode === 'off' ? '' : once(j, 'plan-commit|' + c.dir, fingerprint(c.dir, 'tasks'), mode === 'ask'
      ? '同一套需求文档已定稿。提交方式是"询问"：用 Ask 问用户是否提交 docs: 提案 ' + c.name + '（选项"提交定稿"和"先不提交"），用户说提交再提交；' + (finalizeChoice(j) === 'go' ? '用户在定稿那一问里已经选了"定稿并开工"，提交这一问答完就开工，不再问开工。' : finalizeChoice(j) === 'only' ? '用户选的是"只定稿"，不开工、也不再问开工。' : '然后给出开工选项。')
      : '同一套需求文档已定稿，提交本变更的产物和用例一次 docs: 提案 ' + c.name + '。');
    if (msg) return msg;
    if (mode === 'auto') return '';
  }
  const st = S.flowState(j);
  if (st.planAssessment && st.planAssessment.onlyPlan) return '';
  const done = !git ? '文档已经定稿（' + c.name + ' 所在的目录不是 git 仓库，没有要提交的）。' : dirty ? '文档已经定稿（还没提交，提不提交由用户定）。' : '文档已经定稿提交。';
  // 定稿和开工合成一问（用户 2026-10-30 定的，审核第四节第 10 条）：用户在定稿那一问里选过的，不再另问开工
  const fin = finalizeChoice(j);
  if (fin === 'only') return '';
  if (fin === 'go') return once(j, 'plan-go|' + c.dir, fingerprint(c.dir, 'tasks'), done + '用户在定稿那一问里选了"定稿并开工"：直接开工（/opsx:apply ' + c.name + '），不再问开工。');
  return once(j, 'plan-apply|' + c.dir, fingerprint(c.dir, 'tasks'), done + '用 Ask 给出“执行 apply / 继续修改 / 暂不执行”的选项。');
}
function instruction(dir, point, cfg) {
  const mode = point.startsWith('group-') ? 'code' : 'proposal'; const rec = record(dir, point); const max = limit(cfg, mode);
  if ((rec.rounds || 0) >= max) return '当前审查点 ' + point + ' 已达到 ' + max + ' 轮上限且尚未通过，停止自动循环并报告问题；用户主动要求仍可继续审查。';
  return selfTestFirst(dir, point, cfg) + '审查点 ' + point + '：执行 review.js run --change ' + path.basename(dir) + ' --mode ' + mode + ' --point ' + point + '。自动核验、修改、复验，最多 ' + max + ' 轮；当前已经 ' + (rec.rounds || 0) + ' 轮。需求变化先沟通并同步相关产物和用例。';
}
/**
 * 自动模式按验收用例自测（用户 2026-10-17 定的）：用例写在 design.md 的"验收用例"一节，任务清单里不写测试任务。
 * "自动自测"开着时：每组做完先跑任务组写着这一组的、Claude 能自动跑的用例；全部做完先把能自动跑的全跑一遍。
 * 页面上的用例在"自动验证页面"开着时用 /ttls-see-page 跑，关着的留给人工。只在代码审查点前说
 */
function selfTestFirst(dir, point, cfg) {
  if (!point.startsWith('group-') || point === REST || cfg.autoVerify === false) return '';
  const page = cfg.autoSeePage === false ? '页面上的留给人工' : '页面上的用 /ttls-see-page 跑';
  const all = groups(dir); const finished = all.length > 0 && all.every(g => g.done);
  if (finished) return '任务全部做完：先把 design.md "验收用例"里 Claude 能自动跑的全部跑一遍（' + page + '），结果写进最后的交代；跑不了的写明原因。然后';
  return '先按 design.md "验收用例"里任务组写 ' + point.slice(6) + ' 的、Claude 能自动跑的用例自测（' + page + '）。然后';
}
function entriesOf(j) { return j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : []; }
function explicit(j, action) { return S.userSaid(entriesOf(j), action).ok; }
// 提示只记发过哪条，不生成“未审查/未测试”任务，也不登记放弃状态。
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
const QUICK_ASK = '跑快检（项目说明里的快检命令，编译级；这个命令本身要跑测试的，问的时候说明）、';
/** 这一份需求文档自己的文件最后一次写入的时间 */
function writtenAt(dir, point) {
  const own = pointFiles(dir, point).filter(f => point === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === point + '.md');
  return Math.max(0, ...own.map(f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }));
}
// 用户说不要之后（v 是那一次开口），at 这个时间点的改动还在不在那之前：在之前就别再问（#220）
const stillDeclined = (v, at) => !!v && !(Number(at) > (Number(v.at) || 0));
/** lastEditAt：这一轮最后一次改代码、页面的时间（收工检查算），用户说不用审、不用测之后又改了才再问 */
function stop(j, touched, codeChanged, turn, quickPending, lastEditAt) {
  const quick = () => typeof quickPending === 'function' && quickPending() ? QUICK_ASK : '';
  const cfg = S.readConfigFor(j); const out = [];
  // 自动模式快到网关上限不再发审查指令：再起一轮，请求体超了网关直接 413（2026-10-17 审核问题 9）
  if (cfg.autoMode) { const used = S.lastUsageTokens(entriesOf(j)); if (used && S.nearGatewayLimit(used)) return out; }
  // 这一轮用户最后的表态是不审、不测（提问框选了"就这样定稿""直接写下一份""不用"，或者原话说了不用）：那一份不再问
  const noReview = cfg.autoMode ? null : S.userDeclined(entriesOf(j), 'review');
  const noTest = cfg.autoMode ? null : S.userDeclined(entriesOf(j), 'test');
  const dirs = [...new Set([...touched, ...S.flowChanges(j)].filter(d => fs.existsSync(d)))];
  for (const dir of dirs) {
    const mode = S.flowStage(j) === 'apply' ? 'code' : 'proposal'; const point = cfg.autoMode ? pending(dir, mode) : points(dir, mode).slice().reverse().find(p => !settled(dir, p));
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
      const where = '当前 ' + path.basename(dir) + (rel ? '（' + rel + '）' : '') + ' 的 ' + point;
      const after = '选择放弃就继续，不写未审查或未测试记录、不催补做。审查后先展示全部问题，再用一个提问框逐条选（一条一个问题，一框最多 4 条，多了分几框）：改（推荐）/不改/自行输入；用户选了"改"的，改完直接复验，不再问；没选"改"的复验，这一轮用户已经要求过的直接做，没要求过的先问。';
      // 需求文档一份一份来（用户 2026-10-17 定的）：写完一份停下给用户看，用户选了才写下一份
      const msg = askOnce(j, key(dir, point), fingerprint(dir, point), turn, () => mode === 'code'
        ? where + ' 已完成。用 Ask 问是否' + quick() + '审查、是否按验收用例自测，用户已明确要求的直接执行。' + after
        : where + ' 写完了。一份一份来：停下给用户看，交代写了什么，用 Ask 问（选项写"审一下""' + (point === 'tasks' ? '定稿并开工""只定稿' : '直接写下一份') + '""我要改"' + (point === 'tasks' ? '；定稿和开工在这一问里一起定，不再另问开工' : '') + '），用户已明确要求审查的直接审。' + after);
      if (msg) out.push(msg);
    } else { const msg = once(j, key(dir, point), fingerprint(dir, point) + ':' + (record(dir, point).rounds || 0), instruction(dir, point, cfg)); if (msg) out.push(msg); }
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
      const what = askReview && askTest ? '审查、是否自测' : askReview ? '审查' : '自测';
      const msg = askOnce(j, 'plain-test', W.fingerprint(j.cwd, 'code').hash, turn, () => { const q = quick(); return '本次代码已修改' + (q ? '，最后一次修改之后还没跑过快检' : '') + '。用 Ask 询问是否' + q + what + '；用户说不用就直接继续，这个会话里不再问这一样，不记待办、不反复提醒。'; }); if (msg) out.push(msg);
    }
  }
  return out;
}
/**
 * 这条命令真的在跑审查：拆开的命令段里有"node <套件的 tools/review.js> run"。以前对整条命令文字匹配 review.js run，
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
      if (kitOwn && ws[k + 2] === 'run') return true;
    }
  } catch (e) { return /review\.js["']?\s+run\b/.test(cmd); }
  return false;
}
function actionIssue(j) {
  const cfg = S.readConfigFor(j); let inp = j.tool_input || {}; let name = String(j.tool_name || '');
  // IDEA 的 execute_tool 按路由里的实际工具判断（转发的运行配置照样算自测）。
  if (/^mcp__.+__execute_tool$/.test(name)) { const r = require('./idea-tools').route(inp.command); if (r) { name = name.replace(/execute_tool$/, r.name); inp = r.input; } }
  const cmd = String(inp.command || '');
  const runsReview = /^(Bash|PowerShell)$/.test(name) && reviewRun(j, cmd, name === 'PowerShell');
  const review = /^(Agent|Task)$/.test(name) && /(?:ttls|vibe)-reviewer/.test(inp.subagent_type || '') || runsReview || name === 'Skill' && /cross-review/.test(inp.skill || '');
  const shellTest = /^(Bash|PowerShell)$/.test(name) && testCommand(cmd, name === 'PowerShell');
  // IDEA 的编译、文件检查、lint 是快检，直接跑；运行配置会起程序或跑测试，算自测。
  const test = !review && (shellTest || /execute_run_configuration/.test(name) || name === 'Skill' && /see-page/.test(inp.skill || ''));
  if (!review && !test) return '';
  if (cfg.autoMode) {
    if (review) {
      if (!runsReview) return '自动逐点审查使用 review.js 的有限材料请求，不启动兼容代理；先确定当前 --point。';
      const m = cmd.match(/--change\s+["']?([^\s"']+)/); const p = cmd.match(/--point\s+([\w-]+)/);
      const change = m && S.allChanges(j.cwd).find(c => c.name === m[1]);
      const mode = /--mode\s+proposal/.test(cmd) ? 'proposal' : 'code';
      if (change && !p) return '自动审查必须指定当前审查点 --point ' + (pending(change.dir, mode) || (mode === 'proposal' ? 'tasks' : 'group-1'));
      if (change && p && (record(change.dir, p[1]).rounds || 0) >= limit(cfg, mode)) {
        const permit = require('./permissions').allow(j, 'review', change.dir, j.tool_use_id);
        if (!permit.ok) return '该审查点已达到自动审查上限，停止自动循环并报告；用户主动要求可继续。' + permit.reason;
      }
    }
    return '';
  }
  let used = '';
  if (explicit(j, review ? 'review' : 'test')) {
    if (!review) return '';
    const permit = require('./permissions').allow(j, 'review', j.cwd, j.tool_use_id);
    if (permit.ok) return '';
    // 上一次审查已经用掉了这次许可：说清楚，免得模型以为是没认出提问框
    // 1028 起同一句"审查"这一轮里能用好几次（问题反馈表第 16 条），走到这里是别的原因（多个变更没点名这类）：原样说
    used = permit.reason ? '（' + permit.reason + '）' : '';
  }
  // 开关开着、这一轮又不算自动：说清为什么（#227、问题反馈表第 8 条：提示只写"人工模式"，用户和模型都以为套件没读到新开关）
  let why = '';
  if (cfg.autoApply || cfg.autoRequirements) {
    try {
      const v = S.flowView(j);
      why = '（配置页开了' + [cfg.autoRequirements ? '需求自动' : '', cfg.autoApply ? 'Apply 自动' : ''].filter(Boolean).join('、') + '，开关是现读的，但这一轮不算自动：'
        + (v.waiting ? v.waiting : v.phase === '需求与提案' ? (cfg.autoApply && !cfg.autoRequirements ? '这个会话还在需求与提案阶段，Apply 自动要用户说"开工"（或"开始实施"、敲 /vk-go、/opsx:apply）之后才算' : '需求文档还没写到能自动审修的那一步') : '这一轮不在 OpenSpec 流程里（问答、插进来的一句话不算）') + '）';
    } catch (e) { why = ''; }
  }
  // 说清楚用户怎么答才算（#210、#212：只说"先 Ask"，模型和用户都不知道哪句话算数，去翻套件源码找口令）
  return '人工模式' + why + '：先用 Ask 询问是否' + (review ? '审查' : '自测或复验') + '及范围，得到用户明确要求后执行' + used + '。'
    + (review ? '选项写成"审查（范围）"和"不用"，用户选了审查就直接执行；用户在对话里说"审查""审一下""再审一次"也算。'
      : '选项写成"自测（范围）"和"不用"，用户选了自测就直接跑；用户在对话里说"自测""跑测试""跑复验""把服务起起来"也算。')
    + '用户放弃就继续，不记录未审查、未测试或待办。';
}
// 人工模式要先 Ask 的"自测"：跑测试、起服务、看页面。编译、类型检查、静态检查算写代码的一部分，直接跑（用户 2026-10-16 定的）。
function testCommand(cmd, ps) {
  const G = require('../hooks/guard-commit');
  return G.splitCommand(G.preprocess(cmd, ps).s, ps).flat().some(seg => selfTestWords(G.words(seg, ps).map(w => w.text)));
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
      if (/[\\/]skills[\\/](?:ttls-db-crud|ttls-redis)[\\/]/i.test(a)) return false;
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
      if (/[\\/]skills[\\/](?:ttls-db-crud|ttls-redis)[\\/]/i.test(a)) return false;
      return testScript(a) || base(a) === 'manage.py' && String(args[i + 1] || '').toLowerCase() === 'test';
    }
    return false;
  }
  return false;
}
module.exports = { groups, points, pointFiles, fingerprint, record, passed, settled, pending, allPassed, limit, begin, noteResult, qualify, automaticApply, planNext, instruction, stop, actionIssue, explicit, testCommand };
