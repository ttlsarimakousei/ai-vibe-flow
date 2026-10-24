'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 2 类：开工许可
 *   #214 两个变更时说"开工"、敲 /opsx:apply 认不出开哪个，打勾、调技能都被"我还没说开工"拦；拦截提示不说原因
 *   旧第 2 类（#187 补充）提案修订后提问框选"开工"，改业务代码仍被拦（pre-edit 没补读开工答案）
 * 用法：node dev/test-feedback1024-apply.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false };
const h = H.makeHome('feedback1024-apply', process.argv[2], QUIET);
const S = require(path.join(h.kit, 'lib/session'));
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
let seq = 0;
const tf = (es) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), es);
const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');
const DESIGN = '## Context\n\n- 读过 src/A.java\n\n## Decisions\n\n- 放在 A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 返回 200 | 人工 | 1 |\n';
const change = (name) => ({
  ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要做 ' + name + '。\n\n## What Changes\n\n- 改 src/A.java\n',
  ['openspec/changes/' + name + '/specs/x/spec.md']: '## ADDED Requirements\n\n### Requirement: 做\n\n系统 SHALL 做。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  ['openspec/changes/' + name + '/design.md']: DESIGN,
  ['openspec/changes/' + name + '/tasks.md']: '- [ ] 1.1 改 src/A.java：加功能\n',
});
const repo = (name) => H.makeRepo(path.join(h.work, name), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, change('feat-019'), change('opt-group')));
const tick = (p, sid, entries, name) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/' + (name || 'feat-019') + '/tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: tf(entries) });
const prompt = (p, sid, text, entries) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: tf(entries) });

// ---------------------------------------------------------------------------------------------
H.section('#214 两个变更时说开工：看模型刚才那段话、这一步要改哪个变更');
{
  const p = repo('two');
  const sid = 's-two';
  H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019'), path.join(p, 'openspec/changes/opt-group')], true, 'plan');
  // 模型刚才说的是 feat-019，用户回一句"开工"
  const es = [H.tr.user('写 feat-019 的需求'), H.tr.say('feat-019 的提案、规格、设计、任务都写完了，能开工吗？'), H.tr.user('开工')];
  prompt(p, sid, '开工', es);
  H.ok('用户开口：模型刚才只说了 feat-019，"开工"认成开工 feat-019', S.flowState({ session_id: sid }).stage === 'apply' && !!(S.flowState({ session_id: sid }).applyScope || {}).dirs, S.flowState({ session_id: sid }));
  const r = tick(p, sid, es);
  H.ok('开工之后给 feat-019 打勾：放行', !blocked(r), H.reasonOf(r));
  const other = tick(p, sid, es, 'opt-group');
  H.ok('开工的是 feat-019：给 opt-group 打勾照拦', blocked(other) && /不在当前 apply 许可里/.test(H.reasonOf(other)), H.reasonOf(other));
}
{
  const p = repo('two-tick');
  const sid = 's-two-tick';
  H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019'), path.join(p, 'openspec/changes/opt-group')], true, 'plan');
  // 模型刚才那段话两个都提了：打勾时按要改的那个认
  const es = [H.tr.user('两个变更都写完了'), H.tr.say('feat-019 和 opt-group 的文档都写好了。'), H.tr.user('开工')];
  prompt(p, sid, '开工', es);
  H.ok('用户开口：两个都提了，开口时定不了，留在提案阶段', S.flowState({ session_id: sid }).stage === 'plan');
  const r = tick(p, sid, es, 'opt-group');
  H.ok('打勾时按要改的 opt-group 认：放行', !blocked(r), H.reasonOf(r));
}
{
  const p = repo('two-skill');
  const sid = 's-two-skill';
  H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019'), path.join(p, 'openspec/changes/opt-group')], true, 'plan');
  const es = [H.tr.user('都写完了'), H.tr.user('开工')];
  prompt(p, sid, '开工', es);
  const r = H.hook(h, 'guard-ask', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'opsx:apply' }, transcript_path: tf(es) });
  H.ok('两个变更、哪都没点名：调 /opsx:apply 拦下，提示说出两个变更名、让用户说"开工 <名字>"', blocked(r) && /feat-019/.test(H.reasonOf(r)) && /opt-group/.test(H.reasonOf(r)) && /开工 feat-019|开工 opt-group/.test(H.reasonOf(r)), H.reasonOf(r));
  const r2 = H.hook(h, 'guard-ask', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'opsx:apply', args: 'opt-group' }, transcript_path: tf(es) });
  H.ok('/opsx:apply 带了变更名 opt-group：放行（开工 opt-group）', !blocked(r2) && !!(S.flowState({ session_id: sid }).applyScope || { dirs: {} }).dirs[S.normKey(path.join(p, 'openspec/changes/opt-group'))], H.reasonOf(r2));
}
{
  const p = repo('two-ask');
  const sid = 's-two-ask';
  H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019'), path.join(p, 'openspec/changes/opt-group')], true, 'plan');
  const es = [H.tr.user('都写完了'), ...ask('feat-019 和 opt-group 能开工吗？', '开工')];
  const r = tick(p, sid, es);
  H.ok('提问框问了两个变更、答"开工"不点名：打勾拦下，提示说问题里有两个变更、选项要写明', blocked(r) && /feat-019、opt-group/.test(H.reasonOf(r)) && /选项写明变更名/.test(H.reasonOf(r)), H.reasonOf(r));
}

