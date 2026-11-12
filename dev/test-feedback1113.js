'use strict';
/*
 * 问题表第 88、89 条和导出议题 #458—#467（2026-11-13，docs/feedback-20261113.md）：
 *   88    全部通过套件关了自动之后，用户每报一次问题，改代码前问一次"自动实施 / 实施（每步问我）"；选了自动：改→审→自测，全部通过再关；
 *         自测、代码审查催 3 次没动就关自动并让模型把情况告诉用户；不再一改代码就悄悄重开
 *   89、#467  提问框选了探索主要看答案；认下来就记成在流程里
 *   #464  壳子里子项目名下的验证证据，从壳子根看也算
 *   #462  提交的祈使句（"分功能提交代码""把代码提交了""代码提交一下吧"）
 *   #463  用户这一轮只让起服务，改代码前拦一次
 *   #466  审查超时按套件这头的用时比
 *   #458—#461、#465  流程视图里要算审查指纹的那几项用到才算
 * 用法：node dev/test-feedback1113.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCDIR = FROM || H.SRC;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off' };
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const PLAN_HEAD = '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n';
const EXPLORE_OK = '# 探索\n\n## 还没定的\n\n## 范围\n\n只改导出\n\n## change: c1\n\n导出接口\n';
const DOCS = (name, tasks) => ({
  ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要导出。\n\n## What Changes\n\n- 改 src/A.java\n',
  ['openspec/changes/' + name + '/specs/x/spec.md']: '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  ['openspec/changes/' + name + '/design.md']: '## Context\n\n- 读过 src/A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 200 | 人工 | 1 |\n',
  ['openspec/changes/' + name + '/tasks.md']: tasks || '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n',
});
let seq = 0;
/** 一个项目：c1 的任务都勾完了。withPlan 为 false 时不归哪个大任务 */
function project(h, name, withPlan, tasks) {
  const files = Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, DOCS('c1', tasks));
  if (withPlan !== false) { files['openspec/plan.md'] = '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n'; files['openspec/explore/订单.md'] = EXPLORE_OK; }
  const p = H.makeRepo(path.join(h.work, name), files);
  return { p, d: path.join(p, 'openspec', 'changes', 'c1') };
}
/** 提问框的一问一答（2.1.299 起的结果文字）。structured 为真时带上结构化的那份（真实的会话记录里都有） */
function ans(q, a, structured) {
  const pair = H.tr.ran('AskUserQuestion', { questions: [{ question: q, options: [{ label: a }, { label: '别的' }] }] }, 'Your questions have been answered: "' + q + '"="' + a + '". You can now continue with these answers in mind.');
  if (structured) pair[1].toolUseResult = { questions: [{ question: q }], answers: { [q]: a } };
  return pair;
}
/** 一套"核验期"的夹具：c1 做完、审过、自测登记过，会话开着自动，在做任务那一段。返回各种动作 */
function verifying(name, big) {
  const h = H.makeHome(name, FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  const W = require(path.join(h.kit, 'lib', 'workspace.js'));
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  const AR = require(path.join(h.kit, 'lib', 'auto-run.js'));
  const { p, d } = project(h, 'p', big);
  H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code');
  const sid = 's-' + name; const j = { session_id: sid, cwd: p };
  H.inFlow(h, sid, [d], true, 'apply'); A.grant(j, 'c1', '');
  const task = () => B.tasks(p)[0];
  if (big !== false) { S.updateState(sid + '-flow', (s) => { s.task = '订单'; return s; }); B.setTaskState(task(), { selfTest: { at: Date.now(), count: 1, code: W.fingerprint(p, 'code').hash, manual: ['AC-1'] } }); }
  else AR.noteChangeTest(d, W.fingerprint(p, 'code').hash, ['AC-1']);
  S.setSessionAuto(j, true, '提问框选了自动');
  const file = path.join(p, 'src', 'A.java');
  const tp = (entries) => H.transcript(path.join(h.root, sid + '-' + (++seq) + '.jsonl'), entries);
  const input = { file_path: file, old_string: 'class A', new_string: 'class A ' };
  return {
    h, S, B, W, AR, p, d, j, sid, file, task,
    autoFix: () => (big !== false ? !!B.taskState(task()).autoFix : !!S.flowState(j).autoFix),
    say: (entries, prompt) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tp(entries) }),
    preEdit: (entries, f) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: f ? { file_path: f, old_string: 'a', new_string: 'b' } : input, transcript_path: tp(entries) }),
    /** 真的把文件改了，再过一遍 after-tool。返回这次工具调用的会话记录条目 */
    edit: (entries, body) => { H.write(file, body); const ran = H.tr.ran('Edit', input, 'ok'); H.hook(h, 'after-tool', { session_id: sid, cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: input, tool_response: { filePath: file }, transcript_path: tp(entries.concat(ran)) }); return ran; },
    stop: (entries) => H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp(entries) }),
    selftest: () => {
      const res = path.join(h.root, 'res-' + (++seq) + '.json'); H.write(res, JSON.stringify([{ case: 'AC-1', result: 'manual', note: '要人看' }]));
      const args = big !== false ? ['selftest', '--task', '订单'] : ['selftest', '--change', 'c1'];
      return spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js'), ...args, '--results', res, '--project', p], { cwd: p, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    },
  };
}
const ASK_FIX = /先用提问框问一次怎么改/;

