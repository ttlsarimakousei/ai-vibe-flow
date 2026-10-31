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
// 收工提示里"去问审查、自测"的两种说法（10-30 起：用一个提问框问，一件事一个问题）
const ASKED = /询问是否|Ask 问是否|一件事一个问题：要不要/;
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
  H.ok('没选过（旧流程）：照旧问开工', /执行 apply \/ 继续修改 \/ 暂不执行|问能不能开工/.test(next('')), next(''));
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
  H.ok('第一次改完：问审查、自测', ASKED.test(s1) && !/验收用例/.test(s1), s1);
  const s2 = stop(2, t1.concat(ask('要不要审查、自测？', '都不用')));
  H.ok('答了都不用：这一轮不再问', !ASKED.test(s2), s2);
  const s3 = stop(3, t1.concat(ask('要不要审查、自测？', '都不用'), H.tr.user('再把 B 也改一下'), edit('B.java'), H.tr.say('B 也改好了')));
  H.ok('下一轮又改了代码：这个会话里不再问', !ASKED.test(s3), s3);
}

H.section('A9 审查意见：答"不改"不作废审查许可；答"改"算准了复验；这一轮说过审查、自测的，收工不再提示去问');
{
  const h = H.makeHome('tco-a9', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const F = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  let n = 0;
  const es = (entries) => S.tailEntries(H.transcript(path.join(h.root, 'a9-' + (++n) + '.jsonl'), entries), 3000000);
  const r1 = S.userSaid(es([H.tr.user('审一下 feat-019 的代码'), H.tr.say('审完了，有 2 条'), ...ask('审查意见第 1 条：日志里打了手机号，改不改？', '不改')]), 'review');
  H.ok('对一条审查意见答"不改"：审查许可照旧有效', r1.ok, r1);
  const r2 = S.userSaid(es([H.tr.user('审一下 feat-019 的代码'), H.tr.say('审完了'), ...ask('第 1 条意见：空指针，改不改？', '改（推荐）')]), 'test');
  H.ok('对一条审查意见答"改"：改完的自测、复验算准了', r2.ok, r2);
  // 复审 V11：问题里只是带"问题"二字的不算意见那一问；意见提到测试、答"不改"，不作废自测许可
  const r3 = S.userSaid(es([H.tr.user('导出报错了'), H.tr.say('找到原因了'), ...ask('这个问题怎么处理？', '改用方案 B')]), 'test');
  H.ok('V11 "这个问题怎么处理？"答"改用方案 B"：不算自测许可', !r3.ok, r3);
  const r4 = S.userSaid(es([H.tr.user('审一下 feat-019 的代码，改完测一下'), H.tr.say('审完了，有 2 条'), ...ask('审查意见第 2 条：缺少单元测试，改不改？', '不改')]), 'test');
  H.ok('V11 意见提到测试、答"不改"：前面的自测许可照旧有效', r4.ok, r4);
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE, { 'openspec/changes/feat-019/tasks.md': '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n' }));
  const dir = path.join(p, 'openspec', 'changes', 'feat-019');
  const stop = (sid, entries) => { H.inFlow(h, sid, [dir], true, 'apply'); return (F.stop({ session_id: sid, cwd: p, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), entries) }, [dir], true, 1, null, Date.now()) || []).join('\n'); };
  const edit = H.tr.ran('Edit', { file_path: path.join(p, 'src', 'A.java'), old_string: 'a', new_string: 'b' }, 'ok');
  const s1 = stop('s-a9-1', [H.tr.user('做 1.1'), edit, H.tr.say('1.1 做完了')]);
  H.ok('没说审查、自测：第 1 组做完，提示去问', ASKED.test(s1), s1);
  const s2 = stop('s-a9-2', [H.tr.user('做 1.1，做完审查并自测'), edit, H.tr.say('1.1 做完了')]);
  H.ok('这一轮说了审查、自测：收工不再提示去问', !ASKED.test(s2), s2);
}

