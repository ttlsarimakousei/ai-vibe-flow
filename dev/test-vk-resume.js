'use strict';
/*
 * /vk-resume 接回大任务（2026-11-03）：阶段从文件算，显示进度，死机前开着自动才恢复，提交、推送、归档许可不恢复。
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

H.section('没有大任务');
{
  const proj = H.makeRepo(path.join(h.work, 'empty'), { 'README.md': '# x\n' });
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('说没有，不进流程', /没有没做完的大任务/.test(r.systemMessage || '') && !fl(j).on, r);
}

H.section('死机后接回');
{
  const proj = project({ 订单导出: ['c1', 'c2', 'c3'] });
  ticks(proj, 'c1', 3, 0); ticks(proj, 'c2', 2, 3);
  const j = session(proj);
  const r = say(j, '/vk-resume');
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
  const r = say(j, '/vk-resume');
  H.ok('c2 没建：写需求', fl(j).stage === 'plan' && /写 c2 的需求/.test(r.systemMessage || ''), r);
}

H.section('自动：死机前开着才恢复');
{
  const proj = project({ 乙: ['c1'] });
  ticks(proj, 'c1', 1, 1);
  const old = session(proj);
  say(old, '/vk-resume');
  say(old, '/vk-auto');
  say(old, '继续');
  // 换一个新会话，等于死机后回来（按会话的状态都没了，大任务的状态跨会话留着）
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('恢复自动，屏幕上说一句', S.sessionAuto(j) === true && /自动已恢复/.test(r.systemMessage || ''), r);
  say(j, '/vk-auto off');
  say(j, '继续');
  const j2 = session(proj);
  const r2 = say(j2, '/vk-resume');
  H.ok('关了之后再接回：不开', S.sessionAuto(j2) !== true && !/自动已恢复/.test(r2.systemMessage || ''), r2);
}

H.section('几个大任务');
{
  const proj = project({ 甲: ['a1'], 乙: ['b1'] });
  ticks(proj, 'a1', 1, 1); ticks(proj, 'b1', 0, 2);
  const j = session(proj);
  const r = say(j, '/vk-resume');
  H.ok('列出来让用户选，不进流程', /甲/.test(r.systemMessage || '') && /乙/.test(r.systemMessage || '') && /vk-resume <大任务名或变更名>/.test(r.systemMessage || '') && !fl(j).on, r);
  H.ok('写名字接回', (say(j, '/vk-resume 乙'), fl(j).task === '乙' && fl(j).on === true), fl(j));
  const k = session(proj);
  say(k, '/vk-resume a1');
  H.ok('写 change 名也认', fl(k).task === '甲', fl(k));
  const m = session(proj);
  const none = say(m, '/vk-resume 丙');
  H.ok('写错名字：说没找到', /没找到 丙/.test(none.systemMessage || '') && !fl(m).on, none);
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
