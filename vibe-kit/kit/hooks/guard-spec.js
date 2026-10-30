'use strict';
/*
 * PreToolUse 钩子（改文件时，由 pre-edit 调用）：OpenSpec 产物的门槛。
 * 提案、规格、设计、任务写得含糊，模型到了写代码的时候只能猜；猜出来的东西藏在代码里，比写在文档里更难发现。
 * 所以在它把产物写进 openspec/changes/<名字>/ 的那一刻就检查，不过就拦回去改：
 *   所有产物：不许"待定、后续完善、开发阶段再、视情况、TBD"这类话，拿不准的写成决策项（同一行写明"默认按…做"）；模板的占位注释不能留着；复杂需求和设计允许长文，必要时用图说明
 *   proposal.md 第一次写：这个会话里得探索过项目（读过代码、搜过），而且探索和提案不在同一轮——先把现状给用户看。
 *             用户自己敲 /opsx:propose、全自动模式、交接之后的新会话（这个会话读过一天内的交接记录）不要求分轮
 *   tasks.md：只写实现任务（用户 2026-10-17 定的），每项写清改哪个文件（路径，而且找得到，新建的写明"新建"）；不写"验：…"；
 *             不许"联调、完善、收尾"这种任务；新写的测试、审查、验收任务拦下，让它写进 design.md 的"验收用例"
 *             打勾不检查验法；自动模式下这个变更的第一次打勾（apply 开工）要提案审过，后面的组要等前面的组做完、审修过
 *   specs：每条 Requirement 至少一个四井号的 Scenario，场景里有 WHEN 和 THEN
 *   design.md：提到的路径要找得到（新建的在同一行写明"新建"）；新写的设计 Context（现状）一节不能空，要有"验收用例"一节
 * 只判这次新加、改过的行：老变更里以前写的不追究，打勾不算改。revisions.md（修订记录）不检查。
 * 模拟这次编辑时先把换行统一成 \n（Claude Code 的 Edit 自己也这么做），匹配不到再试引号归一化；都匹配不到说明这次编辑会失败，按没改算。
 * 开关：config.json 的 specGate。
 */
const fs = require('fs');
const path = require('path');
const { readConfig, readConfigFor, flowState, flowTouch, lastUserVoice, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, blockOut, artifactOf, findHedges, addedLines, checkTasks, checkSpec, checkDesign, leftoverPlaceholders, nestedRepos, looksLikeProject, hookLog, tailEntries, turnStart, toolCalls, toolResults, projectReads, tickedLines, verifyPartOf, resolveVerify, verifyPlan, pathTokens, pathExists, NEW_FILE, declaredNew, missingPathIssue, readState, normKey, proposalReviewed, syncReviews, syncReviewRounds, reviewLoopIssue, handoverReadIn, normTicks, pendingReviewsIn, taskNotes, allChanges, syncTicks, cli } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

const GUIDE = {
  tasks: '任务的写法：- [ ] 2.1 <做什么>：<文件路径>。一项任务 = 一次提交的量，按依赖排序；文件要新建的在同一行写明"新建"。只写要做的实现：不写"验："，测试、审查、验收写进 design.md 的"验收用例"一节。',
  spec: '规格的写法：每条 ### Requirement 下至少一个 #### Scenario，WHEN 写具体的输入和状态，THEN 写能核对的结果（字段值、提示文字、跳转、状态码）。正常、异常、空数据、无权限各一条，不适用的写明为什么。',
  design: '设计的写法：Context 列出探索时读过的真实文件、表、接口；Decisions 每条写为什么选它、不选什么；提到的路径必须找得到，要新建的写明"新建"；Open Questions 只能是空的，或者每条都是决策项；"## 验收用例"一节逐条写对应场景、前置数据和环境、步骤、预期、谁来测、对应第几组任务。',
  proposal: '提案的写法：What Changes 逐条可核对；Capabilities 里每个能力都要有对应的 specs/<能力>/spec.md；Impact 列出会动到的文件、表、接口；本次不做的写成"本次不做：X（原因）"。',
};
const HEDGE_GUIDE = '不许写"以后再说"。拿不准的写成决策项：未定什么、默认按哪种做、理由（同一行写明"默认按…做"就算）；我不接受会改。本次不做的写成"本次不做：X（原因）"。';
// 验法中的材料由 proposal-files 检查可交付性，不能依赖本机临时脚本。
const beforeVerify = (line) => String(line || '').split(/(?:验|验证|验收|检验|核对)\s*[:：]/)[0];

