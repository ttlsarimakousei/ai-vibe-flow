'use strict';
/*
 * 历史上写得不完善的 plan.md、/vk-resume 切当前 change（问题表第 49、50 条，2026-11-04）：
 *   目录不在的行不占"当前 change"；老任务不按表的顺序拦打勾，新任务照拦；表外的 change 能开工；/vk-resume <变更名> 切得过去，做完了回到表的顺序；标题不把表头当名字。
 * 用法：node dev/test-old-plan.js [旧版的 vibe-kit 目录]（拿 20261104.0435 跑要不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2];
const h = H.makeHome('old-plan', FROM, { commitMode: 'off' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const B = require(path.join(h.kit, 'lib', 'big-task.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
let seq = 0;
const TABLE = (rows) => '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + rows.map((r) => '| | ' + r + ' | 进行中 | |\n').join('');
const change = (proj, name, done, todo) => {
  const d = path.join(proj, 'openspec', 'changes', name);
  H.write(path.join(d, 'proposal.md'), '## Why\n要做。\n');
  H.write(path.join(d, 'specs', 'a', 'spec.md'), '## ADDED Requirements\n### Requirement: A\n系统 SHALL 做。\n');
  H.write(path.join(d, 'design.md'), '## Context\n现状。\n## 验收用例\n- AC-01\n');
  H.write(path.join(d, 'tasks.md'), '## 1. 实现\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 改 a' + i + '\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 改 b' + i + '\n').join(''));
  return d;
};
const archived = (proj, name) => H.write(path.join(proj, 'openspec', 'changes', 'archive', '2026-10-01-' + name, 'proposal.md'), '## Why\n');
const project = (plan) => {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  if (plan !== null) H.write(path.join(proj, 'openspec', 'plan.md'), plan);
  fs.mkdirSync(path.join(proj, 'openspec', 'changes'), { recursive: true });
  return proj;
};
/** 新写法：有分节和探索记录 */
const newPlan = (proj, name, rows) => {
  H.write(path.join(proj, 'openspec', 'plan.md'), '# 计划\n\n## ' + name + '\n\n探索记录：explore/' + name + '.md\n\n' + TABLE(rows));
  H.write(path.join(proj, 'openspec', 'explore', name + '.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只做这些\n\n' + rows.map((c) => '## change: ' + c + '\n\n目标\n\n').join(''));
};
const session = (proj, say) => { const sid = 's' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user(say || '开工')]) }; };
const bar = (proj, sid) => { const r = spawnSync(process.execPath, [path.join(h.kit, 'statusline.js')], { input: JSON.stringify({ session_id: sid, workspace: { current_dir: proj }, context_window: { used_percentage: 30, context_window_size: 1000000, current_usage: { input_tokens: 300000 } } }), env: H.envFor(h), encoding: 'utf8', windowsHide: true }); return plain(r.stdout).trim().split(/\r?\n/).slice(1).join(' / '); };
const clearBar = () => fs.rmSync(path.join(h.kit, 'state', 'changes-cache.json'), { force: true });
const tick = (j, name, n) => H.reasonOf(H.hook(h, 'pre-edit', Object.assign({}, j, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(j.cwd, 'openspec', 'changes', name, 'tasks.md'), old_string: '- [ ] 1.' + n, new_string: '- [x] 1.' + n } })));
const resume = (j, arg) => { const prompt = '/vk-resume' + (arg ? ' ' + arg : ''); H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { hook_event_name: 'UserPromptSubmit', prompt })) || {}; };
const said = (o) => String(o.systemMessage || '') + JSON.stringify(o.hookSpecificOutput || '');
const phase = (proj) => B.phaseOf(B.tasks(proj)[0]);

