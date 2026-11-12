'use strict';
/*
 * /vk-resume 接回大任务（2026-11-03）：阶段从文件算，显示进度，死机前开着自动才恢复，提交、推送、归档许可不恢复。
 * 2026-11-04（第 53、54、55 条）：不写名字只出提问框、不替用户挑；用户答了，收工钩子照答案切过去；答的 change 不在表里的先补进 plan.md；
 * 接回一个任务已经写好的 change 就算开工。
 * 用法：node dev/test-vk-resume.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('vk-resume', FROM, { commitMode: 'off' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));

let seq = 0;
function project(tasks) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'src/A.java': 'class A {}\n' });
  const os_ = path.join(proj, 'openspec');
  let plan = '# 计划\n';
  for (const [name, changes] of Object.entries(tasks)) {
    plan += '\n## ' + name + '\n\n探索记录：explore/' + name + '.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join('');
    H.write(path.join(os_, 'explore', name + '.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只做这些\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join(''));
  }
  H.write(path.join(os_, 'plan.md'), plan);
  fs.mkdirSync(path.join(os_, 'changes'), { recursive: true });
  return proj;
}
const ticks = (proj, c, done, todo) => H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '## 1. x\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 做完：src/A.java\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 没做：src/A.java\n').join(''));
function session(proj) { const sid = 's' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), []) }; }
const say = (j, prompt) => { H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { prompt, hook_event_name: 'UserPromptSubmit' })) || {}; };
const fl = (j) => S.flowState(j);
const asked = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q, header: '切换', options: [{ label: a }] }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');
// 用户敲了 /vk-resume、模型用提问框问了、用户答了 a，然后收工
const pickThen = (j, a) => { H.transcript(j.transcript_path, [H.tr.user('/vk-resume')].concat(asked('切到哪个 change？', a))); return H.hook(h, 'verify-gate', Object.assign({}, j, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '好的' })) || {}; };

H.section('没有大任务');
{
  const proj = H.makeRepo(path.join(h.work, 'empty'), { 'README.md': '# x\n' });
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('说没有，不进流程', /没有没归档的 change/.test(r.systemMessage || '') && !fl(j).on, r);
  const r2 = say(j, '/vk-resume 甲');
  H.ok('写了名字、没有大任务：说没有', /没有没做完的大任务/.test(r2.systemMessage || '') && !fl(j).on, r2);
}

H.section('死机后接回');
{
  const proj = project({ 订单导出: ['c1', 'c2', 'c3'] });
  ticks(proj, 'c1', 3, 0); ticks(proj, 'c2', 2, 3);
  const j = session(proj);
  const r = say(j, '/vk-resume 订单导出');
  H.ok('屏幕上显示进度，后面还有 c3', /c2 做到 2\/5/.test(r.systemMessage || '') && /后面还有 c3/.test(r.systemMessage || ''), r);
  H.ok('模型知道读什么', /探索记录/.test(H.reasonOf(r)) && /plan\.md/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('进流程，在 apply，记着大任务', fl(j).on === true && fl(j).stage === 'apply' && fl(j).task === '订单导出', fl(j));
  H.ok('开工范围有了', !!fl(j).applyScope && A.valid(j).ok, fl(j));
  H.ok('没开过自动：不开', S.sessionAuto(j) !== true);
  H.ok('许可不恢复：说了', /许可不恢复/.test(H.reasonOf(r)), H.reasonOf(r));
}

H.section('当前 change 还没开工：回到写需求');
{
  const proj = project({ 甲: ['c1', 'c2'] });
  ticks(proj, 'c1', 2, 0);
  const j = session(proj);
  const r = say(j, '/vk-resume 甲');
  H.ok('c2 没建：写需求', fl(j).stage === 'plan' && /写 c2 的需求/.test(r.systemMessage || ''), r);
  // 第 53 条：接回就算开工
  ticks(proj, 'c2', 0, 3);
  const k0 = session(proj);
  const r0 = say(k0, '/vk-resume c2');
  H.ok('c2 任务写好了、需求还没整套审过：接回写需求那一段，先审（第 85 条）', fl(k0).stage === 'plan' && /需求还没整套审过/.test(r0.systemMessage || ''), [fl(k0), r0.systemMessage]);
  H.reviewPoints(h, path.join(proj, 'openspec', 'changes', 'c2'), 'proposal');
  const k = session(proj);
  const r2 = say(k, '/vk-resume c2');
  H.ok('c2 任务写好了、一个没勾：接回就算开工（第 53 条）', fl(k).stage === 'apply' && fl(k).current === 'c2' && A.valid(k).ok && /接回就算开工/.test(r2.systemMessage || ''), [fl(k), r2.systemMessage]);
  const edit = H.hook(h, 'pre-edit', Object.assign({}, k, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' } }));
  H.ok('接回后改代码：不再要用户说开工', !/还没说开工|用户说开工/.test(H.reasonOf(edit)), H.reasonOf(edit));
  H.ok('接回就开工、没恢复自动：改代码前先问一次怎么实施（第 86 条）', /先用提问框问一次怎么实施/.test(H.reasonOf(edit)), H.reasonOf(edit));
  const q = 'c2 接着做，怎么实施？';
  const k2 = Object.assign({}, k, { transcript_path: H.transcript(path.join(h.root, k.session_id + '-ans.jsonl'), [H.tr.user('/vk-resume c2'), ...H.tr.ran('AskUserQuestion', { questions: [{ question: q, options: [{ label: '自动实施' }, { label: '实施（每步问我）' }] }] }, 'User has answered your questions: "' + q + '"="实施（每步问我）". You can now continue with the user\'s answers in mind.')]) });
  const edit2 = H.hook(h, 'pre-edit', Object.assign({}, k2, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' } }));
  H.ok('选了"实施（每步问我）"：放行，自动关着', !edit2 && S.sessionAuto(k2) === false, H.reasonOf(edit2));
}

H.section('自动：死机前开着才恢复');
{
  const proj = project({ 乙: ['c1'] });
  ticks(proj, 'c1', 1, 1);
  const old = session(proj);
  say(old, '/vk-resume 乙');
  S.setSessionAuto(old, true, '提问框选了自动'); // 2026-11-12 起只在提问框里开（/vk-auto 删了）
  say(old, '继续');
  // 换一个新会话，等于死机后回来（按会话的状态都没了，大任务的状态跨会话留着）
  const j = session(proj);
  const r = say(j, '/vk-resume 乙');
  H.ok('恢复自动，屏幕上说一句', S.sessionAuto(j) === true && /自动已恢复/.test(r.systemMessage || ''), r);
  say(j, '别自动了');
  say(j, '继续');
  const j2 = session(proj);
  const r2 = say(j2, '/vk-resume 乙');
  H.ok('关了之后再接回：不开', S.sessionAuto(j2) !== true && !/自动已恢复/.test(r2.systemMessage || ''), r2);
}

H.section('几个大任务');
{
  const proj = project({ 甲: ['a1'], 乙: ['b1'] });
  ticks(proj, 'a1', 1, 1); ticks(proj, 'b1', 0, 2);
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('不写名字：列出没归档的 change，让模型用提问框问，不替用户挑、不进流程（第 54 条）', /a1/.test(r.systemMessage || '') && /b1/.test(r.systemMessage || '') && /提问框/.test(H.reasonOf(r)) && /不要自己挑/.test(H.reasonOf(r)) && !fl(j).on && !fl(j).current, [r, fl(j)]);
  H.ok('写名字接回', (say(j, '/vk-resume 乙'), fl(j).task === '乙' && fl(j).on === true), fl(j));
  const k = session(proj);
  say(k, '/vk-resume a1');
  H.ok('写 change 名也认', fl(k).task === '甲', fl(k));
  const m = session(proj);
  const none = say(m, '/vk-resume 丙');
  H.ok('写错名字：说没找到', /没找到 丙/.test(none.systemMessage || '') && !fl(m).on, none);
}

H.section('不写名字：提问框答了才切（第 54 条）；自己输入的 change 不在表里，先补进 plan.md（第 55 条）');
{
  const proj = project({ 甲: ['a1', 'a2'] });
  ticks(proj, 'a1', 1, 1); ticks(proj, 'a2', 0, 2);
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('只有一个大任务也不替用户挑', !fl(j).on && /a1/.test(r.systemMessage || '') && /a2/.test(r.systemMessage || ''), [r.systemMessage, fl(j)]);
  const s = pickThen(j, 'a2');
  H.ok('选了 a2：收工时切过去，接着照提醒做', s.decision === 'block' && /切到这个 change/.test(s.reason || '') && fl(j).on === true && fl(j).current === 'a2', [s, fl(j)]);
  H.ok('屏幕上说切到了哪个', /切到 a2/.test(s.systemMessage || ''), s);
  const again = H.hook(h, 'verify-gate', Object.assign({}, j, { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: '好的' })) || {};
  H.ok('只切一次', !/切到这个 change/.test(again.reason || ''), again);
  // 自己输入的、不在表里的 change：先补进 plan.md
  ticks(proj, 'side-c', 0, 2); H.reviewPoints(h, path.join(proj, 'openspec', 'changes', 'side-c'), 'proposal');
  const k = session(proj);
  say(k, '/vk-resume');
  const s2 = pickThen(k, 'side-c');
  const plan = H.read(path.join(proj, 'openspec', 'plan.md'));
  H.ok('自己输入的 side-c：补进 plan.md，和别的行一样', /\|\s*\|\s*side-c\s*\|/.test(plan) && !/中途/.test(plan), plan);
  H.ok('补进去之后切过去，接回就算开工', fl(k).current === 'side-c' && fl(k).stage === 'apply' && /切到这个 change/.test(s2.reason || ''), [fl(k), s2]);
  const m = session(proj);
  say(m, '/vk-resume');
  const s3 = pickThen(m, 'no-such');
  H.ok('输入的名字没有：说没找到，不切', /没找到 no-such/.test(s3.systemMessage || '') && !fl(m).on, [s3, fl(m)]);
  const n = session(proj);
  say(n, '/vk-resume');
  H.transcript(n.transcript_path, [H.tr.user('/vk-resume')].concat(asked('切到哪个 change？', 'a1'), [H.tr.user('先不切了，帮我看看日志')]));
  const s4 = H.hook(h, 'verify-gate', Object.assign({}, n, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '好的' })) || {};
  H.ok('答完又说了别的：不切', !/切到这个 change/.test(s4.reason || '') && !fl(n).on, [s4, fl(n)]);
}

H.section('表外的 change：只有一个大任务，会话开始就补进表（第 55 条）');
{
  const proj = project({ 甲: ['a1'] });
  ticks(proj, 'a1', 1, 1); ticks(proj, 'later-x', 0, 1);
  const j = session(proj);
  H.hook(h, 'session-start', Object.assign({}, j, { hook_event_name: 'SessionStart', source: 'startup' }));
  const plan = H.read(path.join(proj, 'openspec', 'plan.md'));
  H.ok('later-x 补成了表里普通的一行，跟在 a1 后面', /\| a1 \|[^\n]*\n\|\s*\|\s*later-x\s*\|/.test(plan), plan);
  const two = project({ 甲: ['a1'], 乙: ['b1'] });
  ticks(two, 'a1', 1, 1); ticks(two, 'loose-y', 0, 1);
  H.hook(h, 'session-start', Object.assign({}, session(two), { hook_event_name: 'SessionStart', source: 'startup' }));
  H.ok('几个大任务：会话开始不补（还不知道这个会话做哪个）', !/loose-y/.test(H.read(path.join(two, 'openspec', 'plan.md'))));
  // 格子里带了说明的（模型以前照提醒写的）：认得出
  const odd = project({ 丙: ['c1'] });
  ticks(odd, 'c1', 1, 1); ticks(odd, 'extra-z', 0, 1);
  fs.appendFileSync(path.join(odd, 'openspec', 'plan.md'), '| | 补充 extra-z（中途加） | | |\n');
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  // 复审第 5 条：CRLF 的文件只插那几行；占位词当名字的目录不补；带说明的格子不和别处重复算
  const crlf = project({ 丁: ['d1'] });
  ticks(crlf, 'd1', 1, 1); ticks(crlf, 'more-d', 0, 1); ticks(crlf, 'todo', 0, 1);
  const pf = path.join(crlf, 'openspec', 'plan.md');
  fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace(/\n/g, '\r\n').replace('## 丁\r\n', '## 丁\n'));
  const before = fs.readFileSync(pf, 'utf8');
  H.hook(h, 'session-start', Object.assign({}, session(crlf), { hook_event_name: 'SessionStart', source: 'startup' }));
  const after = fs.readFileSync(pf, 'utf8');
  H.ok('CRLF 的 plan.md：只插了新的一行，别的行原样（混着的 LF 也没动）', after.length > before.length && after.replace(/\r?\n\|\s*\|\s*more-d\s*\|[^\r\n]*/, '') === before && /## 丁\n/.test(after), JSON.stringify(after));
  H.ok('目录名是占位词（todo）的 change：不补（补了也认不出，会越补越多）', !/\|\s*todo\s*\|/.test(after), after);
  H.hook(h, 'session-start', Object.assign({}, session(crlf), { hook_event_name: 'SessionStart', source: 'startup' }));
  H.ok('再开一个会话：不重复补', fs.readFileSync(pf, 'utf8') === after);
  H.ok('变更名那一格写成"补充 extra-z（中途加）"：认得出是 extra-z', B.tasks(odd).some((x) => x.changes.some((c) => c.name === 'extra-z')), B.tasks(odd).map((x) => x.changes.map((c) => c.name)));
}

H.section('模型调不了');
{
  const proj = project({ 甲: ['a1'] });
  const j = session(proj);
  const r = H.hook(h, 'guard-ask', Object.assign({}, j, { tool_name: 'Skill', tool_input: { skill: 'vk-resume' }, hook_event_name: 'PreToolUse' }));
  H.ok('模型调被拦', /给用户敲的/.test(H.reasonOf(r)), r);
  H.ok('命令文件写了只能用户敲', /disable-model-invocation: true/.test(H.read(path.join(FROM, 'claude', 'commands', 'vk-resume.md')) || ''));
}

H.section('没接回时提醒一次');
{
  const proj = project({ 甲: ['a1'] });
  ticks(proj, 'a1', 1, 1);
  const j = session(proj);
  const r = say(j, '帮我看看这个日志');
  H.ok('第一句告诉用户', /vk-resume/.test(r.systemMessage || ''), r);
  H.ok('不进流程', !fl(j).on);
  const r2 = say(j, '再看看别的');
  H.ok('只提醒一次', !/vk-resume/.test(r2.systemMessage || ''), r2);
}

H.done('/vk-resume');
