'use strict';
/*
 * 进流程和流程状态（2026-11-03，问题表第 41、42、44 条）：
 *   进流程只有三种门；问句、插话不退出流程；开着自动不再问开工；全自动下提案提交照提交方式走，不让模型去问；流程里没开工不改源码。
 * 用法：node dev/test-flow-entry.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('flow-entry', FROM, { commitMode: 'off' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));

let seq = 0;
function project(changes) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  const os_ = path.join(proj, 'openspec');
  H.write(path.join(os_, 'plan.md'), '# 计划\n\n## 导出\n\n探索记录：explore/导出.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join(''));
  H.write(path.join(os_, 'explore', '导出.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只做导出\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join(''));
  return proj;
}
function docs(proj, c, tasks) {
  const d = path.join(proj, 'openspec', 'changes', c);
  H.write(path.join(d, 'proposal.md'), '# 导出\n\n## Why\n\n要导出。\n');
  H.write(path.join(d, 'design.md'), '# 设计\n\n- 放在 src/A.java\n');
  H.write(path.join(d, 'tasks.md'), tasks || '## 1. x\n\n- [ ] 1.1 做：src/A.java\n');
  H.write(path.join(d, 'specs', 'export', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 导出\n\n能导出。\n');
  return d;
}
function session(proj, words) {
  const sid = 's' + (++seq);
  return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), (words || []).flat()) };
}
const anchor = (j, prompt) => { H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { prompt, hook_event_name: 'UserPromptSubmit' })); };
const fl = (j) => S.flowState(j);
const skill = (j, name) => H.hook(h, 'guard-ask', Object.assign({}, j, { tool_name: 'Skill', tool_input: { skill: name }, hook_event_name: 'PreToolUse' }));
const cmd = (j, command) => H.hook(h, 'guard-commit', Object.assign({}, j, { tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PreToolUse' }));
const write = (j, file, content) => H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Write', tool_input: { file_path: file, content }, hook_event_name: 'PreToolUse' }));
const editFile = (j, file, a, b) => H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Edit', tool_input: { file_path: file, old_string: a, new_string: b }, hook_event_name: 'PreToolUse' }));
const ASKED = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q, options: [{ label: a }] }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');

H.section('进流程只有三种门');
{
  const proj = project(['c1']);
  let j = session(proj);
  anchor(j, '新增一个订单导出功能，导出成 xlsx');
  H.ok('提需求不进流程', !fl(j).on, fl(j));
  anchor(j, '接着做 c1');
  H.ok('话里点名不进流程', !fl(j).on, fl(j));
  anchor(j, '/opsx:explore 订单导出');
  H.ok('敲 /opsx:explore 进流程，在写需求', fl(j).on === true && fl(j).stage === 'plan', fl(j));

  j = session(proj, [H.tr.user('加个导出')]);
  let r = skill(j, 'opsx:propose');
  H.ok('模型自己调 OpenSpec 技能：拦下，让它先问', /用户没说要走 OpenSpec/.test(H.reasonOf(r)) && !fl(j).on, r);
  H.ok('模型自己建变更：拦下', /用户没说要走 OpenSpec/.test(H.reasonOf(cmd(j, 'openspec new change c9'))));

  j = session(proj, [H.tr.user('用 openspec 做个导出')]);
  r = skill(j, 'opsx:explore');
  H.ok('话里明确有 openspec：能调，进流程', !H.reasonOf(r) && fl(j).on === true, r);

  j = session(proj, [H.tr.user('不走 openspec，直接改')]);
  H.ok('"不走 openspec"不算', /用户没说要走 OpenSpec/.test(H.reasonOf(skill(j, 'opsx:explore'))));

  j = session(proj, [H.tr.user('加个导出'), ASKED('要用 /opsx:explore 探索吗（会进入 vk 流程）', '探索')]);
  r = skill(j, 'opsx:explore');
  H.ok('提问框选了探索：能调，进流程', !H.reasonOf(r) && fl(j).on === true, r);

  j = session(proj, [H.tr.user('加个导出'), ASKED('要用 /opsx:explore 探索吗（会进入 vk 流程）', '直接改')]);
  H.ok('提问框选了直接改：不进', /用户没说要走 OpenSpec/.test(H.reasonOf(skill(j, 'opsx:explore'))));
}

H.section('新建提案要有探索记录（要定的第 5 条）');
{
  const proj = project(['c1']);
  const file = path.join(proj, 'openspec', 'changes', 'c1', 'proposal.md');
  const body = '# 导出\n\n## Why\n\n要导出。\n';
  const read = H.tr.ran('Read', { file_path: path.join(proj, 'src', 'A.java') }, 'class A {}');
  let j = session(proj, [H.tr.user('/opsx:propose c9'), read]);
  S.setFlow(j, true, '测试', 'plan');
  const other = path.join(proj, 'openspec', 'changes', 'c9', 'proposal.md');
  H.ok('变更不在大任务里：拦下，说清怎么建', /不在 openspec\/plan\.md/.test(H.reasonOf(write(j, other, body))) && /plan\.js/.test(H.reasonOf(write(j, other, body))));
  const ex = path.join(proj, 'openspec', 'explore', '导出.md');
  const good = H.read(ex);
  H.write(ex, good.replace('## 还没定的\n\n', '## 还没定的\n\n要不要带日期\n\n'));
  H.ok('还有没定的：拦下', /还没定的/.test(H.reasonOf(write(j, file, body))));
  H.write(ex, good);
  j = session(proj, [H.tr.user('/opsx:propose c1'), read]);
  S.setFlow(j, true, '测试', 'plan');
  const ok = H.reasonOf(write(j, file, body));
  H.ok('探索记录写好了：放行', !/探索|plan\.md|还没定/.test(ok), ok);
  j = session(proj, [H.tr.user('加个导出'), read]);
  H.ok('不在流程里、用户没说：拦下', /用户没说要走 OpenSpec/.test(H.reasonOf(write(j, file, body))));
}

H.section('问句、插话不退出流程（第 44 条）');
{
  const proj = project(['c1']);
  docs(proj, 'c1');
  const j = session(proj);
  anchor(j, '/opsx:apply c1');
  H.ok('开工了', fl(j).on === true && fl(j).stage === 'apply', fl(j));
  for (const p of ['检查一下这里对不对', '为什么这么写？', '看看日志', '/ttls-onboard', '继续', '好的', '这个是什么意思']) {
    anchor(j, p);
    H.ok('"' + p + '"之后还在流程、还在 apply', fl(j).on === true && fl(j).stage === 'apply', fl(j));
  }
  anchor(j, '<task-notification>\n<task-id>a1</task-id>\n</task-notification>');
  H.ok('后台通知不动流程', fl(j).on === true && fl(j).stage === 'apply', fl(j));
  anchor(j, '能开工吗？');
  H.ok('问句不改阶段', fl(j).stage === 'apply');
  anchor(j, '停');
  H.ok('"停"：还在流程，这一轮不催', fl(j).on === true && fl(j).paused === true && /停/.test(S.flowView(j).waiting), S.flowView(j));
  anchor(j, '接着做');
  H.ok('再说一句接着做', fl(j).paused === false && fl(j).on === true, fl(j));
  anchor(j, '写一份说明文档记一下');
  H.ok('让它出文档：还在流程，这一轮全自动不作数', fl(j).on === true && fl(j).aside === true, fl(j));
  anchor(j, '接着做');
  H.ok('下一句恢复', fl(j).aside === false);
  anchor(j, '先别开工');
  H.ok('"先别开工"：回到写需求，开工范围清掉，不自动开工', fl(j).on === true && fl(j).stage === 'plan' && !fl(j).applyScope && fl(j).holdApply === true, fl(j));
  anchor(j, '退出流程');
  H.ok('"退出流程"才退出', fl(j).on === false, fl(j));
}

H.section('开着自动不再问开工（第 41 条）');
{
  const proj = project(['c1', 'c2']);
  const d1 = docs(proj, 'c1');
  docs(proj, 'c2');
  H.reviewPoints(h, d1, 'proposal');
  let j = session(proj, [H.tr.user('这个对吗？')]);
  S.setFlow(j, true, '测试', 'plan');
  S.setSessionAuto(j, true, '测试');
  H.ok('多个 change、最后一句是问句：照样开工当前这个', P.automaticApply(j) === true && fl(j).stage === 'apply', fl(j));
  H.ok('开工范围有了', A.valid(j).ok && !!fl(j).applyScope, fl(j));

  j = session(proj, [H.tr.user('做'), H.tr.call('AskUserQuestion', { questions: [] }, 'toolu_noanswer')]);
  S.setFlow(j, true, '测试', 'plan');
  S.setSessionAuto(j, true, '测试');
  H.ok('提问框没答：也不挡', P.automaticApply(j) === true, fl(j));

  j = session(proj);
  S.setFlow(j, true, '测试', 'plan');
  S.setSessionAuto(j, true, '测试');
  const c1 = S.allChanges(proj).find((c) => c.name === 'c1');
  H.ok('自动下 planNext 不问开工', !/能不能开工|开工/.test(P.planNext(j, c1) || ''), P.planNext(j, c1));

  const man = session(proj);
  S.setFlow(man, true, '测试', 'plan');
  H.ok('人工：automaticApply 不开', P.automaticApply(man) === false);
  H.ok('人工：照旧问开工', /开工/.test(P.planNext(man, c1) || ''), P.planNext(man, c1));

  const ex = path.join(proj, 'openspec', 'explore', '导出.md');
  const good = H.read(ex);
  H.write(ex, good.replace('## 还没定的\n\n', '## 还没定的\n\n要不要带日期\n\n'));
  j = session(proj);
  S.setFlow(j, true, '测试', 'plan');
  S.setSessionAuto(j, true, '测试');
  H.ok('探索还有没定的：不开工', P.automaticApply(j) === false);
  H.ok('写需求这段自动不生效', S.flowView(j).effective === false, S.flowView(j));
  H.write(ex, good);
  H.ok('清空后生效', S.flowView(j).effective === true, S.flowView(j));

  S.updateState(j.session_id + '-flow', (s) => { s.holdApply = true; });
  H.ok('用户说只写需求：不开工', P.automaticApply(j) === false);
}

H.section('全自动下提案提交照提交方式走（第 42 条）');
{
  const commitCase = (mode, withPlan) => {
    H.setConfig(h, { commitMode: mode });
    const proj = project(['c1']);
    const d = docs(proj, 'c1');
    H.reviewPoints(h, d, 'proposal');
    const j = session(proj, [H.tr.user('接着')]);
    S.setFlow(j, true, '测试', 'plan');
    S.setSessionAuto(j, true, '测试');
    S.flowTouch(j, d);
    H.git(proj, ['add', 'openspec/changes/c1'].concat(withPlan ? ['openspec/plan.md', 'openspec/explore'] : []));
    return { r: cmd(j, 'git commit -m "docs: 提案 c1"') };
  };
  let c = commitCase('auto', true);
  H.ok('自动档：连 plan.md、探索记录一起提交，放行', !H.reasonOf(c.r), c.r);
  c = commitCase('off', true);
  H.ok('关：不提交，也不让模型去问', /提交方式是"关"/.test(H.reasonOf(c.r)) && !/问用户/.test(H.reasonOf(c.r)), c.r);
  c = commitCase('ask', false);
  H.ok('询问：全自动下不问，记进报告', /全自动下不问/.test(H.reasonOf(c.r)) && !/问用户是否/.test(H.reasonOf(c.r)), c.r);

  H.setConfig(h, { commitMode: 'off' });
  const proj = project(['c1']);
  docs(proj, 'c1');
  const j = session(proj, [H.tr.user('接着')]);
  S.setFlow(j, true, '测试', 'plan');
  H.git(proj, ['add', 'openspec/changes/c1']);
  H.ok('人工：提案提交照旧要问', /问用户是否提交/.test(H.reasonOf(cmd(j, 'git commit -m "docs: 提案 c1"'))), cmd(j, 'git commit -m "docs: 提案 c1"'));
}

H.section('自动下"自动"档等提交一次，提交不成也往下走');
{
  H.setConfig(h, { commitMode: 'auto' });
  const proj = project(['c1']);
  const d = docs(proj, 'c1');
  H.reviewPoints(h, d, 'proposal');
  const j = session(proj);
  S.setFlow(j, true, '测试', 'plan');
  S.setSessionAuto(j, true, '测试');
  H.ok('还没提交：先不开工', P.automaticApply(j) === false);
  const c1 = S.allChanges(proj).find((c) => c.name === 'c1');
  H.ok('催提交一次', /提交本变更/.test(P.planNext(j, c1) || ''));
  H.ok('催过了还没提交：照样开工', P.automaticApply(j) === true, fl(j));
  H.setConfig(h, { commitMode: 'off' });
}

H.section('流程里没开工不改源码（要定的第 6 条）');
{
  const proj = project(['c1']);
  const d = docs(proj, 'c1');
  const src = path.join(proj, 'src', 'A.java');
  let j = session(proj, [H.tr.user('/opsx:explore 导出')]);
  S.setFlow(j, true, '测试', 'plan');
  const r = editFile(j, src, 'class A {}', 'class A { }');
  H.ok('写需求那一段改源码：拦下', /还没说开工/.test(H.reasonOf(r)), r);
  H.ok('带拦截编号，能放行', /拦截编号/.test(H.reasonOf(r)), H.reasonOf(r));
  const ok = H.reasonOf(editFile(j, path.join(d, 'design.md'), '- 放在 src/A.java', '- 放在 src/A.java，带日期'));
  H.ok('改需求文档不拦', !/还没说开工/.test(ok), ok);
  const other = H.reasonOf(write(j, path.join(proj, 'openspec', 'explore', '导出.md'), H.read(path.join(proj, 'openspec', 'explore', '导出.md'))));
  H.ok('写探索记录不拦', !/还没说开工/.test(other), other);
  j = session(proj, [H.tr.user('改一下这个方法')]);
  H.ok('不在流程里不拦', !/还没说开工/.test(H.reasonOf(editFile(j, src, 'class A {}', 'class A { }'))));
}

H.section('全局约定和规范');
{
  const md = H.read(path.join(H.SRC, 'claude', 'CLAUDE.md'));
  if (FROM === H.SRC) H.ok('约定里是提问框问探索', /opsx:explore/.test(md) && /不再问/.test(md), md.slice(0, 200));
  const rules = H.read(path.join(FROM, 'claude', 'rules', '10-openspec.md'));
  H.ok('规范不再提 qualify', !/qualify/.test(rules));
}

H.done('进流程和流程状态');