/** 这个会话是不是接着一份交接记录干的：一天内写的 .vibe/handover.md（当前目录或上一级） */
function recentHandover(cwd) {
  let d = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 2; i++) {
    try { if (Date.now() - fs.statSync(path.join(d, '.vibe', 'handover.md')).mtimeMs < 86400000) return true; } catch (e) { /* 没有 */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}

/**
 * 先探索再提案。探索和提案要分两轮：只认"用户提需求（开口钩子记下的时刻）之后、这一轮之前"的探索——会话里更早读过的不相干的文件不算。
 * 没有提需求的记录（用户的话不像需求）就认这一轮之前的所有探索。交接之后的新会话（读过一天内的交接记录）不要求分轮
 */
/** 用户报的是做完的功能上的问题、没说要走提案，模型却要新建提案：拦一次，让它先查清原因、改动小直接改（用户 2026-10-07 定的） */
function bugFixFirstIssue(j) {
  if (!j.transcript_path) return '';
  const es = tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain);
  const v = lastUserVoice(es);
  if (!v || v.kind !== 'prompt' || !BUG_REPORT.test(v.text) || WANTS_PROPOSAL.test(v.text)) return '';
  return '我报的是做完的功能上的问题，没说要走提案，先别新建变更：' + SMALL_FIX_TEXT;
}
function exploreFirstIssue(j, art, cfg) {
  if (!j.transcript_path) return '';
  const roots = [art.root].concat(nestedRepos(art.root));
  if (!roots.some((r) => looksLikeProject(r))) return '';
  const entries = tailEntries(j.transcript_path, 8000000).filter((e) => e && !e.isSidechain);
  const { start, prompt } = turnStart(entries);
  const earlier = toolCalls(entries, 0, start);
  const before = projectReads(earlier);
  const now = projectReads(toolCalls(entries, start));
  if (!before.length && !now.length) return '这个会话里还没读过项目里的任何代码、表、接口，不能直接写提案。先用 /opsx:explore 的方式探索：读会碰到的代码、表结构（有查库的技能就用它）、接口、配置，把现状' + (cfg.autoMode ? '写进设计的 Context' : '写给我看（读了什么、发现什么、和需求对不上的、还不知道的），我确认了范围') + '再写提案。';
  if (cfg.autoMode) return '';
  const req = j.session_id ? readState(j.session_id + '-requirement') : {};
  const afterReq = req.at ? projectReads(earlier.filter((c) => (Date.parse((entries[c.i] || {}).timestamp || '') || 0) >= req.at)) : before;
  if (afterReq.length) return '';
  if (recentHandover(j.cwd) && handoverReadIn(entries)) return '';
  if (/<command-name>\s*\/?(opsx:propose|openspec-propose|openspec:propose)\s*<\/command-name>/i.test(prompt)) return '';
  return '探索完先停下：把现状（读了什么、发现什么、和需求对不上的、还不知道的）写给我看，这一轮到此为止；我确认了范围再出提案。（我自己敲 /opsx:propose 的时候才可以探索完直接写。）';
}

/** 项目里有没有叫这个名字的场景文件（.vibe/scenarios/<名字>.json，各个根目录、当前目录都看） */
function scenarioFinder(roots) {
  return (name) => {
    const n = String(name || '').replace(/\.json$/i, '');
    if (!n || /[\\/]/.test(n)) return false;
    return roots.some((r) => ['.vibe/scenarios', 'scenarios', '.vibe'].some((d) => fs.existsSync(path.join(r, d, n + '.json'))));
  };
}
/**
 * 打勾前的检查：这次编辑把哪些任务打了勾。不查验法（用户 2026-10-17 定的：任务里不写"验："，两种模式打勾都不查）。
 * 自动模式下：这个变更的第一次打勾（apply 开工）要提案审过，状态里没有记录就去会话记录里找一次成功的审提案调用兜底；
 * 后面的组要等前面的组做完、审修过。老变更里的审查、验收任务按 task-types 的规矩查。
 * 返回 { issues, ticked, skipped }：skipped 现在总是空的（以前是验法里明说"不做"的部分）
 */