H.section('目录不在的行（改名、删了，没归档）');
{
  const p = project('# 计划\n\n' + TABLE(['gone-c', 'real-c']));
  change(p, 'real-c', 1, 2);
  H.ok('老任务：不占当前 change', phase(p).change === 'real-c' && phase(p).phase === 'apply', phase(p));
  H.ok('进度里说目录不在，跳过', /gone-c 目录不在，跳过/.test(B.progressText(B.tasks(p)[0])), B.progressText(B.tasks(p)[0]));
  const j = session(p, '开工 real-c');
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, path.join(p, 'openspec', 'changes', 'real-c'));
  H.ok('状态栏指着 real-c', /real-c\(2\/2\)/.test(bar(p, j.session_id)) && !/gone-c/.test(bar(p, j.session_id)), bar(p, j.session_id));
  const r = resume(session(p, '/vk-resume'));
  H.ok('/vk-resume 不让去写它的需求', /real-c/.test(said(r)) && !/写 gone-c/.test(said(r)), said(r));

  const q = project('# 计划\n\n' + TABLE(['real-c', 'future-c']));
  change(q, 'real-c', 2, 0);
  H.ok('表最后面还没建的行：是计划要做的，算下一个', phase(q).phase === 'plan' && phase(q).change === 'future-c', phase(q));

  const w = project('# 计划\n\n' + TABLE(['gone-c', 'arch-c']));
  archived(w, 'arch-c');
  H.ok('后面的都归档了：做完了', phase(w).phase === 'done', phase(w));

  const v = project('# 计划\n\n' + TABLE(['gone-c', 'real-c']));
  change(v, 'real-c', 2, 0);
  H.ok('老任务 real-c 做完：是全面自测，不是归档', phase(v).phase === 'selftest', phase(v));

  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2']);
  change(n, 'c2', 1, 1);
  H.ok('新任务：c1 没建、c2 在做：当前是 c2', phase(n).change === 'c2', phase(n));
  change(n, 'c2', 2, 0);
  H.ok('新任务：c2 做完回来算 c1（探索记录定了要做）', phase(n).phase === 'plan' && phase(n).change === 'c1', phase(n));
}

H.section('打勾的顺序：老任务不拦，新任务照拦');
{
  const p = project('# 计划\n\n' + TABLE(['stale-half', 'real-c']));
  change(p, 'stale-half', 1, 1); change(p, 'real-c', 0, 2);
  const j = session(p, '开工 real-c');
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, path.join(p, 'openspec', 'changes', 'real-c'));
  A.grant(j, '开工 real-c', '', {});
  H.ok('老任务：前一行做了一半放弃了，后面的能打勾', !/按 openspec\/plan\.md 表的顺序做/.test(tick(j, 'real-c', 1)), tick(j, 'real-c', 1));

  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2']);
  change(n, 'c1', 1, 1); change(n, 'c2', 0, 2);
  const k = session(n, '开工 c2');
  S.setFlow(k, true, '测试', 'apply');
  S.flowTouch(k, path.join(n, 'openspec', 'changes', 'c2'));
  A.grant(k, '开工 c2', '', {});
  H.ok('新任务：照拦（带拦截编号）', /按 openspec\/plan\.md 表的顺序做/.test(tick(k, 'c2', 1)) && /拦截编号/.test(tick(k, 'c2', 1)), tick(k, 'c2', 1));
}

H.section('表外的 change 能开工');
{
  const p = project('# 计划\n\n' + TABLE(['real-c']));
  change(p, 'real-c', 0, 2); change(p, 'unlisted-c', 0, 2);
  const j = session(p, '开工 unlisted-c');
  S.setFlow(j, true, '测试', 'apply');
  const g = A.grant(j, '开工 unlisted-c', '', {});
  H.ok('开工落在它上面，不落到表里的 change', g.ok && g.targets.join() === 'unlisted-c', g);
  H.ok('能打勾', !tick(j, 'unlisted-c', 1), tick(j, 'unlisted-c', 1));
  H.ok('这个会话不归表里的大任务', B.forSession(j) === null, B.forSession(j));
  S.flowTouch(j, path.join(p, 'openspec', 'changes', 'unlisted-c'));
  H.ok('状态栏指着它', /unlisted-c/.test(bar(p, j.session_id)) && !/real-c/.test(bar(p, j.session_id)), bar(p, j.session_id));

  const k = session(p, '开工');
  S.setFlow(k, true, '测试', 'apply');
  const g2 = A.grant(k, '开工 real-c', '', {});
  H.ok('点名表里的：照旧', g2.ok && g2.targets.join() === 'real-c', g2);
}

