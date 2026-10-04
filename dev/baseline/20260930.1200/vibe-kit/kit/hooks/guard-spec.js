'use strict';
/*
 * PreToolUse 钩子（改文件时，由 pre-edit 调用）：OpenSpec 产物的门槛。
 * 提案、规格、设计、任务写得含糊，模型到了写代码的时候只能猜；猜出来的东西藏在代码里，比写在文档里更难发现。
 * 所以在它把产物写进 openspec/changes/<名字>/ 的那一刻就检查，不过就拦回去改：
 *   所有产物：不许"待定、后续完善、开发阶段再、视情况、TBD"这类话，拿不准的写成决策项（同一行写明"默认按…做"）；模板的占位注释不能留着；不超过 250 行（只在越写越长时拦）
 *   proposal.md 第一次写：这个会话里得探索过项目（读过代码、搜过），而且探索和提案不在同一轮——先把现状给用户看。
 *             用户自己敲 /opsx:propose、全自动模式、交接之后的新会话（这个会话读过一天内的交接记录）不要求分轮
 *   tasks.md：每项任务写清改哪个文件（路径，而且找得到，新建的写明"新建"）、怎么验（"验：…"）；不许"联调、完善、收尾"这种任务
 *             打勾（[ ] → [x]，行尾加了字也认得；第一次写就带着 [x] 的也算）之前，这项任务写的验法必须在改完这项任务的代码之后成功跑过
 *             这个变更的第一次打勾（apply 开工）要提案审过；开了多轮审查的，提案的多轮审查要审完
 *   specs：每条 Requirement 至少一个四井号的 Scenario，场景里有 WHEN 和 THEN
 *   design.md：提到的路径要找得到（新建的在同一行写明"新建"）；新写的设计 Context（现状）一节不能空
 * 只判这次新加、改过的行：老变更里以前写的不追究，打勾不算改。revisions.md（修订记录）不检查。
 * 模拟这次编辑时先把换行统一成 \n（Claude Code 的 Edit 自己也这么做），匹配不到再试引号归一化；都匹配不到说明这次编辑会失败，按没改算。
 * 开关：config.json 的 specGate。
 */
const fs = require('fs');
const path = require('path');
const { readConfig, blockOut, artifactOf, findHedges, addedLines, checkTasks, checkSpec, checkDesign, leftoverPlaceholders, nestedRepos, looksLikeProject, hookLog, tailEntries, turnStart, toolCalls, toolResults, projectReads, tickedLines, verifyPartOf, verifyPlan, pathTokens, pathExists, NEW_FILE, declaredNew, missingPathIssue, readState, normKey, proposalReviewed, syncReviews, syncReviewRounds, reviewLoopIssue, handoverReadIn, normTicks, pendingReviewsIn, taskNotes, allChanges, syncTicks, cli } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

const GUIDE = {
  // 验法的写法跟着"看页面"开关走（关着时页面上的写"人工看页面"），用的时候再按开关换
  tasks: '任务的写法：- [ ] 2.1 <做什么>：<文件路径>；验：<命令或 /ttls-see-page 场景>。一项任务 = 一次提交的量，按依赖排序；文件要新建的在同一行写明"新建"。',
  spec: '规格的写法：每条 ### Requirement 下至少一个 #### Scenario，WHEN 写具体的输入和状态，THEN 写能核对的结果（字段值、提示文字、跳转、状态码）。正常、异常、空数据、无权限各一条，不适用的写明为什么。',
  design: '设计的写法：Context 列出探索时读过的真实文件、表、接口；Decisions 每条写为什么选它、不选什么；提到的路径必须找得到，要新建的写明"新建"；Open Questions 只能是空的，或者每条都是决策项。',
  proposal: '提案的写法：What Changes 逐条可核对；Capabilities 里每个能力都要有对应的 specs/<能力>/spec.md；Impact 列出会动到的文件、表、接口；本次不做的写成"本次不做：X（原因）"。',
};
const HEDGE_GUIDE = '不许写"以后再说"。拿不准的写成决策项：未定什么、默认按哪种做、理由（同一行写明"默认按…做"就算）；我不接受会改。本次不做的写成"本次不做：X（原因）"。';
const MAX_LINES = 250;
// 任务行里"验：…"之前的部分：要改、要建的文件写在这里。验法里的脚本（.vibe 里现写的临时脚本）写任务的时候还不存在，不查；
// 真没有的话，打勾之前跑验法那一步自然过不去
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
 * 打勾前先验证：这次编辑把哪些任务打了勾，每一项写的验法在"改完这项任务的代码之后"成功跑过了吗。
 * 从哪开始算：任务行里写的文件最后一次改成功之后；这段会话记录里没改过它们（更早改的、用命令改的）就整段都算；
 * 任务行里没写文件的，从最后一次改代码之后算。改 tasks.md 本身不算——以前从"上次改 tasks.md 之后"算，
 * 连着给几项任务打勾、打勾前改一句验法，刚跑过的验证就不认了（问题反馈 F20260928-010、F20260929-015）。
 * 失败的编辑（找不到要替换的文字、被钩子拦下）不算改过；失败的命令不算跑过。
 * 这个变更的第一次打勾（apply 开工）还要求提案审过：状态里没有记录，就去会话记录里找一次成功的审提案调用兜底。
 * 返回 { issues, ticked, skipped }：skipped 是验法里明说"不做"的部分（打勾放行，记进全自动报告）
 */