H.section('A10 会被拦的规矩提前说：进写需求、做任务这两段时各说一次');
{
  const h = H.makeHome('tco-a10', FROM, QUIET);
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  let n = 0;
  const say = (sid, prompt) => { n++; const r = H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'a10-' + n + '.jsonl'), [H.tr.user(prompt)]) }); return typeof r === 'string' ? r : JSON.stringify(r || ''); };
  const t1 = say('s-a10', '做一个订单导出的功能，导出成 xlsx');
  H.ok('提需求：说了写需求这一段的规矩（一份一份写、审查带审查点）', /写需求这一段的规矩/.test(t1) && /一份一份写/.test(t1) && /--point/.test(t1), t1.slice(0, 600));
  const t2 = say('s-a10', '再加一个按日期筛选的需求');
  H.ok('同一个会话第二次提需求：不再重复', !/写需求这一段的规矩/.test(t2), t2.slice(0, 300));
  const t3 = say('s-a10', '开工 feat-019');
  H.ok('开工：说了做任务这一段的规矩（devserver、git add、不串 cd）', /做任务这一段的规矩/.test(t3) && /devserver\.js/.test(t3) && /git -C/.test(t3), t3.slice(0, 600));
}

H.section('A11 斜杠命令：/vk-commit、/vk-push、/vk-archive、/vk-review、/vk-test 算许可，/vk-go 算开工，/vk-fix 不问审查自测；安装器装、卸');
{
  const h = H.makeHome('tco-a11', FROM, Object.assign({}, QUIET, { commitMode: 'off' }));
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const F = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  const SRC_CMDS = path.join(FROM || H.SRC, 'claude', 'commands');
  // 敲了自定义命令，会话记录里是两条：带 <command-name> 的一条，和 isMeta 的命令正文（正文里的字不算用户说的）
  const cmd = (name, args) => [H.tr.user('<command-message>' + name + '</command-message>\n<command-name>/' + name + '</command-name>\n<command-args>' + (args || '') + '</command-args>'),
    Object.assign(H.tr.user(H.read(path.join(SRC_CMDS, name + '.md')) || ('（' + name + ' 的正文）先别推送，先别提交')), { isMeta: true })];
  let n = 0;
  const es = (entries) => S.tailEntries(H.transcript(path.join(h.root, 'a11-' + (++n) + '.jsonl'), entries), 3000000);
  for (const [c, topic] of [['vk-commit', 'commit'], ['vk-push', 'push'], ['vk-archive', 'archive'], ['vk-review', 'review'], ['vk-test', 'test']]) {
    const r = S.userSaid(es([H.tr.user('改一下 A'), H.tr.say('改好了'), ...cmd(c)]), topic);
    H.ok('/' + c + '：算' + topic + '许可', r.ok, r);
  }
  const r0 = S.userSaid(es([...cmd('vk-review'), H.tr.say('审完了')]), 'push');
  H.ok('/vk-review 不算推送许可', !r0.ok, r0);
  // 推送走真钩子：只有 /vk-push、没说过"推送"两个字也放行
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'src/A.java': 'class A {}\n' });
  const bare = path.join(h.root, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { windowsHide: true });
  H.git(proj, ['remote', 'add', 'origin', bare]);
  H.git(proj, ['push', '-q', '-u', 'origin', 'HEAD']);
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
  H.git(proj, ['commit', '-qam', 'fix: A 加字段']);
  const push = (entries) => { n++; return H.hook(h, 'guard-commit', { session_id: 's-a11-' + n, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_a11_' + n, transcript_path: H.transcript(path.join(h.root, 'a11p-' + n + '.jsonl'), entries) }); };
  const p1 = push([H.tr.user('A 加个字段'), H.tr.say('改好提交了'), ...cmd('vk-push')]);
  H.ok('敲了 /vk-push：git push 放行', !stopped(p1), p1);
  const p2 = push([H.tr.user('A 加个字段'), H.tr.say('改好提交了'), ...cmd('vk-commit')]);
  H.ok('只敲了 /vk-commit：git push 照旧拦', stopped(p2), p2);
  // /vk-go 开工：打勾不拦、流程切到做任务那一段
  const p = H.makeRepo(path.join(h.work, 'proj2'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  const tick = (sid, entries) => { H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019')], true, 'plan'); const r = H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/feat-019/tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), entries) }); return { r, stage: S.flowState({ session_id: sid }).stage }; };
  const g1 = tick('s-a11-go', [H.tr.user('写 feat-019 的需求'), H.tr.say('四份文档都写完了'), ...cmd('vk-go', 'feat-019')]);
  H.ok('敲了 /vk-go feat-019：算开工，打勾不拦', !blocked(g1.r) && g1.stage === 'apply', g1);
  const say = (sid, prompt) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, sid + '-p.jsonl'), [H.tr.user(prompt)]) });
  say('s-a11-go2', '/vk-go feat-019');
  H.ok('用户开口就是 /vk-go：进了流程、在做任务那一段', S.flowState({ session_id: 's-a11-go2' }).on === true && S.flowState({ session_id: 's-a11-go2' }).stage === 'apply', S.flowState({ session_id: 's-a11-go2' }));
  // 状态栏：在等你自测验收时，写下一步说什么
  const norm = (x) => path.resolve(x).split(path.sep).join('/').toLowerCase();
  H.write(path.join(h.kit, 'state', 's-a11-sl-flow.json'), JSON.stringify({ on: true, why: '测试', at: Date.now(), was: Date.now(), changes: [norm(path.join(p, 'openspec/changes/feat-019'))], stage: 'apply', waiting: '等用户自测验收' }));
  const sl = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: 's-a11-sl', cwd: p, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: p }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: p }).out.replace(/\x1b\[[0-9;]*m/g, '');
  H.ok('状态栏：等你自测验收时写"自测后说归档或 /vk-archive"', /等用户自测验收：自测后说归档或 \/vk-archive/.test(sl), sl);
  // /vk-fix：小改动这一轮不问审查、自测
  const fix = (sid, entries) => (H.write(path.join(proj, 'src', 'A.java'), 'class A { int ' + sid.replace(/\W/g, '') + '; }\n'), F.stop({ session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), entries) }, [], true, 1, null, Date.now()) || []).join('\n');
  const e1 = H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'a', new_string: 'b' }, 'ok');
  const f0 = fix('s-a11-f0', [H.tr.user('把 A 的字段改个名'), e1, H.tr.say('改好了')]);
  H.ok('普通说法改代码：收工问审查、自测', ASKED.test(f0), f0);
  const f1 = fix('s-a11-f1', [...cmd('vk-fix', '把 A 的字段改个名'), e1, H.tr.say('改好了')]);
  H.ok('/vk-fix 这一轮：收工不问审查、自测', !ASKED.test(f1), f1);
  // 安装器：装进 ~/.claude/commands；你改过的同名文件先备份；卸载时收回
  const pkg = (() => { if (!FROM) return H.makePackage('tco-a11-pkg', '20261030.1400'); const d = path.join(H.tempDir('tco-a11-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (x) => x === 'node_modules' || x === '.git'); H.stubDeps(d); return d; })();
  const u = H.freshHome('tco-a11-inst');
  H.write(path.join(u.cfg, 'commands', 'vk-push.md'), '我自己的 vk-push\n');
  const inst = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
  const names = ['vk-go', 'vk-commit', 'vk-push', 'vk-archive', 'vk-review', 'vk-test', 'vk-fix'];
  H.ok('装好后 ~/.claude/commands 下有 7 个 vk 命令', inst.code === 0 && names.every((x) => fs.existsSync(path.join(u.cfg, 'commands', x + '.md'))), inst.out.slice(-600));
  H.ok('你原来的同名 /vk-push 先备份了', /已有同名命令 \/vk-push/.test(inst.out), inst.out.slice(-600));
  H.write(path.join(u.cfg, 'commands', 'mine.md'), '我自己的命令\n');
  const un = H.node(u, path.join(u.kit, 'install.js'), ['--uninstall'], { cwd: u.root, timeout: 120000 });
  H.ok('卸载收回了 vk 命令、留下你自己的命令', un.code === 0 && names.every((x) => !fs.existsSync(path.join(u.cfg, 'commands', x + '.md'))) && fs.existsSync(path.join(u.cfg, 'commands', 'mine.md')), un.out.slice(-600));
}

H.section('A13 说法统一：开工选项一套写法；收工几件事分开列、提交排最后');
{
  const h = H.makeHome('tco-a13', FROM, Object.assign({}, QUIET, { commitMode: 'ask' }));
  const kit = h.kit;
  // 开工选项：套件给模型的话里只剩"开工 / 还要改 / 先不做"这一套（以前三套：apply 开工、执行 apply / 继续修改 / 暂不执行、Ask 提供 apply 选项）
  const files = ['hooks/guard-ask.js', 'hooks/guard-spec.js', 'hooks/verify-gate.js', 'hooks/task-anchor.js', 'lib/flow-policy.js'].map((f) => path.join(kit, f)).concat([path.join(kit, 'rules', '10-openspec.md')]);
  const old = files.filter((f) => /执行 apply \/ 继续修改|Ask 提供 apply 选项|"apply 开工"和"还要改"|选项写"开工"和"还要改"/.test(H.read(f) || ''));
  H.ok('提示和规范里没有旧的开工选项写法', old.length === 0, old);
  const S = require(path.join(kit, 'lib', 'session.js'));
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  let n = 0;
  const tick = (sid, entries) => { H.inFlow(h, sid, [path.join(p, 'openspec/changes/feat-019')], true, 'plan'); const r = H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/feat-019/tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), entries) }); return { r, stage: S.flowState({ session_id: sid }).stage }; };
  const base = [H.tr.user('写 feat-019 的需求'), H.tr.say('四份文档都写完了')];
  const g1 = tick('s-a13-go', base.concat(ask('feat-019 能开工吗？', '开工')));
  H.ok('新问法答"开工"：算开工', !blocked(g1.r) && g1.stage === 'apply', g1);
  const g2 = tick('s-a13-no', base.concat(ask('feat-019 能开工吗？', '先不做')));
  H.ok('新问法答"先不做"：不算开工', blocked(g2.r) && g2.stage === 'plan', g2);
  // 收工：问审查自测、问提交一起出现时，分开编号，提交那条在最后
  const q = H.makeRepo(path.join(h.work, 'proj2'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  H.write(path.join(q, 'src', 'A.java'), 'class A { int x; }\n');
  n++;
  const r = H.hook(h, 'verify-gate', { session_id: 's-a13-stop', cwd: q, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '改好了', transcript_path: H.transcript(path.join(h.root, 'a13-stop.jsonl'), [H.tr.user('A 加个字段'), ...H.tr.ran('Edit', { file_path: path.join(q, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok'), ...H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS'), H.tr.say('改好了')]) });
  const t = H.reasonOf(r) || '';
  const items = t.split('\n').filter((l) => /^\d+\. /.test(l));
  H.ok('几件事分开编号列出', /有 \d+ 件事，按顺序做（提交放最后）/.test(t) && items.length >= 2, t);
  H.ok('问提交那条排在最后', items.length >= 2 && /还没提交/.test(items[items.length - 1]) && !items.slice(0, -1).some((l) => /还没提交/.test(l)), items);
}

H.section('A12 /opsx:propose 装好后先说套件的规矩：只写 proposal 就停，一份一份来（不照原文一步全写）');
{
  const h = H.makeHome('tco-a12', FROM, QUIET, { openspec: true });
  const O = require(path.join(h.kit, 'lib', 'openspec.js'));
  const dir = path.join(h.root, 'claude-out');
  const r = O.installClaudeFiles(dir);
  H.ok('自带的 OpenSpec 生成了命令和技能', r.ok && r.files.length > 0, r.why || r.files);
  if (r.ok) {
    for (const rel of r.files.filter((f) => /propose/i.test(f))) {
      const t = H.read(path.join(dir, rel)) || '';
      H.ok(rel + '：插了套件的规矩，frontmatter 还在最前面', /vibe-kit 的规矩/.test(t) && /只建变更、写 proposal\.md，写完停下/.test(t) && (!/^---/.test(H.read(path.join(dir, rel)) || '') || /^---\r?\n[\s\S]*?\r?\n---\r?\n\n> \*\*vibe-kit 的规矩/.test(t)), t.slice(0, 400));
    }
    const other = r.files.find((f) => /opsx\/apply\.md$/i.test(f));
    H.ok('别的命令原样拷（不插这段）', !!other && !/vibe-kit 的规矩/.test(H.read(path.join(dir, other)) || ''), other);
  }
}

H.section('复审 V12：/vk-* 只能用户敲，模型自己调不算许可');
{
  const h = H.makeHome('tco-v12', FROM, QUIET);
  const p = H.makeRepo(path.join(h.work, 'proj'), { 'a.txt': 'x\n' });
  for (const [tool, input] of [['SlashCommand', { command: '/vk-push' }], ['Skill', { skill: 'vk-commit' }]]) {
    const r = H.hook(h, 'guard-ask', { session_id: 'v12', cwd: p, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, transcript_path: H.transcript(path.join(h.root, 'v12-' + tool + '.jsonl'), [H.tr.user('改完了吗')]) });
    H.ok('模型用 ' + tool + ' 调 ' + JSON.stringify(input) + '：拦下', /是给用户敲的/.test(H.reasonOf(r)), H.reasonOf(r));
  }
  const src = FROM || H.SRC;
  const cmds = fs.readdirSync(path.join(src, 'claude', 'commands')).filter((n) => /^vk-.*\.md$/.test(n));
  H.ok('命令文件都写了 disable-model-invocation: true', cmds.length >= 8 && cmds.every((n) => /^disable-model-invocation:\s*true\s*$/m.test(H.read(path.join(src, 'claude', 'commands', n)) || '')), cmds);
}

H.done('同一件事不再确认第二遍（问题表第 19 条）');
