'use strict';
/*
 * 一个大任务多个 change（2026-11-03）：开工范围按大任务算、回改前面的 change、按表顺序接下一个、每组只审查、
 * 最后全面自测和人工核验、归档前预演、探索完之后范围不能自己改（第 43 条）。全局页图 6、图 7。
 * 用法：node dev/test-multi-change.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('multi-change', FROM, { commitMode: 'off' }, { openspec: true });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
const hasB = fs.existsSync(path.join(h.kit, 'lib', 'big-task.js'));
const B = hasB ? require(path.join(h.kit, 'lib', 'big-task.js')) : null;

let seq = 0;
const TASK = '导出';
function project(changes) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const os_ = path.join(proj, 'openspec');
  H.write(path.join(os_, 'plan.md'), '# 计划\n\n## ' + TASK + '\n\n探索记录：explore/' + TASK + '.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join(''));
  H.write(path.join(os_, 'explore', TASK + '.md'), '# 探索\n\n## 定了的\n\n导出 xlsx\n\n## 还没定的\n\n## 范围\n\n只做导出\n\n## 跨 change 约定\n\n无\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join('') + '## 落地偏差\n\n');
  fs.mkdirSync(path.join(os_, 'changes'), { recursive: true });
  return proj;
}
function docs(proj, c, done, todo, kind) {
  const d = path.join(proj, 'openspec', 'changes', c);
  H.write(path.join(d, 'proposal.md'), '# 导出\n\n## Why\n\n要导出。\n');
  H.write(path.join(d, 'design.md'), '# 设计\n\n- 放在 src/A.java\n\n## 验收用例\n\n- AC-01 导出：人工\n');
  H.write(path.join(d, 'tasks.md'), '## 1. x\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 做完：src/A.java\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 没做：src/A.java\n').join(''));
  H.write(path.join(d, 'specs', 'order', 'spec.md'), '## ' + (kind || 'ADDED') + ' Requirements\n\n### Requirement: 导出订单\n\nThe system SHALL export orders.\n\n#### Scenario: 导出\n\n- **WHEN** 点导出\n- **THEN** 得到文件\n');
  return d;
}
function session(proj, words) { const sid = 's' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), (words || [H.tr.user('接着做')]).flat()) }; }
const fl = (j) => S.flowState(j);
const edit = (j, file, a, b) => H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Edit', tool_input: { file_path: file, old_string: a, new_string: b }, hook_event_name: 'PreToolUse' }));
const stop = (j) => H.hook(h, 'verify-gate', Object.assign({}, j, { hook_event_name: 'Stop', stop_hook_active: false }));
const tool = (proj, ...a) => { const r = spawnSync(process.execPath, [path.join(h.kit, 'tools', 'workflow.js')].concat(a, ['--project', proj]), { cwd: proj, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 120000 }); return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }; };
const say = (j, prompt) => { H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { prompt, hook_event_name: 'UserPromptSubmit' })); };

H.section('做 c3 时回头改 c1（全局页图 6）');
{
  const start = (auto) => {
    const proj = project(['c1', 'c2', 'c3']);
    const d1 = docs(proj, 'c1', 3, 0); docs(proj, 'c2', 3, 0); const d3 = docs(proj, 'c3', 1, 2);
    const j = session(proj);
    S.setFlow(j, true, '测试', 'apply');
    if (auto) S.setSessionAuto(j, true, '测试');
    A.grant(j, '开工 c3', '', {});
    return { proj, d1, d3, j };
  };
  let c = start(true);
  H.ok('开工范围是整个大任务', Object.keys(fl(c.j).applyScope.dirs).length === 3 && fl(c.j).applyScope.task === TASK, fl(c.j).applyScope);
  let r = H.reasonOf(edit(c.j, path.join(c.d1, 'proposal.md'), '要导出。', '要导出，带日期。'));
  H.ok('自动：改 c1 的文档放行', !r, r);
  H.write(path.join(c.d1, 'proposal.md'), H.read(path.join(c.d1, 'proposal.md')).replace('要导出。', '要导出，带日期。'));
  H.ok('自动：开工范围没丢，自动还生效', !!fl(c.j).applyScope && fl(c.j).stage === 'apply' && S.flowView(c.j).effective === true, [fl(c.j).stage, S.flowView(c.j)]);
  r = H.reasonOf(edit(c.j, path.join(c.proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  H.ok('自动：接着改代码放行', !r, r);
  H.write(path.join(c.d1, 'tasks.md'), H.read(path.join(c.d1, 'tasks.md')) + '- [ ] 1.4 加日期：src/A.java\n');
  r = H.reasonOf(edit(c.j, path.join(c.d3, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做'));
  H.ok('c1 补了任务：先做 c1，勾 c3 被拦', /按 openspec\/plan\.md 表的顺序/.test(r) && /c1/.test(r), r);
  r = H.reasonOf(edit(c.j, path.join(c.d1, 'tasks.md'), '- [ ] 1.4 加日期', '- [x] 1.4 加日期'));
  H.ok('勾 c1 补的任务放行', !/还不能|表的顺序/.test(r), r);
  if (hasB) H.ok('进度算回 c1 之后的 c3', B.phaseOf(B.forSession(c.j)).change === 'c1' || B.phaseOf(B.forSession(c.j)).change === 'c3', B.phaseOf(B.forSession(c.j)));

  c = start(false);
  H.write(path.join(c.d1, 'proposal.md'), H.read(path.join(c.d1, 'proposal.md')).replace('要导出。', '要导出，带日期。'));
  r = H.reasonOf(edit(c.j, path.join(c.d1, 'design.md'), '- 放在 src/A.java', '- 放在 src/A.java，带日期'));
  H.ok('人工：改 c1 的文档放行', !r, r);
  r = H.reasonOf(edit(c.j, path.join(c.proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  H.ok('人工：改代码要重新说开工', /开工/.test(r), r);
  H.transcript(c.j.transcript_path, [H.tr.user('开工')]);
  H.ok('说开工之后范围还是整个大任务', A.grant(c.j, '开工', '', {}).ok && Object.keys(fl(c.j).applyScope.dirs).length === 3, fl(c.j).applyScope);
}

H.section('开工之后才建的 change 自动并入');
{
  const proj = project(['c1', 'c2']);
  docs(proj, 'c1', 1, 1);
  const j = session(proj);
  S.setFlow(j, true, '测试', 'apply');
  S.setSessionAuto(j, true, '测试');
  A.grant(j, '开工 c1', '', {});
  const d2 = docs(proj, 'c2', 0, 1);
  H.ok('c2 不算范围外', !A.check(j, path.join(d2, 'design.md')), A.check(j, path.join(d2, 'design.md')));
}

H.section('每组只审查，不自测');
{
  const proj = project(['c1']);
  const d = docs(proj, 'c1', 1, 0);
  H.ok('审查点的指令不再说自测', !/自测/.test(P.instruction(d, 'group-1', S.readConfig())), P.instruction(d, 'group-1', S.readConfig()));
  const rules = H.read(path.join(FROM, 'claude', 'rules', '10-openspec.md'));
  H.ok('规范：一个 change 做完只审修，最后全面自测', /一个 change 做完只审修/.test(rules) && /全面自测/.test(rules));
  H.ok('规范：不再写不自行启动下一个', !/不自行启动下一个变更/.test(rules));
  H.ok('规范：不自己加这条人工也有', /不加探索记录里没有的东西/.test(rules));
}

H.section('按表顺序接下一个');
{
  const run = (auto) => {
    const proj = project(['c1', 'c2']);
    const d1 = docs(proj, 'c1', 2, 0);
    H.reviewPoints(h, d1, 'proposal'); H.reviewPoints(h, d1, 'code');
    const j = session(proj);
    S.setFlow(j, true, '测试', 'apply');
    S.flowTouch(j, d1);
    if (auto) S.setSessionAuto(j, true, '测试');
    A.grant(j, '开工 c1', '', {});
    // c1 是这次开工之后才做完的
    const later = new Date(Date.now() + 2000); fs.utimesSync(path.join(d1, 'tasks.md'), later, later);
    return { j, r: H.reasonOf(stop(j)) };
  };
  let c = run(true);
  H.ok('自动：直接接 c2，先记落地偏差', /接着做 c2/.test(c.r) && /落地偏差/.test(c.r) && !/用提问框问用户要不要接着做/.test(c.r), c.r);
  H.ok('回到写需求那一段', fl(c.j).stage === 'plan', fl(c.j));
  c = run(false);
  H.ok('人工：用提问框问', /用提问框问用户要不要接着做 c2/.test(c.r), c.r);
}

H.section('开工了、第一项还没勾：不算接下一个（复审 R1）');
{
  for (const auto of [false, true]) {
    const proj = project(['c1']);
    const d1 = docs(proj, 'c1', 0, 3);
    H.reviewPoints(h, d1, 'proposal');
    const j = session(proj);
    S.setFlow(j, true, '测试', 'apply');
    S.flowTouch(j, d1);
    if (auto) S.setSessionAuto(j, true, '测试');
    A.grant(j, '开工 c1', '', {});
    const r = H.reasonOf(stop(j));
    H.ok((auto ? '自动' : '人工') + '：还在做任务那一段', fl(j).stage === 'apply', fl(j));
    H.ok((auto ? '自动' : '人工') + '：不问要不要接着做，不说建变更', !/要不要接着做|接着做 c1/.test(r), r);
  }
  // 前一个早就做完了，这次开工点名后一个
  const proj = project(['c1', 'c2']);
  const d1 = docs(proj, 'c1', 2, 0);
  const d2 = docs(proj, 'c2', 0, 2);
  H.reviewPoints(h, d1, 'proposal'); H.reviewPoints(h, d1, 'code'); H.reviewPoints(h, d2, 'proposal');
  const old = new Date(Date.now() - 60000); fs.utimesSync(path.join(d1, 'tasks.md'), old, old);
  const j = session(proj);
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d2);
  A.grant(j, '开工 c2', '', {});
  const r = H.reasonOf(stop(j));
  H.ok('前一个早做完了、这次开工的是 c2：不退回写需求', fl(j).stage === 'apply' && !/要不要接着做/.test(r), [fl(j).stage, r]);
}

H.section('全面自测和人工核验放到最后');
{
  const proj = project(['c1', 'c2']);
  const d1 = docs(proj, 'c1', 2, 0); const d2 = docs(proj, 'c2', 2, 0);
  for (const d of [d1, d2]) { H.reviewPoints(h, d, 'proposal'); H.reviewPoints(h, d, 'code'); }
  const j = session(proj);
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d1); S.flowTouch(j, d2);
  S.setSessionAuto(j, true, '测试');
  A.grant(j, '开工 c1', '', {});
  const r = H.reasonOf(stop(j));
  H.ok('全部做完：催全面自测', /全面自测/.test(r) && /selftest --task/.test(r), r);
  const f = path.join(h.root, 'results' + seq + '.json');
  H.write(f, '[]');
  H.ok('空结果不登记', tool(proj, 'selftest', '--task', TASK, '--results', f).code !== 0);
  H.write(f, JSON.stringify([{ case: 'AC-01', result: 'fail', note: '空列表 500' }]));
  const failed = tool(proj, 'selftest', '--task', TASK, '--results', f);
  H.ok('有没过的不登记，说怎么办', /"ok": false/.test(failed.out) && /revisions/.test(failed.out), failed);
  H.write(f, JSON.stringify([{ case: 'AC-01', result: 'pass', note: '通过' }]));
  H.ok('没真跑过命令：pass 不认', /没有本机跑过/.test(tool(proj, 'selftest', '--task', TASK, '--results', f).err));
  H.write(f, JSON.stringify([{ case: 'AC-01', result: 'manual', note: '要人看' }]));
  const okRun = tool(proj, 'selftest', '--task', TASK, '--results', f);
  H.ok('登记了', /"ok": true/.test(okRun.out), okRun);
  H.ok('进人工核验', B && B.phaseOf(B.named(proj, TASK)).phase === 'verify');
  H.ok('状态写等你核验，自动也停', S.flowView(j).waiting === '等你核验' && S.flowView(j).effective === false, S.flowView(j));
  tool(proj, 'suggest', '--task', TASK, '--text', '导出时加个进度条');
  const v = H.reasonOf(stop(j));
  H.ok('收工：交给用户，列范围外建议', /人工核验/.test(v) && /范围外建议/.test(v) && /1 条/.test(v), v);
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
  stop(j);
  H.ok('改过代码：退回全面自测', B.phaseOf(B.named(proj, TASK)).phase === 'selftest', B.phaseOf(B.named(proj, TASK)));
}

H.section('后面的 change 不写 MODIFIED 改前面没归档的需求');
{
  const proj = project(['c1', 'c2']);
  docs(proj, 'c1', 1, 0);
  const j = session(proj, [H.tr.user('接着')]);
  S.setFlow(j, true, '测试', 'plan');
  const f = path.join(proj, 'openspec', 'changes', 'c2', 'specs', 'order', 'spec.md');
  const body = '## MODIFIED Requirements\n\n### Requirement: 导出订单\n\nThe system SHALL export orders with date.\n\n#### Scenario: 导出\n\n- **WHEN** 点导出\n- **THEN** 得到文件\n';
  const r = H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Write', tool_input: { file_path: f, content: body }, hook_event_name: 'PreToolUse' }));
  H.ok('拦下，说直接改 c1', /是 c1 新增的/.test(H.reasonOf(r)) && /拦截编号/.test(H.reasonOf(r)), r);
}

H.section('归档前预演，按表的顺序');
{
  const proj = project(['c1', 'c2']);
  const d1 = docs(proj, 'c1', 1, 0); const d2 = docs(proj, 'c2', 1, 0, 'MODIFIED');
  H.reviewPoints(h, d1, 'code'); H.reviewPoints(h, d2, 'code');
  const j = session(proj, [H.tr.user('归档')]);
  S.setFlow(j, true, '测试', 'apply');
  const arch = (c) => H.reasonOf(H.hook(h, 'guard-commit', Object.assign({}, j, { tool_name: 'Bash', tool_input: { command: 'openspec archive ' + c + ' -y' }, hook_event_name: 'PreToolUse' })));
  H.ok('顺序错：拦下', /按 plan\.md 表的顺序/.test(arch('c2')), arch('c2'));
  H.ok('没预演：拦下，说怎么预演', /archive-check/.test(arch('c1')), arch('c1'));
  const f = path.join(d1, 'specs', 'order', 'spec.md');
  H.write(f, H.read(f).replace('导出订单', '导出报表'));
  const bad = tool(proj, 'archive-check', '--task', TASK);
  H.ok('预演发现 c2 对不上，说清楚', /"ok": false/.test(bad.out) && /c2/.test(bad.out), bad);
  H.ok('真目录没动', fs.existsSync(d1) && fs.existsSync(d2) && !fs.existsSync(path.join(proj, 'openspec', 'specs', 'order', 'spec.md')));
  H.ok('临时目录删了', !fs.existsSync(path.join(proj, '.vibe', 'tmp', 'archive-check-' + TASK)));
  H.write(f, H.read(f).replace('导出报表', '导出订单'));
  const ok = tool(proj, 'archive-check', '--task', TASK);
  H.ok('对齐后预演过', /"ok": true/.test(ok.out), ok);
  H.ok('预演过：不再拦预演这一条', !/archive-check/.test(arch('c1')), arch('c1'));
  H.write(f, H.read(f) + '\n');
  H.ok('需求又变了：要重新预演', /archive-check/.test(arch('c1')), arch('c1'));
}

H.section('探索完之后范围不能自己改（第 43 条）');
{
  const proj = project(['c1']);
  const d = docs(proj, 'c1', 1, 1);
  const ex = path.join(proj, 'openspec', 'explore', TASK + '.md');
  const plan = path.join(proj, 'openspec', 'plan.md');
  const j = session(proj, [H.tr.user('开工')]);
  S.setFlow(j, true, '测试', 'apply');
  S.setSessionAuto(j, true, '测试');
  A.grant(j, '开工 c1', '', {});
  H.ok('用户开口这一轮能改范围', !H.reasonOf(edit(j, ex, '只做导出', '只做导出和筛选')), edit(j, ex, '只做导出', '只做导出和筛选'));
  stop(j);
  let r = H.reasonOf(edit(j, ex, '只做导出', '只做导出和进度条'));
  H.ok('收工之后（自动长跑）：模型自己改范围被拦', /只有用户开口的那一轮能改/.test(r) && /suggest/.test(r), r);
  H.ok('定了的也一样', /只有用户开口/.test(H.reasonOf(edit(j, ex, '导出 xlsx', '导出 xlsx 和 csv'))));
  r = H.reasonOf(edit(j, ex, '## 落地偏差\n\n', '## 落地偏差\n\nc1 改了字段名\n\n'));
  H.ok('落地偏差随时能写', !r, r);
  r = H.reasonOf(edit(j, plan, '| | c1 | | |\n', '| | c1 | | |\n| | c9 | | |\n'));
  H.ok('自动长跑时往 plan.md 加行被拦（第 38 条）', /不能自己加行/.test(r), r);
  H.transcript(j.transcript_path, [Object.assign(H.tr.user('范围加上筛选，plan 加一个 c9'), { timestamp: new Date(Date.now() + 5000).toISOString() })]);
  r = H.reasonOf(edit(j, ex, '只做导出', '只做导出和筛选'));
  H.ok('用户又开口：能改', !r, r);
  void d;

  const fresh = project(['c1']);
  const ex2 = path.join(fresh, 'openspec', 'explore', TASK + '.md');
  const k = session(fresh, [H.tr.user('/opsx:explore')]);
  S.setFlow(k, true, '测试', 'plan');
  stop(k);
  H.ok('探索中都放行', !H.reasonOf(edit(k, ex2, '只做导出', '只做导出和筛选')));
  const none = session(proj, [H.tr.user('随便')]);
  stop(none);
  H.ok('不在流程里不管', !H.reasonOf(edit(none, ex, '只做导出', '只做导出。')));
}

H.done('一个大任务多个 change');