function tickCheck(j, file, oldText, newText, art, cfg, roots) {
  const ticked = tickedLines(oldText, newText);
  const skipped = [];
  if (!ticked.length) return { issues: [], ticked, skipped };
  // 用户只说"开工"、有几个变更时，打的是哪个变更的勾就认哪个（#214）
  if (require('../lib/session').confirmApply(j, { hint: art.dir })) Object.assign(cfg, readConfigFor(j));
  const scopeIssue = require('../lib/apply-scope').check(j, art.dir);
  if (scopeIssue) return { issues: [scopeIssue], ticked, skipped };
  let entries = null;
  const load = () => entries || (entries = j.transcript_path ? tailEntries(j.transcript_path, 6000000).filter((e) => e && !e.isSidechain) : []);
  const done = (issues) => ({ issues, ticked, skipped });
  if (cfg.autoMode && !/^\s*[-*]\s*\[[xX]\]/m.test(oldText)) {
    let ok = require('../lib/session').reviewAllowed('proposal', art.dir);
    let waiting = false;
    if (!ok && j.transcript_path) {
      // 状态里还没记上：去会话记录里找。后台跑的审查（2.1.259 起 Agent 默认在后台）结论在后来的通知里，收工检查还没来得及记
      const es = load();
      syncReviews(es, j.cwd || art.root);
      ok = require('../lib/session').reviewAllowed('proposal', art.dir);
      if (!ok) waiting = pendingReviewsIn(toolCalls(es, 0), toolResults(es), allChanges(j.cwd || art.root), taskNotes(es)).some((p) => p.mode === 'proposal' && p.change && normKey(p.change.dir) === normKey(art.dir));
    }
    if (!ok && waiting) return done(['变更 ' + art.name + ' 的提案审查还在后台跑，结论还没送回来。等审查结果的通知到了（到了会自动接着一轮），按结论改完、在 revisions.md 记录，再开工打勾；不要再开一个审查。']);
    if (!ok) return done(['这是变更 ' + art.name + ' 的第一次打勾（apply 开工），但提案还没审过。先按 /ttls-cross-review 的提案模式审一遍：审查提示第一行写"模式：提案"，第二行写"变更：' + art.name + '"。成立的问题改掉并在 revisions.md 记录，再开工。']);
  }
  const special = ticked.map((t) => require('../lib/task-types').tickIssue(t, art.dir, j)).filter((t) => t);
  if (special.length) return done(special);
  // 打勾不再检查"验："里的命令跑没跑过（用户 2026-10-17 定的，两种模式都不查）；自动模式还要先做完上一整组并审修过
  if (!cfg.autoMode) return done([]);
  const policy = require('../lib/flow-policy');
  for (const t of ticked) {
    const m = t.match(/^(\d+)\./); if (!m) continue;
    const prior = policy.groups(art.dir).filter(g => Number(g.id.slice(6)) < Number(m[1])).find(g => !g.done || !policy.settled(art.dir, g.id));
    if (prior) return done(['先完成上一整组任务及审修：' + prior.id + '。' + (prior.done ? policy.instruction(art.dir, prior.id, cfg) : '当前组尚未完成。')]);
  }
  return done([]);
}
/** 打勾放行了：记下打勾的时间；验法里说了不做的，全自动模式下记进报告 */
function afterTick(j, art, cfg, tk) {
  try { if (tk.ticked.length) syncTicks(art.dir, tk.ticked); } catch (e) { /* 记不了不影响打勾 */ }
  if (!tk.skipped.length) return;
  hookLog('guard-spec tick 验法里有不做的部分 ' + tk.skipped.map((s) => '"' + s.part.slice(0, 40) + '"').join('、'));
  if (cfg.autoMode && report) for (const s of tk.skipped) report.note(j, { kind: 'unverified', title: '任务（' + art.name + '）' + s.task.slice(0, 60), detail: '验法里写了不做：' + s.part, change: art.name });
}

/** 模拟这次编辑之后的全文：换行统一成 \n，匹配不到再试引号归一化，都匹配不到按没改算（这次编辑会失败） */
function simulate(tool, inp, oldText, existed) {
  const nl = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
  const plain = (s) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const apply1 = (t, o, n, all) => {
    o = nl(o); n = nl(n);
    if (o === '') return t;
    if (t.includes(o)) return all ? t.split(o).join(n) : t.replace(o, () => n);
    const at = plain(t).indexOf(plain(o));
    return at >= 0 ? t.slice(0, at) + n + t.slice(at + o.length) : t;
  };
  const base = nl(oldText);
  if (tool === 'Write') return nl(inp.content);
  if (tool === 'Edit') return existed ? apply1(base, inp.old_string, inp.new_string, !!inp.replace_all) : nl(inp.new_string);
  if (tool === 'MultiEdit') { let t = base; for (const e of Array.isArray(inp.edits) ? inp.edits : []) t = apply1(t, e.old_string, e.new_string, !!e.replace_all); return t; }
  return null;
}

