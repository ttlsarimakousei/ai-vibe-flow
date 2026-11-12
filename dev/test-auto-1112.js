'use strict';
/*
 * 问题表第 85—87 条（2026-11-12，docs/feedback-20261112.md）：
 *   85 需求一次写到 tasks，写完强制审修；需求阶段没有自动模式；探索没完不写需求
 *   86 需求审过问"自动实施 / 实施（每步问我）/ 先不实施"；自动一路做到全部通过自己关；说停才关，插话不关；
 *      说过停、选过不实施、没问就让开工的，再开工先问；自己关了以后核验时报的问题照旧自动修
 *   87 /vk-auto 删了
 * 用法：node dev/test-auto-1112.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCDIR = FROM || H.SRC;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off' };
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const textOf = (r) => (typeof r === 'string' ? r : JSON.stringify(r || ''));
const PLAN_HEAD = '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n';
const EXPLORE_OK = '# 探索\n\n## 还没定的\n\n## 范围\n\n只改导出\n\n## change: c1\n\n导出接口\n';
const DOCS = (name, done) => ({
  ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要导出。\n\n## What Changes\n\n- 改 src/A.java\n',
  ['openspec/changes/' + name + '/specs/x/spec.md']: '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  ['openspec/changes/' + name + '/design.md']: '## Context\n\n- 读过 src/A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 200 | 人工 | 1 |\n',
  ['openspec/changes/' + name + '/tasks.md']: '## 1. 导出\n\n- [' + (done ? 'x' : ' ') + '] 1.1 改 src/A.java：加导出\n',
});
let seq = 0;

/** 一个项目：plan.md 一个大任务"订单"（c1），探索记录写完了 */
function bigProject(h, name, done, withPlan) {
  const files = Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, DOCS('c1', done));
  if (withPlan !== false) { files['openspec/plan.md'] = '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n'; files['openspec/explore/订单.md'] = EXPLORE_OK; }
  const p = H.makeRepo(path.join(h.work, name), files);
  return { p, d: path.join(p, 'openspec', 'changes', 'c1') };
}
const ans = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q, options: [{ label: '自动实施' }, { label: '实施（每步问我）' }, { label: '先不实施' }] }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');

