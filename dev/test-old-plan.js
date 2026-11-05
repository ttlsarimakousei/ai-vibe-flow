'use strict';
/*
 * 历史上写得不完善的 plan.md、/vk-resume 切当前 change（问题表第 49、50 条，2026-11-04）：
 *   变更名那一列的占位文字（未开始、待定、—）不算 change（第 51 条）；切 change 的指针只在还没做完时算数，不能挡后面的大任务（复审 20261104）；目录不在的行不占"当前 change"；老任务不按表的顺序拦打勾，新任务照拦；表外的 change 能开工；/vk-resume <变更名> 切得过去，做完了回到表的顺序；标题不把表头当名字。
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
const resume = (j, arg, keep) => { const prompt = '/vk-resume' + (arg ? ' ' + arg : ''); if (!keep) H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { hook_event_name: 'UserPromptSubmit', prompt })) || {}; };
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
  H.ok('状态栏指着 real-c', /real-c /.test(bar(p, j.session_id)) && !/gone-c/.test(bar(p, j.session_id)), bar(p, j.session_id));
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
  resume(j, '计划');
  clearBar();
  H.ok('/vk-resume <大任务名>：回到表的顺序（不写名字改成提问框问了，第 54 条）', !S.flowState(j).current && /first-c/.test(bar(p, j.session_id)), [S.flowState(j).current, bar(p, j.session_id)]);
  const f = resume(session(p, '/vk-resume'), 'third-c');
  // 2026-11-05 起只要没归档都能切（第 60 条）
  H.ok('任务都勾完的：切得过去，等用户说下一步', /切到 third-c/.test(said(f)) && /等用户说要做什么/.test(said(f)), said(f));
}
{
  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2']);
  change(n, 'c1', 1, 1); change(n, 'c2', 0, 2);
  const j = session(n, '/vk-resume');
  const r = resume(j, 'c2');
  H.ok('新任务也能切', /切到 c2/.test(said(r)) && S.flowState(j).current === 'c2', said(r));
  H.ok('还没开工的：接回就算开工，不说去写需求（第 53 条）', /接回就算开工/.test(said(r)) && !/写 c2 的需求/.test(said(r)) && S.flowState(j).stage === 'apply', said(r));
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
  H.ok('表外的：先补进 plan.md（第 55 条），切得过去，能打勾', /\|\s*\|\s*unlisted-c\s*\|/.test(H.read(path.join(q, 'openspec', 'plan.md'))) && /切到 unlisted-c/.test(said(r2)) && S.flowState(k).current === 'unlisted-c' && !tick(k, 'unlisted-c', 2), [said(r2), tick(k, 'unlisted-c', 2)]);
  const none = resume(session(q, '/vk-resume'), 'no-such');
  H.ok('没有这个名字：说没找到，列出来', /没找到 no-such/.test(said(none)) && /大任务名或变更名/.test(said(none)), said(none));
  S.setFlow(k, false, '测试');
  H.ok('退出流程：切的不算了', !S.flowState(k).current);
}

H.section('切 change 的指针：不能挡后面的大任务（复审 R1、R2、R4）');
{
  const t1 = project(null);
  const d = change(t1, 'small-x', 1, 1);
  const j = session(t1, '开工');
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d);
  A.grant(j, '开工', '', {});
  H.ok('（没有 plan.md 开工：记下了这个 change）', S.flowState(j).current === 'small-x', S.flowState(j).current);
  fs.mkdirSync(path.join(t1, 'openspec', 'changes', 'archive'), { recursive: true });
  fs.renameSync(d, path.join(t1, 'openspec', 'changes', 'archive', '2026-11-01-small-x'));
  newPlan(t1, '导出', ['c1', 'c2']);
  const d1 = change(t1, 'c1', 0, 1);
  S.flowTouch(j, d1);
  H.ok('表外的归档了、后来开了大任务：归到大任务，不是 null', (B.forSession(j) || {}).name === '导出', B.forSession(j));
  clearBar();
  H.ok('状态栏走大任务（有探索）', /探索✓/.test(bar(t1, j.session_id)) && /│ c1 /.test(bar(t1, j.session_id)), bar(t1, j.session_id));

  const t2 = project(null);
  const old = change(t2, 'old-y', 1, 0);
  newPlan(t2, '导出', ['c1']);
  const k = session(t2, '继续');
  S.setFlow(k, true, '测试', 'plan');
  S.flowTouch(k, old);
  H.ok('碰过表外的老 change、探索完第一个还没碰：还是这个大任务', (B.forSession(k) || {}).name === '导出', B.forSession(k));

  const t3 = project(null);
  newPlan(t3, '导出', ['c1', 'c2']);
  const a1 = change(t3, 'c1', 1, 1); const a2 = change(t3, 'c2', 1, 1);
  const m = session(t3, '/vk-resume');
  resume(m, 'c2');
  H.ok('（切到 c2）', S.flowState(m).current === 'c2');
  change(t3, 'c2', 2, 0);
  H.hook(h, 'verify-gate', Object.assign({}, m, { hook_event_name: 'Stop' }));
  H.ok('c2 做完、收工：指针清了', !S.flowState(m).current, S.flowState(m).current);
  change(t3, 'c2', 2, 1);
  H.ok('c2 回改加了任务：不再抢回来，当前是表的顺序', B.phaseFor(m, B.tasks(t3)[0]).change === 'c1', B.phaseFor(m, B.tasks(t3)[0]));
  void a1; void a2;

  const t4 = project(null);
  newPlan(t4, '导出', ['c1']);
  change(t4, 'c1', 1, 1); change(t4, 'solo-c', 1, 1);
  const q = session(t4, '/vk-resume');
  resume(q, 'c1');
  H.ok('（接回大任务）', S.flowState(q).task === '导出');
  H.ok('接回时表外的 solo-c 补进了表（第 55 条）', /\|\s*\|\s*solo-c\s*\|/.test(H.read(path.join(t4, 'openspec', 'plan.md'))));
  A.grant(q, '开工 solo-c', '', {});
  H.ok('开工 solo-c：它已经在表里，归大任务 导出', (B.forSession(q) || {}).name === '导出', [S.flowState(q).task, S.flowState(q).current]);
  A.grant(q, '开工 c1', '', {});
  H.ok('回头开工表里的：指针清了，归大任务', !S.flowState(q).current && (B.forSession(q) || {}).name === '导出', S.flowState(q).current);
}

H.section('/vk-resume：不写名字只出提问框，指针不动（第 54 条）；名字不分大小写、多写了话也认');
{
  const p = project('# 计划\n\n## 甲\n\n' + TABLE(['a1', 'a2']) + '\n## 乙\n\n' + TABLE(['b1']));
  change(p, 'a1', 1, 1); change(p, 'a2', 1, 1); change(p, 'b1', 1, 1);
  const j = session(p, '/vk-resume');
  resume(j, 'a2');
  H.ok('（切到 a2）', S.flowState(j).current === 'a2');
  const r0 = resume(j);
  H.ok('几个大任务、不写名字：列出 change 让用户在提问框里选，指针不动', S.flowState(j).current === 'a2' && /提问框/.test(said(r0)) && /a1/.test(said(r0)) && /b1/.test(said(r0)), [S.flowState(j).current, said(r0)]);
  const k = session(p, '/vk-resume');
  H.ok('不分大小写', /切到 a2/.test(said(resume(k, 'A2'))) && S.flowState(k).current === 'a2', S.flowState(k).current);
  const m = session(p, '/vk-resume');
  H.ok('后面多写了话：认第一个词', /切到 a2/.test(said(resume(m, 'a2 继续做'))) && S.flowState(m).current === 'a2', S.flowState(m).current);
}

H.section('新任务：跳过的行不说成"后面还有"；接下一个不把没做过的行说成"做完了"（复审 R7）');
{
  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2', 'c3']);
  change(n, 'c2', 1, 1);
  const txt = B.progressText(B.tasks(n)[0]);
  H.ok('说还没建', /c1 还没建/.test(txt) && !/后面还有 c1/.test(txt), txt);
}

H.section('自动模式：催的时候先看切到的那个（复审 R3）');
{
  const n = project(null);
  newPlan(n, '导出', ['c1', 'c2']);
  const d1 = change(n, 'c1', 1, 1); const d2 = change(n, 'c2', 1, 1);
  H.write(path.join(d1, 'tasks.md'), '## 1. 实现\n\n- [x] 1.1 c1-做了\n- [ ] 1.2 c1-没做\n');
  H.write(path.join(d2, 'tasks.md'), '## 1. 实现\n\n- [x] 1.1 c2-做了\n- [ ] 1.2 c2-没做\n');
  // c1 是这个会话刚做过的：按修改时间排它在前面
  const older = new Date(Date.now() - 60000); fs.utimesSync(path.join(d2, 'tasks.md'), older, older); fs.utimesSync(d2, older, older);
  const j = session(n, '开工 c1');
  H.transcript(j.transcript_path, [H.tr.user('开工 c1'), H.tr.say('做了 1.1'), H.tr.user('/vk-resume c2'), H.tr.say('好的')]);
  S.setSessionAuto(j, true, '测试');
  resume(j, 'c2', true);
  S.flowTouch(j, d1); S.flowTouch(j, d2);
  for (const d of [d1, d2]) { H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code'); }
  const r = H.reasonOf(H.hook(h, 'verify-gate', Object.assign({}, j, { hook_event_name: 'Stop' })));
  H.ok('催的是切到的 c2，不把模型拉回刚做过的 c1', /c2-没做/.test(r) && !/c1-没做/.test(r), r.slice(0, 300));
}

H.section('变更名那一列的占位文字不算 change（第 51 条）');
{
  const rows = (fn) => Array.from({ length: 12 }, (_, i) => fn(i)).join('');
  const p = project('# 计划\n\n| 序号 | 需求 | 变更名 | 状态 |\n|---|---|---|---|\n' + rows((i) => '| ' + (i + 1) + ' | 需求' + i + ' | ' + (i < 2 ? 'done-' + i : '未开始') + ' | ' + (i < 2 ? '已归档' : '未开始') + ' |\n'));
  archived(p, 'done-0'); archived(p, 'done-1');
  const j = session(p, '接着做');
  S.setFlow(j, true, '测试', 'plan');
  H.ok('只算真的 change', B.tasks(p)[0].changes.map((c) => c.name).join() === 'done-0,done-1', B.tasks(p)[0].changes.map((c) => c.name));
  H.ok('都归档了：做完了', phase(p).phase === 'done', phase(p));
  clearBar();
  H.ok('状态栏不显示"未开始(3/12)"', !/未开始/.test(bar(p, j.session_id)), bar(p, j.session_id));
  for (const w of ['待定', '—', '-', '...', 'TBD', 'todo', '订单导出']) {
    const q = project('# 计划\n\n' + TABLE([w, 'real-c']));
    change(q, 'real-c', 1, 1);
    H.ok('占位 ' + w + ' 不算', B.tasks(q)[0].changes.map((c) => c.name).join() === 'real-c', B.tasks(q)[0].changes.map((c) => c.name));
  }
  const z = project('# 计划\n\n' + TABLE(['中文变更', 'real-c', 'add-export.v2']));
  change(z, '中文变更', 1, 1); change(z, 'real-c', 0, 1);
  H.ok('中文名目录真在：算', phase(z).change === '中文变更' && B.tasks(z)[0].changes.length === 3, B.tasks(z)[0].changes.map((c) => c.name));
  const y = project('# 计划\n\n' + TABLE(['已归档的中文', 'real-c']));
  archived(y, '已归档的中文'); change(y, 'real-c', 0, 1);
  H.ok('中文名归档了：也算', B.tasks(y)[0].changes[0].archived === true, B.tasks(y)[0].changes);
  const c1 = project('# 计划\n\n| 序号 | 需求 | 变更状态 |\n|---|---|---|\n| 1 | 甲 | 已归档 |\n| 2 | 乙 | 未开始 |\n');
  H.ok('表头只有"变更状态"：这张表没有变更名那一列', B.tasks(c1).length === 0, B.tasks(c1));
  const c2 = project('# 计划\n\n| 变更状态 | 变更名 |\n|---|---|\n| 进行中 | real-c |\n');
  change(c2, 'real-c', 0, 1);
  H.ok('"变更状态"在前面：不当成变更名那一列', B.tasks(c2)[0].changes.map((c) => c.name).join() === 'real-c', B.tasks(c2)[0].changes.map((c) => c.name));
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