function handle(j, opts) {
  const cfg = readConfigFor(j);
  if (cfg.specGate === false) return null;
  const inp = j.tool_input || {};
  // 相对路径按会话的目录算：HTTP 方式下这个进程的当前目录是路由的，不是项目的
  let file = String(inp.file_path || '');
  if (file && !path.isAbsolute(file) && j.cwd) file = path.resolve(j.cwd, file);
  const art = artifactOf(file);
  // 全自动模式、在流程里：这个会话动手做了这个变更（收工时只催动手做过的变更往下走）
  if (art && cfg.autoSwitch && flowState(j).on) flowTouch(j, art.dir);
  if (!art || art.kind === 'revisions') return null;
  let tk = null;
  let oldText = '';
  let existed = false;
  try { oldText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); existed = true; } catch (e) { /* 新文件 */ }
  const newText = simulate(j.tool_name, inp, oldText, existed);
  if (newText === null) return null;
  const isAdded = addedLines(oldText, newText);
  const roots = [art.root, art.dir, path.dirname(file)].concat(nestedRepos(art.root));
  const cwd = path.resolve(j.cwd || process.cwd());
  if (!roots.some((r) => path.resolve(r).toLowerCase() === cwd.toLowerCase())) roots.push(cwd);

  const format = [];   // 写法上的问题：附上写法说明
  format.push(...require('../lib/proposal-files').issuesIn(newText, art, isAdded));
  const flow = [];     // 流程上的问题（没验证、没审、没探索）：只说这件事
  let notStarted = false; // 写需求那一段就打勾
  // 需求文档一份一份来（用户 2026-10-17 定的）：proposal → specs → design → tasks，新建下一份之前上一份要过了这一关
  if (!existed && ['proposal', 'spec', 'design', 'tasks'].includes(art.kind)) {
    const policy = require('../lib/flow-policy'); const point = art.kind === 'spec' ? 'specs' : art.kind; const order = ['proposal', 'specs', 'design', 'tasks'];
    const earlier = policy.points(art.dir, 'proposal').filter(p => order.indexOf(p) < order.indexOf(point));
    if (cfg.autoMode) {
      // 自动：上一份审修过再写下一份
      const prior = earlier.find(p => !policy.settled(art.dir, p));
      if (prior) flow.push(policy.instruction(art.dir, prior, cfg) + '，完成后再生成下一产物。');
    } else if (earlier.length) {
      // 人工：上一份写完要停下给用户看。上一份最后一次写入之后用户说过话（"写下一份""审一下"之后的回复）才写下一份
      const prev = earlier[earlier.length - 1];
      const own = policy.pointFiles(art.dir, prev).filter(f => prev === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === prev + '.md');
      const wroteAt = Math.max(0, ...own.map(f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }));
      let saidAt = 0; try { const v = j.transcript_path ? lastUserVoice(tailEntries(j.transcript_path, 3000000)) : null; saidAt = (v && v.at) || 0; } catch (e) { saidAt = Date.now(); }
      if (wroteAt && saidAt < wroteAt) flow.push(prev + ' 写完还没给我看过。一份一份来：先停下，交代 ' + prev + ' 写了什么，用提问框问我（选项写"审一下""直接写下一份""我要改"）；我说写下一份再写 ' + point + '，拿模板：openspec instructions ' + point + ' --change "' + art.name + '"');
    }
  }
  const hedges = findHedges(newText, isAdded);
  for (const h of hedges) format.push('第 ' + h.line + ' 行有"' + h.word + '"：' + h.text);
  const left = leftoverPlaceholders(newText, isAdded);
  if (left.length) format.push('第 ' + left.slice(0, 5).join('、') + ' 行还留着模板的占位注释（<!-- … -->），要么填上要么删掉');
  // 这个变更里声明过要新建的文件（别的产物里、这次要写的内容里说过"新建 x"）：别处再提到不用每行都写"新建"
  const isDeclared = (art.kind === 'tasks' || art.kind === 'design') ? declaredNew(art.dir, newText) : null;
  if (art.kind === 'tasks') {
    format.push(...checkTasks(newText, isAdded));
    newText.split('\n').forEach((l, i) => {
      if (!isAdded(i) || !/^\s*[-*]\s*\[[ xX]\]/.test(l) || NEW_FILE.test(l)) return;
      const missing = [...new Set(pathTokens(beforeVerify(l)).filter((t) => !isDeclared(t) && !pathExists(t, roots)))];
      if (missing.length) format.push(missingPathIssue(i + 1, missing));
    });
    // 头一回见到这个变更：先把现在已经打了勾的记上（不知道什么时候打的，当作早就打了）
    try { syncTicks(art.dir); } catch (e) { /* 记不了不影响检查 */ }
    if (existed) tk = tickCheck(j, file, oldText, newText, art, cfg, roots);
    // 第一次写 tasks.md 就带着 [x]：当成从 [ ] 打的勾，审没审、验没验照样查
    else if (/^\s*[-*]\s*\[[xX]\]/m.test(newText)) tk = tickCheck(j, file, normTicks(newText), newText, art, cfg, roots);
    if (tk) flow.push(...tk.issues);
    // 还在写提案那一段（用户没说开工）就打勾：拦下。用户 2026-10-07 定的：任务清单要他看过、他说了开工才开始做（规矩见 lib/session.js"流程分两段"）
    if (tk && tk.ticked.length) {
      const fl = flowState(j); if (fl.on && fl.stage === 'plan') notStarted = true;
      // 用户说了开工、却没认下来（#214）：说出原因，不再说"我还没说开工"
      let why = ''; try { why = notStarted ? require('../lib/apply-scope').refusal(j) : ''; } catch (e) { why = ''; }
      if (notStarted) flow.unshift(why ? '我说了开工，但' + why + '。认下来之前先不打勾' : '我还没说开工：提案、规格、设计、任务清单要我看过，我说了开工才开始做任务、打勾。先把要点交代给我（改哪些地方、新加的操作和接口、任务清单，我没提过的单独列），用提问框问我能不能开工（选项写"开工"和"还要改"）；我说开工、或者我自己敲 /vk-go（或 /opsx:apply）之后再做');
    }
  }
  if (art.kind === 'spec') format.push(...checkSpec(newText, isAdded));
  if (art.kind === 'design') format.push(...checkDesign(newText, isAdded, roots, !existed, isDeclared));
  if (art.kind === 'proposal' && !existed) { let b = ''; try { b = bugFixFirstIssue(j); } catch (e) { b = ''; } if (b) flow.push(b); const e = exploreFirstIssue(j, art, cfg); if (e) flow.push(e); }
  const issues = flow.concat(format);
  // 只要打勾记录、不要结论（这一步申请过放行，由 pre-edit 调）
  if (opts && opts.tickOnly) { if (tk && tk.ticked.length) afterTick(j, art, cfg, tk); return null; }
  if (!issues.length) { if (tk && tk.ticked.length) afterTick(j, art, cfg, tk); return null; }
  hookLog('guard-spec block ' + art.kind + ' ' + file + ' issues=' + issues.length);
  const shown = issues.slice(0, 8);
  let guide = GUIDE[art.kind] || '';
  const tail = format.length ? '\n' + guide + (hedges.length ? '\n' + HEDGE_GUIDE : '') + '\n改好再写。' : '';
  const out = blockOut('PreToolUse', '[vibe-kit 提案检查] ' + art.rel + '（变更 ' + art.name + '）' + (format.length ? '还不能这么写' : '现在还不能改') + '：\n' + shown.map((s) => '- ' + s).join('\n') + (issues.length > shown.length ? '\n- …还有 ' + (issues.length - shown.length) + ' 处' : '') + tail);
  // "我还没说开工"不能申请放行：开工要用户许可，需求自动在写需求那一段生效也不能自己放（2026-10-17 审核问题 3）。
  // 不可枚举，不会被写进钩子的输出；pre-edit 看到它就不给拦截编号、不认通行证
  if (notStarted) Object.defineProperty(out, 'noBypass', { value: true });
  return out;
}

/** 这一步被拦下、又用通行证放行了：打勾的时间、验法里说了不做的照样要记 */
function afterBypass(j) { try { handle(j, { tickOnly: true }); } catch (e) { /* 记不了不影响放行 */ } }

module.exports = { handle, simulate, afterBypass };
if (require.main === module) cli(handle);