H.section('第 88 条：全部通过关了自动之后，用户每报一次问题，改代码前问一次；选了自动：改→审→自测，全部通过再关');
{
  const t = verifying('f1113-fix', true);
  const { S, B, j } = t;
  const t1 = [H.tr.user('接着做'), H.tr.say('自测登记了')];
  const r1 = t.stop(t1);
  H.ok('全部通过：自动关了，说清以后再报问题会先问、结果不要另建文件交代', S.sessionAuto(j) === false && /全部通过，自动关了/.test(H.reasonOf(r1)) && /先问一次/.test(H.reasonOf(r1)) && /不要为了交代在项目里新建文件/.test(H.reasonOf(r1)) && !/照旧自动/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('记下了：之后再让改，先问', t.autoFix() === true, B.taskState(t.task()));
  H.ok('关自动的这一轮里接着改代码：不问（用户还没报问题）', !ASK_FIX.test(H.reasonOf(t.preEdit(t1))), H.reasonOf(t.preEdit(t1)));
  // 用户核验时报了问题（新的一轮）
  const t2 = [H.tr.user('导出的文件名不对，改一下')];
  t.say(t2, '导出的文件名不对，改一下');
  const e1 = t.preEdit(t2);
  H.ok('用户报了问题：改代码前拦下，让它先问"自动实施 / 实施（每步问我）"', blocked(e1) && ASK_FIX.test(H.reasonOf(e1)) && /自动实施/.test(H.reasonOf(e1)) && /实施（每步问我）/.test(H.reasonOf(e1)), H.reasonOf(e1));
  H.ok('没问之前自动照旧关着（不再一改代码就悄悄重开）', S.sessionAuto(j) === false);
  t2.push(...ans('这个问题怎么改？', '自动实施'));
  const e2 = t.preEdit(t2);
  H.ok('选了"自动实施"：放行，自动开了', !blocked(e2) && S.sessionAuto(j) === true && !S.flowState(j).autoAsk, [H.reasonOf(e2), S.flowState(j)]);
  H.ok('答的是核验期那一问：之后再报问题照样问', t.autoFix() === true, B.taskState(t.task()));
  t2.push(...t.edit(t2, 'class A { int fixed1; }\n'));
  const r2 = t.stop(t2.concat([H.tr.say('改好了')]));
  H.ok('改完收工：照自动催代码审查，不是让它去问用户要不要审', /review\.js run --change c1 --mode code --point change/.test(H.reasonOf(r2)) && !/用一个提问框问/.test(H.reasonOf(r2)), H.reasonOf(r2));
  H.reviewPoints(t.h, t.d, 'code');
  const pushes = [1, 2, 3].map(() => H.reasonOf(t.stop(t2.concat([H.tr.say('审过了')]))));
  H.ok('代码审过、全面自测没登记：同一份代码催 3 次（以前只说一次）', pushes.every((x) => /全面自测/.test(x) && /selftest --task 订单/.test(x) && !/用提问框问用户要不要全面自测/.test(x)), pushes.map((x) => x.slice(0, 80)));
  H.ok('催着的时候自动照旧开着', S.sessionAuto(j) === true);
  const r3 = t.stop(t2.concat([H.tr.say('测过了，都正常')]));
  H.ok('催了 3 次还没登记：关自动，让它把情况告诉用户（以前自动一直开着）', S.sessionAuto(j) === false && /全面自测没登记/.test(H.reasonOf(r3)) && /自动关了/.test(H.reasonOf(r3)) && /告诉用户/.test(H.reasonOf(r3)), H.reasonOf(r3));
  H.ok('这样关的也记着：之后再让改，先问', t.autoFix() === true);
  const after = H.reasonOf(t.stop(t2.concat([H.tr.say('情况是这样')])));
  H.ok('关了之后再收工：不再拦这件事，也不换成人工的问法接着问', !/全面自测/.test(after), after);
  // 用户让接着做：新的一轮再问；选自动、登记自测、全部通过再关
  const t3 = [H.tr.user('继续')];
  t.say(t3, '继续');
  H.ok('用户让接着做（新的一轮）：改代码前再问一次', ASK_FIX.test(H.reasonOf(t.preEdit(t3))));
  t3.push(...ans('接着怎么改？', '自动实施'));
  H.ok('又选了自动', !blocked(t.preEdit(t3)) && S.sessionAuto(j) === true);
  const w = t.selftest();
  H.ok('全面自测登记成功', w.status === 0 && /"ok": true/.test(w.stdout), w.stdout + w.stderr);
  const r4 = t.stop(t3.concat([H.tr.say('自测登记了')]));
  H.ok('自审、自测都过了：自动自己关了', S.sessionAuto(j) === false && /全部通过，自动关了/.test(H.reasonOf(r4)) && B.phaseOf(t.task()).phase === 'verify', H.reasonOf(r4));
  // 再报问题：流程重复。这次选每步问
  const t4 = [H.tr.user('导出的列顺序也不对')];
  t.say(t4, '导出的列顺序也不对');
  H.ok('再报一次问题：又问一次', ASK_FIX.test(H.reasonOf(t.preEdit(t4))));
  t4.push(...ans('怎么改？', '实施（每步问我）'));
  H.ok('选了"实施（每步问我）"：放行，自动关着', !blocked(t.preEdit(t4)) && S.sessionAuto(j) === false, H.reasonOf(t.preEdit(t4)));
  t4.push(...t.edit(t4, 'class A { int fixed2; }\n'));
  H.ok('同一轮里接着改：不再问', !ASK_FIX.test(H.reasonOf(t.preEdit(t4))));
  // 说了别自动了：核验期那一问也关掉
  const t5 = [H.tr.user('别自动了')];
  t.say(t5, '别自动了');
  const t6 = [H.tr.user('标题也改一下')];
  t.say(t6, '标题也改一下');
  H.ok('用户说过"别自动了"：之后报问题不再问', !ASK_FIX.test(H.reasonOf(t.preEdit(t6))) && t.autoFix() === false, H.reasonOf(t.preEdit(t6)));
}

H.section('第 88 条：不归哪个大任务的 change 一样（先问、催 3 次、关）');
{
  const t = verifying('f1113-plain', false);
  const { S, j } = t;
  const r1 = t.stop([H.tr.user('接着做'), H.tr.say('自测登记了')]);
  H.ok('全部通过：自动关了', S.sessionAuto(j) === false && /全部通过/.test(H.reasonOf(r1)) && /先问一次/.test(H.reasonOf(r1)), H.reasonOf(r1));
  const t2 = [H.tr.user('导出报错了')];
  t.say(t2, '导出报错了');
  H.ok('报了问题：改代码前先问', ASK_FIX.test(H.reasonOf(t.preEdit(t2))) && S.sessionAuto(j) === false);
  t2.push(...ans('怎么改？', '自动实施'));
  H.ok('选了自动：放行', !blocked(t.preEdit(t2)) && S.sessionAuto(j) === true);
  t2.push(...t.edit(t2, 'class A { int fixed; }\n'));
  H.ok('改完收工：催代码审查', /review\.js run --change c1/.test(H.reasonOf(t.stop(t2.concat([H.tr.say('改好了')])))));
  H.reviewPoints(t.h, t.d, 'code');
  const pushes = [1, 2, 3].map(() => H.reasonOf(t.stop(t2.concat([H.tr.say('审过了')]))));
  H.ok('自测没登记：催 3 次', pushes.every((x) => /selftest --change c1/.test(x)), pushes.map((x) => x.slice(0, 60)));
  const r3 = t.stop(t2.concat([H.tr.say('测过了')]));
  H.ok('还没登记：关自动，让它告诉用户', S.sessionAuto(j) === false && /自测没登记/.test(H.reasonOf(r3)) && /自动关了/.test(H.reasonOf(r3)), H.reasonOf(r3));
  const t3 = [H.tr.user('那你登记一下')];
  t.say(t3, '那你登记一下');
  t3.push(...ans('怎么做？', '自动实施'));
  t.preEdit(t3);
  const w = t.selftest();
  H.ok('自测登记成功', w.status === 0 && /"ok": true/.test(w.stdout), w.stdout + w.stderr);
  const r4 = t.stop(t3.concat([H.tr.say('登记了')]));
  H.ok('登记了：全部通过，自动关了', S.sessionAuto(j) === false && /全部通过/.test(H.reasonOf(r4)), H.reasonOf(r4));
}

H.section('第 88 条：代码审查催够了没动也关自动；任务没做完的不关；不是核验期的答案清掉"先问"的记号');
{
  // 审查有没处理的 P1：催 3 次，第 4 次收工没什么可催了
  const t = verifying('f1113-review', true);
  const { S, B, j } = t;
  B.setTaskState(t.task(), { selfTest: null });
  const P = require(path.join(t.h.kit, 'lib', 'flow-policy.js'));
  P.noteResult(t.d, 'change', { id: 'fx-p1', status: 'completed', issues: [{ id: 'r1', severity: 'P1', title: '空列表会拼出 in ()', file: 'src/A.java' }] }, P.fingerprint(t.d, 'change'));
  const turn = [H.tr.user('接着做'), H.tr.say('审查有 1 条 P1')];
  const pushes = [1, 2, 3].map(() => H.reasonOf(t.stop(turn)));
  H.ok('审出的 P1 没处理：催 3 次（原来就这样）', pushes.every((x) => /P1、P2 还没处理/.test(x)) && S.sessionAuto(j) === true, pushes.map((x) => x.slice(0, 60)));
  const r = t.stop(turn);
  H.ok('催够了还没动：关自动，让它把情况告诉用户（以前自动一直开着）', S.sessionAuto(j) === false && /代码审查没收尾/.test(H.reasonOf(r)) && /自动关了/.test(H.reasonOf(r)), H.reasonOf(r));

  // 任务还没做完：收工不关自动
  const h2 = H.makeHome('f1113-mid', FROM, QUIET);
  const S2 = require(path.join(h2.kit, 'lib', 'session.js'));
  const { p, d } = project(h2, 'p', true, '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n- [ ] 1.2 改 src/A.java：加表头\n');
  H.reviewPoints(h2, d, 'proposal');
  const j2 = { session_id: 's-mid', cwd: p };
  H.inFlow(h2, 's-mid', [d], true, 'apply'); require(path.join(h2.kit, 'lib', 'apply-scope.js')).grant(j2, 'c1', '');
  S2.updateState('s-mid-flow', (s) => { s.task = '订单'; return s; });
  S2.setSessionAuto(j2, true, '提问框选了自动');
  for (let i = 0; i < 5; i++) H.hook(h2, 'verify-gate', { session_id: 's-mid', cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: H.transcript(path.join(h2.root, 'mid-' + i + '.jsonl'), [H.tr.user('这里为什么这么写？'), H.tr.say('因为……')]) });
  H.ok('任务还没做完：收工几次都不关自动', S2.sessionAuto(j2) === true);

  // 套件关过自动之后开了新的一趟（大任务里加了 c2，它的需求审完那一问选了人工）：中间改代码不再每轮问
  const t3 = verifying('f1113-clear', true);
  t3.stop([H.tr.user('接着做'), H.tr.say('自测登记了')]);
  H.ok('前提：套件关了自动、记着先问', t3.S.sessionAuto(t3.j) === false && t3.autoFix() === true);
  // 模型没等钩子拦、照规范自己先问了怎么改（任务都做完了，答的就是核验期那一问）：记号留着
  t3.S.readConfigFor(Object.assign({}, t3.j, { transcript_path: H.transcript(path.join(t3.h.root, 'clear-0.jsonl'), [H.tr.user('文件名不对'), ...ans('这个问题怎么改？', '实施（每步问我）')]) }));
  H.ok('任务都做完时模型自己先问的那一问也算核验期那一问：之后再报问题照样问', t3.autoFix() === true, t3.B.taskState(t3.task()));
  H.write(path.join(t3.p, 'openspec', 'plan.md'), H.read(path.join(t3.p, 'openspec', 'plan.md')) + '| | c2 | | |\n');
  H.write(path.join(t3.p, 'openspec', 'explore', '订单.md'), H.read(path.join(t3.p, 'openspec', 'explore', '订单.md')) + '\n## change: c2\n\n表头\n');
  for (const [rel, text] of Object.entries(DOCS('c2', '## 1. 表头\n\n- [ ] 1.1 改 src/A.java：加表头\n'))) H.write(path.join(t3.p, rel), text);
  H.ok('前提：大任务回到写 c2 的需求那一步', t3.B.phaseOf(t3.task()).phase === 'plan' && t3.B.phaseOf(t3.task()).change === 'c2', t3.B.phaseOf(t3.task()));
  t3.S.readConfigFor(Object.assign({}, t3.j, { transcript_path: H.transcript(path.join(t3.h.root, 'clear-a.jsonl'), [H.tr.user('接着做下一个'), ...ans('c2 的需求审过了，怎么实施？', '实施（每步问我）')]) }));
  H.ok('答的是需求审过那一问（不是核验期那一问）：记号清掉', t3.autoFix() === false, t3.B.taskState(t3.task()));
  const t3b = [H.tr.user('第一项开始做')];
  H.ok('之后每一轮改代码不再问', !ASK_FIX.test(H.reasonOf(t3.preEdit(t3b))), H.reasonOf(t3.preEdit(t3b)));
}

H.section('第 89 条、#467：提问框选了探索主要看答案；认下来就记成在流程里');
{
  const h = H.makeHome('f1113-entry', FROM, { commitMode: 'off' });
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const proj = H.makeRepo(path.join(h.work, 'p'), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  let k = 0;
  const session = (words) => { const sid = 'e' + (++k); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), words.flat()) }; };
  const skill = (j, name) => H.hook(h, 'guard-ask', Object.assign({}, j, { tool_name: 'Skill', tool_input: { skill: name }, hook_event_name: 'PreToolUse' }));
  const cmd = (j, command) => H.hook(h, 'guard-commit', Object.assign({}, j, { tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PreToolUse' }));
  const NO = /用户没说要走 OpenSpec/;
  const big = H.tr.user('做一个订单导出的大需求：支持 xlsx、csv，带权限和审计');
  for (const [q, a] of [['这个需求改动较大，怎么推进？', '走 /opsx:explore 探索'], ['这个需求比较大，要进 vk 流程吗？', '走/opsx:explore探索'], ['改动较大，要用 /opsx:explore 探索吗？', '走流程（推荐）'], ['要先探索吗？', '探索'], ['要用 /opsx:explore 探索吗（会进入 vk 流程）', '探索']]) {
    const j = session([big, ans(q, a)]);
    const r = skill(j, 'opsx:explore');
    H.ok('问"' + q + '"答"' + a + '"：能调 /opsx:explore，进流程', !NO.test(H.reasonOf(r)) && S.flowState(j).on === true, H.reasonOf(r));
  }
  for (const [q, a] of [['要用 /opsx:explore 探索吗（会进入 vk 流程）', '直接改'], ['要用 /opsx:explore 探索吗', '不探索，直接改'], ['导出用哪种格式？', 'xlsx'], ['要走 openspec 吗？', '不走 openspec']]) {
    const j = session([big, ans(q, a)]);
    H.ok('问"' + q + '"答"' + a + '"：照旧不进', NO.test(H.reasonOf(skill(j, 'opsx:explore'))) && S.flowState(j).on !== true);
  }
  // 问题里有英文引号：结果文字按引号拆会截断，结构化的那份是完整的
  const jq = session([big, ans('要走 "OpenSpec" 流程吗？', '好', true)]);
  H.ok('问题里有英文引号（按文字拆只剩后半句）：照结构化的答案认', !NO.test(H.reasonOf(skill(jq, 'opsx:explore'))), H.reasonOf(skill(jq, 'opsx:explore')));
  // 提示里写明选项不用一字不差
  H.ok('拦下时写明选项里带"探索"就认', /带"探索"两个字就认/.test(H.reasonOf(skill(session([H.tr.user('加个导出')]), 'opsx:explore'))));
  // 选了探索、模型没调技能：建变更时认下来就记成在流程里，下一轮不再拦
  const first = [big, ans('要用 /opsx:explore 探索吗（会进入 vk 流程）', '探索'), H.tr.ran('Read', { file_path: path.join(proj, 'src', 'A.java') }, 'class A {}'), H.tr.say('探索完了')];
  const j1 = session(first);
  H.ok('选了探索、没调技能直接建变更：放行，记成在流程里', !NO.test(H.reasonOf(cmd(j1, 'openspec new change c9'))) && S.flowState(j1).on === true && S.flowState(j1).stage === 'plan', S.flowState(j1));
  H.transcript(j1.transcript_path, first.concat([H.tr.user('范围就这些，接着写吧')]).flat());
  H.hook(h, 'task-anchor', Object.assign({}, j1, { prompt: '范围就这些，接着写吧', hook_event_name: 'UserPromptSubmit' }));
  H.ok('下一轮调 /opsx:propose：不再拦"没说要走 OpenSpec"', !NO.test(H.reasonOf(skill(j1, 'opsx:propose'))), H.reasonOf(skill(j1, 'opsx:propose')));
  // 模型什么 OpenSpec 的动作都没做：点了 /opsx 的答案，钩子自己记成在流程里
  const j2 = session([big, ans('这个需求改动较大，怎么推进？', '走 /opsx:explore 探索')]);
  S.readConfigFor(j2);
  H.ok('答案里点了 /opsx:explore：随便哪个钩子读开关时就记成在流程里', S.flowState(j2).on === true && S.flowState(j2).stage === 'plan', S.flowState(j2));
  S.setFlow(j2, false, '用户说退出流程');
  S.readConfigFor(j2);
  H.ok('同一个答案只认一次：退出流程之后不再按它进', S.flowState(j2).on !== true, S.flowState(j2));
  // 普通问答里选了"探索代码库"：不进流程，改代码不被"没开工不改源码"拦
  const j3 = session([H.tr.user('看看这个报错是哪来的'), ans('要我先探索一下代码再回答吗？', '探索代码库')]);
  S.readConfigFor(j3);
  const e3 = H.hook(h, 'pre-edit', Object.assign({}, j3, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' } }));
  H.ok('普通问答里选了"探索代码库"：不进流程，改代码不拦', S.flowState(j3).on !== true && !/开工/.test(H.reasonOf(e3)), [S.flowState(j3), H.reasonOf(e3)]);
}

H.section('#464：壳子里子项目名下的验证证据，从壳子根看也算（全面自测登记得上）');
{
  const h = H.makeHome('f1113-shell', FROM, { commitMode: 'off' });
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const E = require(path.join(h.kit, 'lib', 'evidence.js'));
  const files = Object.assign({ 'README.md': '# 壳子\n', '.gitignore': '.vibe/\napi/\nweb/\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n', 'openspec/explore/订单.md': EXPLORE_OK }, DOCS('c1', '## 1. 导出\n\n- [x] 1.1 改 api/src/A.java\n'));
  const shell = H.makeRepo(path.join(h.work, 'shell'), files);
  const api = H.makeRepo(path.join(shell, 'api'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  H.makeRepo(path.join(shell, 'web'), { 'package.json': '{"name":"web"}\n', 'src/a.js': '1\n' });
  H.ok('前提：认得出是壳子', S.isShell(shell) === true && S.nestedRepos(shell).length === 2);
  H.hook(h, 'after-tool', { session_id: 's-shell', cwd: shell, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'mvn -q -f api/pom.xml -o compile -DskipTests' }, tool_response: { stdout: 'BUILD SUCCESS', stderr: '', interrupted: false }, transcript_path: H.transcript(path.join(h.root, 'shell.jsonl'), [H.tr.user('编译一下')]) });
  const rows = S.readState('evidence').rows || [];
  H.ok('前提：mvn -f api/pom.xml 的证据记在子项目 api 名下', rows.length === 1 && path.basename(rows[0].root) === 'api', rows.map((r) => r.root));
  H.ok('从子项目看得到', E.commands(api).length === 1);
  H.ok('从壳子根也看得到（以前是 0 条）', E.commands(shell).length === 1, E.commands(shell));
  const res = path.join(h.root, 'shell-res.json'); H.write(res, JSON.stringify([{ case: 'AC-1', result: 'pass', note: '编译过了' }]));
  const w = spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js'), 'selftest', '--task', '订单', '--results', res, '--project', shell], { cwd: shell, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  H.ok('壳子根登记全面自测（有 pass 的用例）：登记得上（以前报"还没有本机跑过的验证命令记录"）', /"ok": true/.test(w.stdout), w.stdout + w.stderr);
  H.write(path.join(api, 'src', 'A.java'), 'class A { int changed; }\n');
  H.ok('子项目的代码改了：那条证据不再算', E.commands(shell).length === 0 && E.commands(api).length === 0);
}

H.section('#462：提交的祈使句（只放宽提交，推送照旧）');
{
  const h = H.makeHome('f1113-commit', FROM, { commitMode: 'off' });
  const I = require(path.join(h.kit, 'lib', 'intent.js'));
  for (const s of ['分功能提交代码', '把代码提交了', '按功能分开提交', '分批提交一下代码', '代码提交一下吧', '把这些改动都提交掉', '改好了，分模块提交']) H.ok('"' + s + '"：算说了提交', I.explicit(s, 'commit') === true);
  for (const s of ['分支提交', '分析提交记录', '分页提交表单', '依赖提交', '代码提交了', '把代码提交了吗', '代码提交了没', '提交前我再看看', '先别提交代码']) H.ok('"' + s + '"：不算', I.explicit(s, 'commit') === false);
  for (const s of ['分功能推送代码', '代码推送一下吧', '把代码归档了']) H.ok('"' + s + '"：推送、归档没跟着放宽', I.explicit(s, 'push') === false && I.explicit(s, 'archive') === false);
  // 提交方式是"关"，用户说"分功能提交代码"：git commit 放行
  const proj = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
  const tp = H.transcript(path.join(h.root, 'commit.jsonl'), [H.tr.user('分功能提交代码')]);
  H.hook(h, 'task-anchor', { session_id: 's-commit', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: '分功能提交代码', transcript_path: tp });
  const r = H.hook(h, 'guard-commit', { session_id: 's-commit', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-c', tool_input: { command: 'git -C "' + proj.replace(/\\/g, '/') + '" commit -m "feat: 加字段" -- src/A.java' }, transcript_path: tp });
  H.ok('提交方式"关"、用户说"分功能提交代码"：git commit 不再被拦', !/提交方式是"关"/.test(H.reasonOf(r)), H.reasonOf(r));
}

H.section('#463：用户这一轮只让起服务，改代码前拦一次');
{
  const h = H.makeHome('f1113-start', FROM, { commitMode: 'off' });
  const I = require(path.join(h.kit, 'lib', 'intent.js'));
  const startOnly = I.startOnly || (() => '旧版没有 startOnly');
  for (const s of ['启动项目', '重启一下后端', '把 OA 跑起来', '启动项目看看']) H.ok('"' + s + '"：只是让起服务', startOnly(s) === true, startOnly(s));
  for (const s of ['启动项目，起不来就修一下', '启动项目并验证导出', '改一下启动脚本', '启动流程怎么走？', '把导出做了然后启动项目']) H.ok('"' + s + '"：不算只让起服务', startOnly(s) === false, startOnly(s));
  const proj = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  let k = 0;
  const edit = (prompt, file, extra) => { const sid = 'st' + (++k); const tp = H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user(prompt)].concat(extra || [])); const call = () => H.hook(h, 'pre-edit', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, file), old_string: '<project/>', new_string: '<project></project>' }, transcript_path: tp }); return { first: call(), again: call }; };
  const a = edit('启动项目', 'pom.xml');
  H.ok('只说了"启动项目"：改 pom.xml 拦下，让它先说原因、问用户', blocked(a.first) && /没让改代码/.test(H.reasonOf(a.first)) && /提问框/.test(H.reasonOf(a.first)), H.reasonOf(a.first));
  H.ok('这一轮只拦一次：问过之后再改放行', !/没让改代码/.test(H.reasonOf(a.again())));
  H.ok('"启动项目，起不来就修一下"：不拦', !/没让改代码/.test(H.reasonOf(edit('启动项目，起不来就修一下', 'pom.xml').first)));
  H.ok('只说了启动、往 .vibe/tmp 里写脚本：不拦', !/没让改代码/.test(H.reasonOf(edit('启动项目', '.vibe/tmp/run/start.xml').first)));
  H.ok('它已经先问过用户了（这一轮有提问框的答案）：不拦', !/没让改代码/.test(H.reasonOf(edit('启动项目', 'pom.xml', ans('起不来，缺一个依赖，要改 pom.xml 吗？', '改（pom.xml）')).first)));
  const dev = H.read(path.join(SRCDIR, 'kit', 'tools', 'devserver.js')) || '';
  H.ok('devserver 起不来的输出里带一句"要改东西才能起的先问用户"', /先把原因和要改哪些文件告诉用户/.test(dev) && /进程已经停了，看上面的日志。' \+ ASK_BEFORE_FIX/.test(dev));
}

H.section('#466：审查超出预期用时，按套件这头的用时比');
{
  const h = H.makeHome('f1113-review-time', FROM, { commitMode: 'off' });
  const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
  const proj = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>\n' });
  const job = (id, calls, status) => ({ id, key: id, mode: 'code', lenses: ['第1批', '第2批'], started: 0, expectMs: 300000, files: 3, chars: 14000, root: proj,
    state: { '第1批': { status: status || 'submitted', doneAt: 600000, calls: calls[0] }, '第2批': { status: 'submitted', doneAt: 300000, calls: calls[1] } } });
  const report = R.reportReview || (() => ({ id: '旧版没有导出 reportReview' }));
  const logOf = () => H.read(path.join(h.kit, 'state', 'hooks.log')) || '';
  // 总用时 677 秒，最慢的那一批模型那头 669 秒：套件这头 8 秒
  const r1 = report({ spentMs: 677000, status: 'completed' }, job('j1', [[{ ms: 677000, apiMs: 669000, chars: 342000, out: 114305 }], [{ ms: 311000, apiMs: 304000, chars: 343000, out: 50937 }]]));
  H.ok('时间都在模型那头（677 秒里 669 秒）：不建议题，只记进流水账', r1 === null && /模型那头 669 秒，套件这头 8 秒，不建议题/.test(logOf()), [r1, logOf().slice(-200)]);
  const r2 = report({ spentMs: 700000, status: 'completed' }, job('j2', [[{ ms: 120000, apiMs: 100000, chars: 1000, out: 10 }], [{ ms: 90000, apiMs: 80000, chars: 1000, out: 10 }]]));
  H.ok('套件这头慢（700 秒里模型只占 100 秒）：照旧上报，写明两头各多少', !!r2 && !!r2.id && /套件这头 600 秒/.test(H.read(r2.file || '') || JSON.stringify(r2)), r2);
  const r3 = report({ spentMs: 1300000, status: 'completed' }, job('j3', [[{ ms: 1200000, killed: true, chars: 1000, out: 0 }], [{ ms: 90000, apiMs: 80000, chars: 1000, out: 10 }]]));
  H.ok('到上限被结束的那次整段算模型那头：不建议题', r3 === null, r3);
  const r4 = report({ spentMs: 400000, status: 'completed' }, job('j4', [[{ ms: 390000, chars: 1000, out: 10 }], [{ ms: 90000, chars: 1000, out: 10 }]]));
  H.ok('模型没报用时（老版本）：照旧按总用时比，超了上报', !!r4 && !!r4.id, r4);
  const r5 = report({ spentMs: 100000, status: 'partial' }, job('j5', [[{ ms: 90000, apiMs: 80000, chars: 1000, out: 0 }], [{ ms: 90000, apiMs: 80000, chars: 1000, out: 10 }]], 'failed'));
  H.ok('有角度没交结论：照旧上报', !!r5 && !!r5.id, r5);
}

H.section('#458—#461、#465：流程视图里要算审查指纹的几项用到才算（读开关不再起 git diff）');
{
  const t = verifying('f1113-lazy', true);
  const { S, j } = t;
  const I = require(path.join(t.h.kit, 'lib', 'invocation.js'));
  // 开工基线记上：代码审查的指纹要跑 git diff <基线>（真实的会话里开工时就记了）
  require(path.join(t.h.kit, 'lib', 'review-runner.js')).baseline(j, [t.d]);
  const phasesOf = (fn) => { const seen = []; const out = I.run(fn, { budgetMs: 60000, onPhase: (n) => seen.push(n) }); return { seen, out }; };
  const auto = phasesOf(() => S.readConfigFor(j));
  H.ok('开着自动的会话读开关：不起 git diff（以前每个钩子都算一遍"代码审查都过了没有"）', !auto.seen.some((n) => /^Git diff/.test(n)), auto.seen);
  const wait = phasesOf(() => S.flowView(j).awaitingUser);
  H.ok('真要用的地方（收工交报告看 awaitingUser）照样算得出来', wait.out === true && wait.seen.some((n) => /^Git /.test(n)), [wait.out, wait.seen]);
  S.setSessionAuto(j, false, '测试：人工');
  const manual = phasesOf(() => S.readConfigFor(j));
  H.ok('没开自动的会话读开关：一条 git 都不起', !manual.seen.some((n) => /^Git (diff|ls-files)/.test(n)) && manual.out.autoMode === false, manual.seen);
  H.ok('状态栏要的"等谁"照样有', S.flowView(j).waiting === '等你核验', S.flowView(j).waiting);
  const ws = H.read(path.join(SRCDIR, 'kit', 'lib', 'workspace.js')) || '';
  H.ok('git 的对象格式和仓库根一样记 10 分钟', /args\[1\] === '--show-toplevel' \|\| args\[1\] === '--show-object-format'/.test(ws));
}

H.done('第 88、89 条和议题 #458—#467');