H.section('第 86 条：自动实施中说"停"才关，插话不关；说过停再说"继续"，先问自动还是人工');
{
  const h = H.makeHome('a1112-stop', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  const { p, d } = bigProject(h, 'p1', false);
  H.reviewPoints(h, d, 'proposal');
  const j = { session_id: 's-stop', cwd: p };
  H.inFlow(h, 's-stop', [d], true, 'apply'); A.grant(j, 'c1', '');
  S.setSessionAuto(j, true, '提问框选了自动');
  const say = (prompt, extra) => H.hook(h, 'task-anchor', { session_id: 's-stop', cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'stop-' + (++seq) + '.jsonl'), (extra || []).concat([H.tr.user(prompt)])) });
  say('这里为什么这么写？');
  H.ok('插话、提问：自动不关', S.sessionAuto(j) === true);
  const r = say('停');
  H.ok('说"停"：自动关了，模型知道停在这里', S.sessionAuto(j) === false && /自动关了/.test(textOf(r)), textOf(r).slice(0, 300));
  H.ok('记下是用户说停关的', S.flowState(j).autoStopped === true, S.flowState(j));
  const r2 = say('继续');
  H.ok('说过停再说"继续"：先问自动接着做还是人工接着做', /自动接着做/.test(textOf(r2)) && /人工接着做/.test(textOf(r2)) && S.flowState(j).autoAsk === 'resume', textOf(r2).slice(0, 400));
  const edit = (tp) => H.hook(h, 'pre-edit', { session_id: 's-stop', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' }, transcript_path: tp });
  const e1 = edit(H.transcript(path.join(h.root, 'stop-e1.jsonl'), [H.tr.user('继续')]));
  H.ok('没问就改代码：拦下，说先问', blocked(e1) && /自动接着做/.test(H.reasonOf(e1)), H.reasonOf(e1));
  const e2 = edit(H.transcript(path.join(h.root, 'stop-e2.jsonl'), [H.tr.user('继续'), ...ans('接着怎么做？', '自动接着做')]));
  H.ok('选了"自动接着做"：放行，自动又开了', !blocked(e2) && S.sessionAuto(j) === true && !S.flowState(j).autoAsk, H.reasonOf(e2));
}

H.section('第 86 条：选过"先不实施"（或没问就说开工），开工前先问一次');
{
  const h = H.makeHome('a1112-start', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'p2', false);
  H.reviewPoints(h, d, 'proposal');
  H.inFlow(h, 's-start', [d], true, 'plan');
  const j = { session_id: 's-start', cwd: p };
  // 需求审过时那一问选了"先不实施"
  S.readConfigFor(Object.assign({}, j, { transcript_path: H.transcript(path.join(h.root, 'start-0.jsonl'), [H.tr.user('写需求'), ...ans('c1 的需求审过了，怎么实施？', '先不实施')]) }));
  H.ok('选"先不实施"：自动关着', S.sessionAuto(j) === false);
  const r = H.hook(h, 'task-anchor', { session_id: 's-start', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '开工', transcript_path: H.transcript(path.join(h.root, 'start-1.jsonl'), [H.tr.user('开工')]) });
  H.ok('后来用户说"开工"：进了做任务那一段，先问自动实施还是实施（每步问我）', S.flowState(j).stage === 'apply' && /先用提问框问一次怎么实施/.test(textOf(r)) && /自动实施/.test(textOf(r)), [S.flowState(j).stage, textOf(r).slice(0, 400)]);
  const edit = (tp) => H.hook(h, 'pre-edit', { session_id: 's-start', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' }, transcript_path: tp });
  const e1 = edit(H.transcript(path.join(h.root, 'start-e1.jsonl'), [H.tr.user('开工')]));
  H.ok('没问就改代码：拦下', blocked(e1) && /怎么实施/.test(H.reasonOf(e1)), H.reasonOf(e1));
  const e2 = edit(H.transcript(path.join(h.root, 'start-e2.jsonl'), [H.tr.user('开工'), ...ans('c1 开工，怎么实施？', '自动实施')]));
  H.ok('选了"自动实施"：放行，自动开了', !blocked(e2) && S.sessionAuto(j) === true, H.reasonOf(e2));
  // 问 openspec 文件、改需求文档不等这一问
  S.updateState('s-start-flow', (s) => { s.autoAsk = 'start'; return s; }); S.setSessionAuto(j, false, '测试');
  const e3 = H.hook(h, 'pre-edit', { session_id: 's-start', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'design.md'), old_string: '读过', new_string: '读过了' }, transcript_path: H.transcript(path.join(h.root, 'start-e3.jsonl'), [H.tr.user('开工')]) });
  H.ok('改需求文档不等这一问', !/怎么实施/.test(H.reasonOf(e3)), H.reasonOf(e3));
}

H.section('第 86 条：全部通过套件自己关自动；核验时改了代码照旧自动修；说"别自动了"之后不再自动修');
{
  const h = H.makeHome('a1112-done', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'p3', true);
  H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'init']);
  H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code');
  const B = require(path.join(h.kit, 'lib', 'big-task.js')); const W = require(path.join(h.kit, 'lib', 'workspace.js'));
  const task = () => B.tasks(p)[0];
  B.setTaskState(task(), { selfTest: { at: Date.now(), count: 1, code: W.fingerprint(p, 'code').hash, manual: ['AC-1'] } });
  H.ok('前提：大任务在等人工核验', B.phaseOf(task()).phase === 'verify', B.phaseOf(task()));
  const j = { session_id: 's-done', cwd: p };
  H.inFlow(h, 's-done', [d], true, 'apply');
  S.updateState('s-done-flow', (s) => { s.task = '订单'; return s; });
  S.setSessionAuto(j, true, '提问框选了自动');
  const r = H.hook(h, 'verify-gate', { session_id: 's-done', cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: H.transcript(path.join(h.root, 'done-1.jsonl'), [H.tr.user('接着做'), H.tr.say('自测登记了')]) });
  H.ok('全部通过：自动关了，说一句', S.sessionAuto(j) === false && /全部通过，自动关了/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('记下了：核验时报的问题照旧自动修', B.taskState(task()).autoFix === true && B.taskState(task()).auto === false, B.taskState(task()));
  // 用户核验时报了问题，模型改了代码
  H.write(path.join(p, 'src', 'A.java'), 'class A { int fixed; }\n');
  const after = (n) => H.hook(h, 'after-tool', { session_id: 's-done', cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int fixed; }' }, tool_response: { filePath: path.join(p, 'src', 'A.java') }, transcript_path: H.transcript(path.join(h.root, 'done-a' + n + '.jsonl'), [H.tr.user('导出的文件名不对')]) });
  after(1);
  H.ok('核验时改了代码：自动重新打开，自测结果作废（回到全面自测）', S.sessionAuto(j) === true && !B.taskState(task()).selfTest && B.phaseOf(task()).phase === 'selftest', [S.sessionAuto(j), B.taskState(task())]);
  // 用户说别自动了
  H.hook(h, 'task-anchor', { session_id: 's-done', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '别自动了', transcript_path: H.transcript(path.join(h.root, 'done-2.jsonl'), [H.tr.user('别自动了')]) });
  B.setTaskState(task(), { selfTest: { at: Date.now(), count: 1, code: W.fingerprint(p, 'code').hash, manual: [] } });
  H.write(path.join(p, 'src', 'A.java'), 'class A { int fixed2; }\n');
  after(2);
  H.ok('说了"别自动了"：核验时再改代码也不自动修', S.sessionAuto(j) === false && !B.taskState(task()).autoFix, [S.sessionAuto(j), B.taskState(task())]);
}

H.section('第 86 条：不归哪个大任务的 change 也自测（workflow.js selftest --change），全过了才关自动');
{
  const h = H.makeHome('a1112-plain', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'p4', true, false);
  H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'init']);
  H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code');
  const j = { session_id: 's-plain', cwd: p };
  H.inFlow(h, 's-plain', [d], true, 'apply');
  S.setSessionAuto(j, true, '提问框选了自动');
  const stop = (n) => H.hook(h, 'verify-gate', { session_id: 's-plain', cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: H.transcript(path.join(h.root, 'plain-' + n + '.jsonl'), [H.tr.user('接着做'), H.tr.say('审过了')]) });
  const r1 = stop(1);
  H.ok('代码审过：催自测，用 selftest --change 登记', /selftest --change/.test(H.reasonOf(r1)) && S.sessionAuto(j) === true, H.reasonOf(r1));
  const res = path.join(h.root, 'plain-results.json'); H.write(res, JSON.stringify([{ case: 'AC-1', result: 'manual', note: '要人看' }]));
  const w = spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js'), 'selftest', '--change', 'c1', '--results', res, '--project', p], { cwd: p, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  H.ok('workflow.js selftest --change 登记成功', w.status === 0 && /"ok": true/.test(w.stdout), w.stdout + w.stderr);
  const bad = path.join(h.root, 'plain-bad.json'); H.write(bad, JSON.stringify([{ case: 'AC-1', result: 'fail' }]));
  const w2 = spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js'), 'selftest', '--change', 'c1', '--results', bad, '--project', p], { cwd: p, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  H.ok('有没过的用例：不登记，说改完再测', /"ok": false/.test(w2.stdout) && /改完/.test(w2.stdout), w2.stdout + w2.stderr);
  H.write(res, JSON.stringify([{ case: 'AC-1', result: 'manual', note: '要人看' }]));
  spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js'), 'selftest', '--change', 'c1', '--results', res, '--project', p], { cwd: p, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const r2 = stop(2);
  H.ok('自测登记过：自动关了，等用户核验', S.sessionAuto(j) === false && /全部通过/.test(H.reasonOf(r2)) && S.flowState(j).autoFix === true, H.reasonOf(r2));
  H.write(path.join(p, 'src', 'A.java'), 'class A { int fixed; }\n');
  H.hook(h, 'after-tool', { session_id: 's-plain', cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(p, 'src', 'A.java'), content: 'class A { int fixed; }\n' }, tool_response: { filePath: path.join(p, 'src', 'A.java') }, transcript_path: H.transcript(path.join(h.root, 'plain-a.jsonl'), [H.tr.user('导出报错了')]) });
  H.ok('核验时改了代码：自动重新打开，自测记录作废', S.sessionAuto(j) === true && !S.readState('change-selftest')[S.normKey(d)], S.readState('change-selftest'));
}

