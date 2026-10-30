'use strict';
/*
 * 问题表第 19 条"动不动被拦、确认再确认"（2026-10-30，docs/feedback-20261030.md 的 A 批）：同一件事用户说过一次，就不再要他说第二遍。
 *   A4 提交、推送、归档认本轮最后一次明确表态：用户说了"改完提交并推送"，中间答了一个和提交无关的提问框，许可照旧有效（审核 R1）；
 *      答案里明说"先别提交"的，收回；用户下一次自己开口，从头算
 * 用法：node dev/test-confirm-once.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const stopped = (o) => blocked(o) || (!!o && !!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'ask');
const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');

H.section('A4 提交、推送：说过一次，中间答了别的提问框也照旧有效；明说"先别"的收回；下一次开口从头算');
{
  // 提交方式"关"：用户说了提交才提交（默认）
  const h = H.makeHome('tco-a4', FROM, { commitMode: 'off' });
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'src/A.java': 'class A {}\n' });
  const bare = path.join(h.root, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { windowsHide: true });
  H.git(proj, ['remote', 'add', 'origin', bare]);
  H.git(proj, ['push', '-q', '-u', 'origin', 'HEAD']);
  let n = 0;
  const edit = H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok');
  const run = (command, entries) => { n++; return H.hook(h, 'guard-commit', { session_id: 's-a4-' + n, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_a4_' + n, transcript_path: H.transcript(path.join(h.root, 'a4-' + n + '.jsonl'), entries) }); };
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
  const commit = 'git add src/A.java && git commit -m "fix: A 加字段"';
  const said = H.tr.user('A 加个字段，改完提交并推送');
  const r1 = run(commit, [said, edit, ...ask('要不要审查一下这处改动？', '审查'), H.tr.say('审过了，没问题')]);
  H.ok('说了"改完提交并推送"，中间答了"要不要审查"：提交照旧放行', !stopped(r1), r1);
  const r2 = run('git push', [said, edit, ...ask('要不要审查一下这处改动？', '审查'), H.tr.say('审过了，提交好了')]);
  H.ok('同样的情况：推送照旧放行', !stopped(r2), r2);
  const r3 = run(commit, [said, edit, ...ask('导出用哪种格式？', 'xlsx，先别提交'), H.tr.say('好')]);
  H.ok('后面的提问框里明说"先别提交"：提交拦下', stopped(r3), r3);
  const r4 = run('git push', [H.tr.user('推送'), H.tr.say('推好了'), H.tr.user('再看看状态')]);
  H.ok('上一轮说的推送，用户这一轮换了话题：推送拦下', stopped(r4), r4);
}

const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false };
const DESIGN = '## Context\n\n- 读过 src/A.java\n\n## Decisions\n\n- 放在 A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 返回 200 | 人工 | 1 |\n';
const CHANGE = {
  'openspec/changes/feat-019/proposal.md': '## Why\n\n要导出。\n\n## What Changes\n\n- 改 src/A.java\n',
  'openspec/changes/feat-019/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  'openspec/changes/feat-019/design.md': DESIGN,
  'openspec/changes/feat-019/tasks.md': '- [ ] 1.1 改 src/A.java：加导出\n',
};

H.section('A5 开工：问的是"能开工吗"、答"可以"也算开工；之后又答了提交那一问，开工照旧算；答"先不"的不算');
{
  const h = H.makeHome('tco-a5', FROM, QUIET);
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  let n = 0;
  // 打勾：还没开工时打勾会被拦（提案阶段改业务代码本来就不拦，看不出开没开工）；开工认下来，流程切到做任务那一段
  const tick = (entries) => { n++; const sid = 's-a5-' + n; H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019')], true, 'plan'); const r = H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/feat-019/tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: H.transcript(path.join(h.root, 'a5-' + n + '.jsonl'), entries) }); return { r, stage: S.flowState({ session_id: sid }).stage }; };
  const base = [H.tr.user('写 feat-019 的需求'), H.tr.say('feat-019 的四份文档都写完了')];
  const t1 = tick(base.concat(ask('feat-019 写完了，能开工吗？', '可以')));
  H.ok('问"能开工吗"、答"可以"：认成开工', t1.stage === 'apply' && !blocked(t1.r), [t1.stage, H.reasonOf(t1.r)]);
  const t2 = tick(base.concat(ask('feat-019 写完了，能开工吗？', '可以'), ask('要不要提交定稿？', '提交定稿')));
  H.ok('答了开工之后又答了"提交定稿"：开工照旧算', t2.stage === 'apply' && !blocked(t2.r), [t2.stage, H.reasonOf(t2.r)]);
  const t3 = tick(base.concat(ask('feat-019 写完了，能开工吗？', '先不')));
  H.ok('问开工、答"先不"：不算开工，打勾拦下', t3.stage !== 'apply' && blocked(t3.r), [t3.stage, H.reasonOf(t3.r)]);
  const t4 = tick(base.concat(ask('tasks 写完了，怎么定？', '定稿并开工')));
  H.ok('写完 tasks 那一问选"定稿并开工"：认成开工', t4.stage === 'apply' && !blocked(t4.r), [t4.stage, H.reasonOf(t4.r)]);
}

H.section('A7 写完 tasks：定稿和开工合成一问，选过的不再另问开工');
{
  const h = H.makeHome('tco-a7', FROM, QUIET);
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  const F = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  const c = { name: 'feat-019', dir: path.join(p, 'openspec', 'changes', 'feat-019') };
  let n = 0;
  const next = (answer) => { n++; const entries = [H.tr.user('写 feat-019 的需求'), H.tr.say('tasks 写完了')].concat(answer ? ask('feat-019 的 tasks 写完了，怎么定？', answer) : []); return F.planNext({ session_id: 's-a7-' + n, cwd: p, transcript_path: H.transcript(path.join(h.root, 'a7-' + n + '.jsonl'), entries) }, c) || ''; };
  const go = next('定稿并开工');
  H.ok('选了"定稿并开工"：直接开工，不再给"执行 apply / 继续修改 / 暂不执行"', /直接开工/.test(go) && !/暂不执行/.test(go), go);
  H.ok('选了"只定稿"：不再问开工', next('只定稿') === '', next('只定稿'));
  H.ok('没选过（旧流程）：照旧问开工', /执行 apply \/ 继续修改 \/ 暂不执行/.test(next('')), next(''));
}

H.section('A8 人工模式改完代码：问一次审查、自测，答了不用，这个会话后面再改代码不再问');
{
  const h = H.makeHome('tco-a8', FROM, QUIET);
  const p = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n' });
  const F = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  const sid = 's-a8';
  const edit = (f) => H.tr.ran('Edit', { file_path: path.join(p, 'src', f), old_string: 'x', new_string: 'y' }, 'ok');
  const stop = (n, entries) => { H.write(path.join(p, 'src', 'A.java'), 'class A { int v' + n + '; }\n'); return (F.stop({ session_id: sid, cwd: p, transcript_path: H.transcript(path.join(h.root, 'a8-' + n + '.jsonl'), entries) }, [], true, n, null, Date.now()) || []).join('\n'); };
  const t1 = [H.tr.user('修一下 A 的空指针'), edit('A.java'), H.tr.say('改好了')];
  const s1 = stop(1, t1);
  H.ok('第一次改完：问审查、自测', /询问是否审查、是否自测/.test(s1) && !/验收用例/.test(s1), s1);
  const s2 = stop(2, t1.concat(ask('要不要审查、自测？', '都不用')));
  H.ok('答了都不用：这一轮不再问', !/询问是否/.test(s2), s2);
  const s3 = stop(3, t1.concat(ask('要不要审查、自测？', '都不用'), H.tr.user('再把 B 也改一下'), edit('B.java'), H.tr.say('B 也改好了')));
  H.ok('下一轮又改了代码：这个会话里不再问', !/询问是否/.test(s3), s3);
}

H.done('同一件事不再确认第二遍（问题表第 19 条）');