H.section('/vk-resume <变更名> 切当前 change');
{
  const p = project('# 计划\n\n' + TABLE(['first-c', 'second-c', 'third-c']));
  change(p, 'first-c', 1, 1); change(p, 'second-c', 1, 1); change(p, 'third-c', 2, 0);
  const j = session(p, '/vk-resume');
  const r = resume(j, 'second-c');
  H.ok('说切到了', /切到 second-c/.test(said(r)), said(r));
  H.ok('记下了，在做任务那一段，能打勾', S.flowState(j).current === 'second-c' && S.flowState(j).stage === 'apply' && !tick(j, 'second-c', 2), [S.flowState(j).current, tick(j, 'second-c', 2)]);
  clearBar();
  H.ok('状态栏跟着它', /second-c/.test(bar(p, j.session_id)) && !/first-c/.test(bar(p, j.session_id)), bar(p, j.session_id));
  H.ok('下一步说接着做它', /接着做 second-c/.test(said(r)), said(r));
  change(p, 'second-c', 2, 0);
  clearBar();
  H.ok('做完了：回到表的顺序', /first-c/.test(bar(p, j.session_id)), bar(p, j.session_id));
  change(p, 'second-c', 1, 1);
  resume(j, 'second-c');
  resume(j);
  clearBar();
  H.ok('/vk-resume 不写名字：回到表的顺序', !S.flowState(j).current && /first-c/.test(bar(p, j.session_id)), [S.flowState(j).current, bar(p, j.session_id)]);
  const f = resume(session(p, '/vk-resume'), 'third-c');
  H.ok('任务都勾完的：没切，说清楚', /third-c 的任务都勾完了，没切/.test(said(f)), said(f));
}
{
  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2']);
  change(n, 'c1', 1, 1); change(n, 'c2', 0, 2);
  const j = session(n, '/vk-resume');
  const r = resume(j, 'c2');
  H.ok('新任务也能切', /切到 c2/.test(said(r)) && S.flowState(j).current === 'c2', said(r));
  H.ok('还没开工的：下一步不说去写需求', /任务写好了，还没开工/.test(said(r)) && !/写 c2 的需求/.test(said(r)), said(r));
  A.grant(j, '开工 c2', '', {});
  H.ok('用户切过去的：打勾不按表的顺序拦', !/按 openspec\/plan\.md 表的顺序做/.test(tick(j, 'c2', 1)), tick(j, 'c2', 1));
  A.grant(j, '开工 c1', '', {});
  H.ok('开工点名别的：之前切的不算了', !S.flowState(j).current, S.flowState(j).current);
}
{
  const p = project(null);
  change(p, 'c1', 1, 1); change(p, 'c2', 1, 1);
  const j = session(p, '/vk-resume');
  const r = resume(j, 'c2');
  H.ok('没有 plan.md：也能切', /切到 c2/.test(said(r)) && S.flowState(j).current === 'c2' && S.flowState(j).on === true, said(r));
  S.flowTouch(j, path.join(p, 'openspec', 'changes', 'c1'));
  clearBar();
  H.ok('状态栏跟着切的那个，不是先碰过的', /c2/.test(bar(p, j.session_id)), bar(p, j.session_id));
  const q = project('# 计划\n\n' + TABLE(['real-c']));
  change(q, 'real-c', 1, 1); change(q, 'unlisted-c', 1, 1);
  const k = session(q, '/vk-resume');
  const r2 = resume(k, 'unlisted-c');
  H.ok('表外的：切得过去，不归大任务', /不在 plan\.md 的表里/.test(said(r2)) && B.forSession(k) === null && !tick(k, 'unlisted-c', 2), [said(r2), tick(k, 'unlisted-c', 2)]);
  const none = resume(session(q, '/vk-resume'), 'no-such');
  H.ok('没有这个名字：说没找到，列出来', /没找到 no-such/.test(said(none)) && /大任务名或变更名/.test(said(none)), said(none));
  S.setFlow(k, false, '测试');
  H.ok('退出流程：切的不算了', !S.flowState(k).current);
}

H.section('大任务名');
for (const [what, plan, want] of [['# 计划 紧跟表', '# 计划\n\n' + TABLE(['real-c']), '计划'], ['# 标题 紧跟表', '# 订单系统\n\n' + TABLE(['real-c']), '订单系统'], ['没有标题', TABLE(['real-c']), '计划'], ['分节', '# 计划\n\n## 老需求\n\n' + TABLE(['real-c']), '老需求']]) {
  const p = project(plan);
  H.ok(what + ' → ' + want, B.tasks(p)[0].name === want, B.tasks(p)[0].name);
}

H.section('钩子不改写 plan.md');
{
  const plan = '# 计划\n\n' + TABLE(['gone-c', 'real-c']);
  const p = project(plan);
  change(p, 'real-c', 0, 1);
  const j = session(p, '开工 real-c');
  for (const [hook, input] of [['session-start', { hook_event_name: 'SessionStart', source: 'startup' }], ['task-anchor', { hook_event_name: 'UserPromptSubmit', prompt: '/vk-resume real-c' }], ['verify-gate', { hook_event_name: 'Stop' }]]) H.hook(h, hook, Object.assign({}, j, input));
  H.ok('没变', H.read(path.join(p, 'openspec', 'plan.md')) === plan);
}

H.done('历史 plan.md 和切 change' + (FROM ? '，拿 ' + FROM + ' 跑' : ''));