// ---------------------------------------------------------------------------------------------
H.section('旧第 2 类：提案修订后提问框选开工，改业务代码放行');
{
  const p = repo('revise');
  const sid = 's-revise';
  const S2 = S; const A = require(path.join(h.kit, 'lib/apply-scope'));
  const j = { cwd: p, session_id: sid, transcript_path: tf([H.tr.user('开工 feat-019')]) };
  S2.setFlow(j, true, '开工', 'apply'); A.grant(j, '开工 feat-019');
  // 修订提案（内容改了），之后再改一次产物：范围回到提案阶段
  H.write(path.join(p, 'openspec/changes/feat-019/proposal.md'), '## Why\n\n要做。\n\n## What Changes\n\n- 改 src/A.java 和导出\n');
  const rev = { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/feat-019/proposal.md'), old_string: '- 改 src/A.java 和导出', new_string: '- 改 src/A.java 和导出、打印' }, transcript_path: tf([H.tr.user('提案里加上导出')]) };
  H.hook(h, 'pre-edit', rev);
  H.ok('修订后回到提案阶段、等重新开工', S2.flowState(j).stage === 'plan' && S2.flowState(j).waiting === 'scope', S2.flowState(j));
  const code = (entries) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src/A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, transcript_path: tf(entries) });
  const before = code([H.tr.user('提案里加上导出'), H.tr.say('改好了')]);
  H.ok('还没重新开工：改业务代码拦下', blocked(before) && /提案已修订/.test(H.reasonOf(before)), H.reasonOf(before));
  const after = code([H.tr.user('提案里加上导出'), H.tr.say('改好了'), ...ask('feat-019 修订完了，能开工吗？', '开工')]);
  H.ok('提问框选了开工：改业务代码放行（改代码前补读开工答案）', !blocked(after), H.reasonOf(after));
  // 还在做任务那一段、需求改了以后直接改代码（没再改产物，阶段没退回）：新的开工答案也能重新开工
  const u0 = H.tr.user('开工 feat-019');
  const sid2 = 's-revise-2'; const j2 = { cwd: p, session_id: sid2, transcript_path: tf([u0]) };
  S2.setFlow(j2, true, '开工', 'apply'); A.grant(j2, '开工 feat-019');
  H.write(path.join(p, 'openspec/changes/feat-019/design.md'), DESIGN + '\n- 导出放在 B.java\n');
  const code2 = (entries) => H.hook(h, 'pre-edit', { session_id: sid2, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src/A.java'), old_string: 'class A {}', new_string: 'class A { int y; }' }, transcript_path: tf(entries) });
  const stale = code2([u0, H.tr.say('设计改好了')]);
  H.ok('需求改了、旧开工范围失效：改代码拦下', blocked(stale) && /需求、设计或任务验法已变化/.test(H.reasonOf(stale)), H.reasonOf(stale));
  const again = code2([u0, H.tr.say('设计改好了'), ...ask('设计改了，feat-019 能接着开工吗？', '开工')]);
  H.ok('提问框又选了开工：重新开工，改代码放行', !blocked(again), H.reasonOf(again));
}
H.done('1024 反馈：开工许可');