H.section('第 85 条：探索没完不让写需求、第一次打勾前要审过（没开自动也一样）');
{
  const h = H.makeHome('a1112-req', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const p = H.makeRepo(path.join(h.work, 'p5'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n', 'openspec/explore/订单.md': '# 探索\n\n## 还没定的\n\n导出要不要分页\n\n## 范围\n\n只改导出\n' });
  const d = path.join(p, 'openspec', 'changes', 'c1');
  H.inFlow(h, 's-req', [d], true, 'plan');
  const write = (rel, content) => H.hook(h, 'pre-edit', { session_id: 's-req', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(d, rel), content }, transcript_path: H.transcript(path.join(h.root, 'req-' + (++seq) + '.jsonl'), [H.tr.user('写需求')]) });
  const r1 = write('proposal.md', DOCS('c1')['openspec/changes/c1/proposal.md']);
  H.ok('探索记录还有没定的：新建 proposal 拦下，说先问用户', blocked(r1) && /探索还没完/.test(H.reasonOf(r1)) && /导出要不要分页/.test(H.reasonOf(r1)) && /提问框/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.write(path.join(p, 'openspec/explore/订单.md'), EXPLORE_OK);
  const r2 = write('proposal.md', DOCS('c1')['openspec/changes/c1/proposal.md']);
  H.ok('没定的清空了：写 proposal 不再因为探索拦', !/探索还没完/.test(H.reasonOf(r2)), H.reasonOf(r2));
  // 第一次打勾：没审过拦下
  for (const [rel, text] of Object.entries(DOCS('c1'))) H.write(path.join(p, rel), text);
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  S.setFlow({ session_id: 's-req' }, true, '开工', 'apply'); A.grant({ session_id: 's-req', cwd: p }, 'c1', '');
  const tick = () => H.hook(h, 'pre-edit', { session_id: 's-req', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: H.transcript(path.join(h.root, 'req-t' + (++seq) + '.jsonl'), [H.tr.user('开工'), ...ans('c1 怎么实施？', '实施（每步问我）')]) });
  const t1 = tick();
  H.ok('没开自动、需求没审过就打第一个勾：拦下，先审整套', blocked(t1) && /提案还没审过/.test(H.reasonOf(t1)) && /--point tasks/.test(H.reasonOf(t1)), H.reasonOf(t1));
  H.reviewPoints(h, d, 'proposal');
  H.ok('审过了：打勾放行', !blocked(tick()));
}

H.section('复审 20261112 R1、R2：需求审过那一问只选"自动实施"就算开工；无关的答案不动开关');
{
  const h = H.makeHome('a1112-r1', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'r1', false);
  H.reviewPoints(h, d, 'proposal');
  H.inFlow(h, 's-r1', [d], true, 'plan');
  const j = { session_id: 's-r1', cwd: p };
  const tp = H.transcript(path.join(h.root, 'r1-a.jsonl'), [H.tr.user('写需求'), H.tr.say('c1 的需求审过了'), ...ans('c1 的需求审过了，怎么实施？', '自动实施')]);
  const e = H.hook(h, 'pre-edit', { session_id: 's-r1', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' }, transcript_path: tp });
  H.ok('只选了"自动实施"（用户没另说开工）：改代码放行，进了做任务那一段，自动开了', !blocked(e) && S.flowState(j).stage === 'apply' && S.sessionAuto(j) === true, [H.reasonOf(e), S.flowState(j).stage]);
  const C = require(path.join(h.kit, 'lib', 'session-config.js'));
  for (const [a, q] of [['auto_increment', '主键怎么生成？'], ['Auto-detect', '编码怎么认？'], ['automatic', '模式？'], ['自动修复重试', '失败了怎么办？'], ['先不做', '要加索引吗？']]) { const got = C.autoAnswerOf ? C.autoAnswerOf(a, q, false) : '旧版没有 autoAnswerOf'; H.ok('"' + a + '"不动开关', got === '', got); }
  // 不在流程里的提问框答案不认
  const j2 = { session_id: 's-r1-out', cwd: p, transcript_path: H.transcript(path.join(h.root, 'r1-b.jsonl'), [H.tr.user('问一下'), ...ans('怎么实施？', '自动实施')]) };
  S.readConfigFor(j2);
  H.ok('不在流程里：提问框选了"自动实施"也不开', S.sessionAuto(j2) !== true);
}

H.section('复审 20261112 R3、R4、R7：核验期用 Bash 改了代码、跑审查前重新打开；改说明文档不算；"不用"不关自动；核验期说停关掉自动修');
{
  const h = H.makeHome('a1112-r3', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'r3', true);
  H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'init']);
  H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code');
  const B = require(path.join(h.kit, 'lib', 'big-task.js')); const W = require(path.join(h.kit, 'lib', 'workspace.js'));
  const task = () => B.tasks(p)[0];
  const j = { session_id: 's-r3', cwd: p };
  H.inFlow(h, 's-r3', [d], true, 'apply'); S.updateState('s-r3-flow', (s) => { s.task = '订单'; return s; });
  const verifyNow = () => { B.setTaskState(task(), { selfTest: { at: Date.now(), count: 1, code: W.fingerprint(p, 'code').hash, manual: [] }, autoFix: true, auto: false }); S.setSessionAuto(j, false, '全部通过'); };
  verifyNow();
  // 改了又改回原样（代码指纹没变）：不算。改别的文件和收工时作废自测的规矩一样，按代码指纹（openspec 文档不算）
  H.write(path.join(p, 'src', 'A.java'), 'class A {}\n');
  H.hook(h, 'after-tool', { session_id: 's-r3', cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(p, 'src', 'A.java'), content: 'class A {}\n' }, tool_response: { filePath: path.join(p, 'src', 'A.java') }, transcript_path: H.transcript(path.join(h.root, 'r3-a.jsonl'), [H.tr.user('看一下 A')]) });
  H.ok('核验时改了又改回原样（代码指纹没变）：不重新打开自动', S.sessionAuto(j) === false && !!B.taskState(task()).selfTest, B.taskState(task()));
  // 用 Bash 改了代码（after-tool 看不到），跑审查前重新打开
  H.write(path.join(p, 'src', 'A.java'), 'class A { int bashFixed; }\n');
  const review = H.hook(h, 'guard-commit', { session_id: 's-r3', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'r3-rv', tool_input: { command: 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" run --change c1 --mode code --point change --project "' + p.replace(/\\/g, '/') + '"' }, transcript_path: H.transcript(path.join(h.root, 'r3-b.jsonl'), [H.tr.user('导出的文件名不对')]) });
  H.ok('核验时 Bash 改了代码、跑审查：自动重新打开，不问用户（以前调错了模块，这条路径没生效）', S.sessionAuto(j) === true && !/没说要审查/.test(H.reasonOf(review)), [S.sessionAuto(j), H.reasonOf(review)]);
  // "不用"不关自动
  const say = (prompt, n) => H.hook(h, 'task-anchor', { session_id: 's-r3', cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'r3-s' + n + '.jsonl'), [H.tr.user(prompt)]) });
  say('不用', 1);
  H.ok('自动开着时回一句"不用"：自动不关', S.sessionAuto(j) === true);
  // 核验期（自动已关、挂着自动修）说停：自动修关掉
  verifyNow();
  say('停', 2);
  H.ok('核验期说"停"：自动修也关掉', !B.taskState(task()).autoFix && S.flowState(j).autoStopped === true, B.taskState(task()));
  const r = say('继续观察一下日志', 3);
  H.ok('说过停之后"继续观察一下日志"：不当成让接着做，不问', !/自动接着做/.test(textOf(r)) && S.flowState(j).autoAsk !== 'resume', textOf(r).slice(0, 300));
}

H.section('复审 20261112 R6：死机前这个 change 选过人工，/vk-resume 接回不再问');
{
  const h = H.makeHome('a1112-r6', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const { p, d } = bigProject(h, 'r6', false);
  H.reviewPoints(h, d, 'proposal');
  H.inFlow(h, 's-r6-old', [d], true, 'plan'); S.updateState('s-r6-old-flow', (s) => { s.task = '订单'; return s; });
  S.readConfigFor({ session_id: 's-r6-old', cwd: p, transcript_path: H.transcript(path.join(h.root, 'r6-a.jsonl'), [H.tr.user('写需求'), ...ans('c1 怎么实施？', '实施（每步问我）')]) });
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  H.ok('选人工记到大任务的这个 change 上', (B.taskState(B.tasks(p)[0]).asked || {}).c1 === 'off', B.taskState(B.tasks(p)[0]));
  const r = H.hook(h, 'task-anchor', { session_id: 's-r6-new', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '/vk-resume 订单', transcript_path: H.transcript(path.join(h.root, 'r6-b.jsonl'), [H.tr.user('/vk-resume 订单')]) });
  H.ok('接回：不再问自动还是人工', !S.flowState({ session_id: 's-r6-new' }).autoAsk && /选过人工/.test(textOf(r)), [S.flowState({ session_id: 's-r6-new' }), textOf(r).slice(0, 300)]);
}

H.section('复审 20261112 R9：旧版装过的 vk-auto.md，升级后删掉');
{
  const OLD = path.join(H.REPO, 'dev', 'baseline', '20261112.0003', 'vibe-kit');
  if (!FROM && fs.existsSync(path.join(OLD, 'claude', 'commands', 'vk-auto.md'))) {
    const oldPkg = path.join(H.tempDir('a1112-old'), 'vibe-kit'); H.copyDir(OLD, oldPkg, (x) => x === 'node_modules' || x === '.git'); H.stubDeps(oldPkg);
    const newPkg = H.makePackage('a1112-new', '20261113.0000');
    const u = H.freshHome('a1112-up');
    const i1 = H.node(u, path.join(oldPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
    const cmd = path.join(u.home, '.claude', 'commands', 'vk-auto.md');
    H.ok('旧版装上了 vk-auto.md', i1.code === 0 && fs.existsSync(cmd), i1.out.slice(-300));
    const i2 = H.node(u, path.join(newPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
    H.ok('升级到这一版：没改过的 vk-auto.md 删了', i2.code === 0 && !fs.existsSync(cmd), i2.out.slice(-300));
  }
}

H.section('第 87 条：/vk-auto 删了；给模型的说法里没有它，也没有"一份一份写"');
{
  H.ok('命令文件 vk-auto.md 不在了', !fs.existsSync(path.join(SRCDIR, 'claude', 'commands', 'vk-auto.md')));
  const texts = ['claude/rules/10-openspec.md', 'kit/lib/stage-rules.js', 'kit/lib/openspec.js', 'kit/hooks/task-anchor.js', 'kit/hooks/session-start.js', 'kit/lib/flow-policy.js', 'kit/ui/ui.html', 'README.md'].map((f) => [f, H.read(path.join(SRCDIR, f)) || '']);
  // 注释里写着"替代 10-17 的'一份一份写'"不算：只认给模型、给人看的说法
  const old = texts.filter(([, t]) => /一份一份写[，,；;：:（(]|写完一份停下|提醒用户看一看|选项写"审一下"|"定稿并开工""只定稿"/.test(t)).map(([f]) => f);
  H.ok('规范、提示、配置页、README 里没有"一份一份写""看一看""定稿并开工"', old.length === 0, old);
  const vk = texts.filter(([f, t]) => /敲 ?`?\/vk-auto|\/vk-auto off|用 \/vk-auto 开/.test(t)).map(([f]) => f);
  H.ok('给模型的规范、提示里没有 /vk-auto', vk.length === 0, vk);
  const pack = H.read(path.join(H.REPO, 'dev', 'pack.js')) || '';
  H.ok('打包清单不再要 vk-auto.md，要 auto-run.js', !/vk-auto\.md/.test(pack) && /kit\/lib\/auto-run\.js/.test(pack));
}

H.done('第 85—87 条：需求一次写完强制审修、自动只管实施');