function tickCheck(j, file, oldText, newText, art, cfg, roots) {
  const ticked = tickedLines(oldText, newText);
  const skipped = [];
  if (!ticked.length) return { issues: [], ticked, skipped };
  let entries = null;
  const load = () => entries || (entries = j.transcript_path ? tailEntries(j.transcript_path, 6000000).filter((e) => e && !e.isSidechain) : []);
  const done = (issues) => ({ issues, ticked, skipped });
  if (!/^\s*[-*]\s*\[[xX]\]/m.test(oldText)) {
    let ok = proposalReviewed(art.dir);
    let waiting = false;
    if (!ok && j.transcript_path) {
      // 状态里还没记上：去会话记录里找。后台跑的审查（2.1.259 起 Agent 默认在后台）结论在后来的通知里，收工检查还没来得及记
      const es = load();
      syncReviews(es, j.cwd || art.root);
      ok = proposalReviewed(art.dir);
      if (!ok) waiting = pendingReviewsIn(toolCalls(es, 0), toolResults(es), allChanges(j.cwd || art.root), taskNotes(es)).some((p) => p.mode === 'proposal' && p.change && normKey(p.change.dir) === normKey(art.dir));
    }
    if (!ok && waiting) return done(['变更 ' + art.name + ' 的提案审查还在后台跑，结论还没送回来。等审查结果的通知到了（到了会自动接着一轮），按结论改完、在 revisions.md 记录，再开工打勾；不要再开一个审查。']);
    if (!ok) return done(['这是变更 ' + art.name + ' 的第一次打勾（apply 开工），但提案还没审过。先按 /ttls-cross-review 的提案模式审一遍：审查提示第一行写"模式：提案"，第二行写"变更：' + art.name + '"。成立的问题改掉并在 revisions.md 记录，再开工。']);
    if (cfg.reviewLoop) {
      // 会话记录里刚做完的审查（后台审查的结论刚送到、收工检查还没来得及计）、审查之后只在 revisions.md 记了理由的，先计上
      if (j.transcript_path) { const es = load(); syncReviewRounds(es, syncReviews(es, j.cwd || art.root)); }
      const lo = reviewLoopIssue('proposal', art.dir, cfg);
      if (lo) return done([/。$/.test(lo) ? lo : lo + '；处理完再开工。']);
    }
  }
  if (!j.transcript_path) return done([]);
  const es = load();
  const calls = toolCalls(es, 0);
  const res = toolResults(es);
  const cwd = path.resolve(j.cwd || art.root);
  const edited = (c) => { const r = res.get(c.id); return /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && !!r && !r.error; };
  const fileOf = (c) => normKey(path.resolve(cwd, String(c.input.file_path || c.input.notebook_path || '')));
  const nameOf = (c) => path.basename(String(c.input.file_path || c.input.notebook_path || ''));
  const isCode = (f) => !/\/(openspec|\.vibe|\.claude)\//.test(f);
  const scenarioExists = scenarioFinder(roots || [art.root, cwd]);
  const out = [];
  for (const t of ticked) {
    const v = verifyPartOf(t);
    const plan = verifyPlan(v, { scenarioExists });
    for (const s of plan.skipped || []) skipped.push({ task: t, part: s });
    // 这项任务的代码是什么时候改完的：任务行里写的文件最后一次改成功
    const tokens = pathTokens(beforeVerify(t)).map((x) => x.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
    let since = -1;
    let by = '';
    for (let i = calls.length - 1; i >= 0 && since < 0 && tokens.length; i--) {
      if (!edited(calls[i])) continue;
      const f = fileOf(calls[i]);
      if (isCode(f) && tokens.some((k) => (k.includes('/') ? f === k || f.endsWith('/' + k) : path.basename(f) === k))) { since = i + 1; by = nameOf(calls[i]); }
    }
    if (since < 0 && !tokens.length) for (let i = calls.length - 1; i >= 0; i--) if (edited(calls[i]) && isCode(fileOf(calls[i]))) { since = i + 1; by = nameOf(calls[i]); break; }
    const cmds = calls.slice(Math.max(0, since)).filter((c) => { const r = res.get(c.id); return /^(Bash|PowerShell)$/.test(c.name) && r && !r.error; }).map((c) => String(c.input.command || ''));
    if (plan.test(cmds)) continue;
    const when = since > 0 ? '改完 ' + by + ' 之后' : '这段会话记录里';
    hookLog('guard-spec tick blocked task="' + t.slice(0, 40) + '" verify="' + v.slice(0, 40) + '" need="' + plan.need.slice(0, 60) + '" since=' + (since > 0 ? by : '头') + ' okCmds=' + cmds.length + (cmds.length ? ' last=' + cmds[cmds.length - 1].slice(0, 60) : ''));
    // 说清"要看到什么才算"：只说"还没跑过"，模型跑了十几遍也不知道差在哪（问题反馈 F20260928-003）
    out.push('打勾之前先验证："' + t.slice(0, 50) + '"' + (v ? ' 写的验法是"' + v.slice(0, 40) + '"，' + when + '还没看到它成功跑过' : ' 没写验法，' + when + '也没成功跑过任何验证命令') + '。要看到的是：' + plan.need + (cmds.length ? '（' + (since > 0 ? '之后' : '这段记录里') + '成功跑过的命令：' + cmds.slice(-3).map((c) => c.slice(0, 50)).join(' ｜ ') + '）' : '（' + (since > 0 ? '之后' : '这段记录里') + '还没有成功跑过任何命令）')
      + '。跑过、通过了再打勾；验证没过就不打勾，说明卡在哪。这一项里有现在验不了的部分（要等用户、环境不具备）：在验法里把那一部分写成"……本次不做（原因）"，能验的照样要跑。');
  }
  return done(out);
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
  const cfg = readConfig();
  if (cfg.specGate === false) return null;
  const inp = j.tool_input || {};
  // 相对路径按会话的目录算：HTTP 方式下这个进程的当前目录是路由的，不是项目的
  let file = String(inp.file_path || '');
  if (file && !path.isAbsolute(file) && j.cwd) file = path.resolve(j.cwd, file);
  const art = artifactOf(file);
  if (!art || art.kind === 'revisions') return null;
  let tk = null;
  let oldText = '';
  let existed = false;
  try { oldText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); existed = true; } catch (e) { /* 新文件 */ }
  const newText = simulate(j.tool_name, inp, oldText, existed);
  if (newText === null) return null;
  const isAdded = addedLines(oldText, newText);
  const roots = [art.root].concat(nestedRepos(art.root));
  const cwd = path.resolve(j.cwd || process.cwd());
  if (!roots.some((r) => path.resolve(r).toLowerCase() === cwd.toLowerCase())) roots.push(cwd);

  const format = [];   // 写法上的问题：附上写法说明
  const flow = [];     // 流程上的问题（没验证、没审、没探索）：只说这件事
  const hedges = findHedges(newText, isAdded);
  for (const h of hedges) format.push('第 ' + h.line + ' 行有"' + h.word + '"：' + h.text);
  const left = leftoverPlaceholders(newText, isAdded);
  if (left.length) format.push('第 ' + left.slice(0, 5).join('、') + ' 行还留着模板的占位注释（<!-- … -->），要么填上要么删掉');
  const lineCount = newText.split('\n').length;
  const oldCount = existed ? oldText.split('\n').length : 0;
  if (lineCount > MAX_LINES && lineCount > oldCount) format.push('这个文件 ' + lineCount + ' 行，超过 ' + MAX_LINES + ' 行：拆细，一个模块一个提案，不要把整份材料塞进一个变更');
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
  }
  if (art.kind === 'spec') format.push(...checkSpec(newText, isAdded));
  if (art.kind === 'design') format.push(...checkDesign(newText, isAdded, roots, !existed, isDeclared));
  if (art.kind === 'proposal' && !existed) { const e = exploreFirstIssue(j, art, cfg); if (e) flow.push(e); }
  const issues = flow.concat(format);
  // 只要打勾记录、不要结论（这一步申请过放行，由 pre-edit 调）
  if (opts && opts.tickOnly) { if (tk && tk.ticked.length) afterTick(j, art, cfg, tk); return null; }
  if (!issues.length) { if (tk && tk.ticked.length) afterTick(j, art, cfg, tk); return null; }
  hookLog('guard-spec block ' + art.kind + ' ' + file + ' issues=' + issues.length);
  const shown = issues.slice(0, 8);
  let guide = GUIDE[art.kind] || '';
  if (art.kind === 'tasks' && cfg.autoSeePage === false) guide = guide.replace('验：<命令或 /ttls-see-page 场景>', '验：<命令>（页面上的写"人工看页面"）');
  const tail = format.length ? '\n' + guide + (hedges.length ? '\n' + HEDGE_GUIDE : '') + '\n改好再写。' : '';
  return blockOut('PreToolUse', '[vibe-kit 提案检查] ' + art.rel + '（变更 ' + art.name + '）' + (format.length ? '还不能这么写' : '现在还不能改') + '：\n' + shown.map((s) => '- ' + s).join('\n') + (issues.length > shown.length ? '\n- …还有 ' + (issues.length - shown.length) + ' 处' : '') + tail);
}

/** 这一步被拦下、又用通行证放行了：打勾的时间、验法里说了不做的照样要记 */
function afterBypass(j) { try { handle(j, { tickOnly: true }); } catch (e) { /* 记不了不影响放行 */ } }

module.exports = { handle, simulate, afterBypass };
if (require.main === module) cli(handle);
