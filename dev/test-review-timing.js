'use strict';
/*
 * 审查时机（问题表第 57、58 条，仓库主人 2026-11-05 定的）：
 *   需求文档：自动模式写到 tasks 再审一次整套，中间不审、不停；人工模式写完一份提醒看一看、引导下一步，tasks 写完才问要不要审。
 *   代码：组之间不审、不挡下一组，这个 change 的任务全部做完审一次整个 change 的改动。
 * 用法：node dev/test-review-timing.js [旧套件目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const FROM = process.argv[2];

const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false, commitMode: 'off', pullBeforeWork: false, outputGate: false };
const PROPOSAL = '## Why\n\n要查询订单。\n\n## What Changes\n\n- 加查询接口\n';
const SPEC = '## ADDED Requirements\n\n### Requirement: 查询\n\n系统 SHALL 能查询订单。\n\n#### Scenario: 空列表\n\n- **WHEN** 没有订单时查询\n- **THEN** 返回空列表\n';
const DESIGN = ['## Context', '', '- 读过 a.js：现在只有查询', '- 读过 b.js：入口在这里', '', '## Decisions', '', '- 查询放在 a.js 里：只有一个接口', '', '## 验收用例', '', '| 编号 | 对应场景 | 前置数据和环境 | 步骤 | 预期 | 谁来测 | 对应任务 |', '|---|---|---|---|---|---|---|', '| AC-1 | 空列表 | 没有订单 | 调查询 | 返回空列表 | Claude：node a.js | 1 |', ''].join('\n');
const TASKS = '## 1. 查询\n\n- [ ] 1.1 改 a.js：加查询\n- [ ] 1.2 改 b.js：加入口\n\n## 2. 交付\n\n- [ ] 2.1 改 a.js：补空列表\n';
const GOOD = { id: 'ok', status: 'completed', issues: [] };
const blocked = (r) => !!r && /"permissionDecision":"deny"|"decision":"block"/.test(JSON.stringify(r));

function project(h, name) {
  const p = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n', 'c.js': 'let c=1;\n' });
  return { p, d: path.join(p, 'openspec', 'changes', 'add-a') };
}
const doc = (d, kind) => path.join(d, kind === 'specs' ? 'specs/order/spec.md' : kind + '.md');
const put = (d, kind) => H.write(doc(d, kind), { proposal: PROPOSAL, specs: SPEC, design: DESIGN, tasks: TASKS }[kind]);
const ago = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); };
const tick = (d, id) => H.write(doc(d, 'tasks'), H.read(doc(d, 'tasks')).replace('- [ ] ' + id, '- [x] ' + id));
// 拿旧版跑时 prepare、resolve 会报错：记成不过，不让整个测试停在这里
const review = async (...a) => { try { return await H.fakeReview(...a); } catch (e) { return { status: 'error', error: e.message, issues: [] }; } };

(async () => {
  const watch = await H.watchWindows('review-timing-win');
  let seq = 0;

  H.section('审查点：必审的只有整套文档、整个 change；单份文档、某一组用户点名才审');
  {
    const h = H.makeHome('timing-points', FROM, QUIET);
    const P = require(path.join(h.kit, 'lib/flow-policy')); const R = require(path.join(h.kit, 'lib/review-runner')); const S = require(path.join(h.kit, 'lib/session'));
    const { p, d } = project(h, 'p');
    const j = { cwd: p, session_id: 'points' };
    put(d, 'proposal');
    H.ok('只写了 proposal：没有必审的点', P.points(d, 'proposal').length === 0, P.points(d, 'proposal'));
    put(d, 'specs'); put(d, 'design');
    H.ok('写了三份：还是没有必审的点', P.points(d, 'proposal').length === 0, P.points(d, 'proposal'));
    H.ok('写好的文档另外查得到', !!P.written && P.written(d).join() === 'proposal,specs,design');
    put(d, 'tasks');
    H.ok('tasks 写了：只有一个必审的点 tasks', P.points(d, 'proposal').join() === 'tasks', P.points(d, 'proposal'));
    H.ok('整套审过才算文档审完', !P.allDone(d, 'proposal'));
    H.ok('用户点名审 proposal：还能审', !!P.reviewable && P.reviewable(d, 'proposal').includes('proposal'));
    let prep = null; try { prep = R.prepare({ cwd: p, change: 'add-a', mode: 'proposal', point: 'proposal' }); } catch (e) { prep = { error: e.message }; }
    H.ok('prepare --point proposal 不报错', prep && prep.status === 'prepared', prep);
    try { R.cancel({ cwd: p, change: 'add-a', mode: 'proposal', point: 'proposal' }); } catch (e) { /* 取消不了不影响后面 */ }
    P.noteResult(d, 'proposal', GOOD, P.fingerprint(d, 'proposal'));
    H.ok('单份审过不算整套审完', !P.allDone(d, 'proposal'));
    P.noteResult(d, 'tasks', GOOD, P.fingerprint(d, 'tasks'));
    H.ok('审查点 tasks 过了就算文档审完（别的几份不用单独审）', P.allDone(d, 'proposal') && P.allPassed(d, 'proposal'));
    H.write(doc(d, 'design'), DESIGN + '\n修订：空列表也要总数。\n');
    H.ok('改了 design：整套的结论失效', !P.allDone(d, 'proposal') && P.pending(d, 'proposal') === 'tasks', P.pending(d, 'proposal'));
    H.write(doc(d, 'design'), DESIGN);

    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案 add-a']);
    R.baseline(j, [d]);
    H.ok('一项没勾：没有代码审查点', P.points(d, 'code').length === 0);
    tick(d, '1.1'); tick(d, '1.2');
    H.ok('第 1 组做完、第 2 组没做：还是没有必审的点', P.points(d, 'code').length === 0, P.points(d, 'code'));
    H.ok('第 1 组做完：用户点名能审', P.reviewable && P.reviewable(d, 'code').includes('group-1'), P.reviewable && P.reviewable(d, 'code'));
    H.ok('还没到的时候 pending 是空的', !P.pending(d, 'code'), P.pending(d, 'code'));
    H.write(path.join(p, 'b.js'), 'let b=2;\n'); H.write(path.join(p, 'c.js'), 'let c=9;\n');
    let groupScope = '';
    const named = await review(R, { cwd: p, change: 'add-a', mode: 'code', point: 'group-1' }, (lens, text) => { groupScope = text; return { issues: [] }; });
    const groupFiles = (groupScope.split('## 要审的文件')[1] || '').split('## 怎么交')[0];
    H.ok('用户点名审第 1 组：只审任务点名的文件', named.status === 'completed' && /b\.js/.test(groupFiles) && !/c\.js/.test(groupFiles), groupFiles);
    H.ok('点名审过一组：不算必审的点，不挡也不算 change 审过', !P.pending(d, 'code') && !P.settled(d, 'change'));
    H.git(p, ['checkout', '--', 'b.js', 'c.js']);
    let early = ''; try { R.prepare({ cwd: p, change: 'add-a', mode: 'code', point: 'change' }); } catch (e) { early = e.message; }
    H.ok('任务没做完 prepare --point change：报错说清什么时候能审', /全部做完/.test(early), early);
    tick(d, '2.1');
    H.ok('全部做完：必审的点只有 change，没有 group-1、group-rest', P.points(d, 'code').join() === 'change', P.points(d, 'code'));
    H.ok('pending 是 change', P.pending(d, 'code') === 'change', P.pending(d, 'code'));

    H.section('整个 change 的审查：审全部改动，没点名的文件也在');
    H.write(path.join(p, 'a.js'), 'let a=2;\n'); H.write(path.join(p, 'c.js'), 'let c=2;\n');
    let scope = '';
    const r = await review(R,{ cwd: p, change: 'add-a', mode: 'code', point: 'change' }, (lens, text) => { scope = text; return { issues: [] }; });
    H.ok('审查完成，记在 change 上', r.status === 'completed' && P.settled(d, 'change'), r);
    H.ok('范围文件里有任务点名的 a.js', /a\.js/.test(scope), scope.slice(0, 400));
    H.ok('范围文件里有没点名的 c.js', /c\.js/.test(scope), scope.slice(0, 400));
    H.ok('整个 change 过了：代码审完', P.allPassed(d, 'code') && S.codeReviewIssue(d) === '', S.codeReviewIssue(d));
    H.write(path.join(p, 'c.js'), 'let c=3;\n');
    H.ok('审过之后改了没点名的文件：结论失效，要再审', !P.settled(d, 'change') && P.pending(d, 'code') === 'change');
    P.noteResult(d, 'change', GOOD, P.fingerprint(d, 'change'));
    H.ok('记上当前输入之后又过了', P.settled(d, 'change'));

    H.section('后面的 change 开工了，不把前面审过的重新打开');
    const d2 = path.join(p, 'openspec', 'changes', 'add-b'); put(d2, 'proposal');
    S.updateState('work-baselines', (o) => { o[S.normKey(d2)] = Object.assign({}, o[S.normKey(d)], { at: (o[S.normKey(d)].at || 0) + 1000 }); });
    H.write(path.join(p, 'c.js'), 'let c=4;\n'); H.write(path.join(p, 'e.js'), 'let e=1;\n');
    H.ok('后面的 change 开工之后代码变了：前面的 change 还算审过', P.settled(d, 'change') && !P.pending(d, 'code'), P.pending(d, 'code'));
    H.write(doc(d, 'tasks'), H.read(doc(d, 'tasks')).replace('补空列表', '补空列表和总数'));
    H.ok('但它自己的任务文字改了（回改）：要再审', !P.settled(d, 'change') && P.pending(d, 'code') === 'change');
  }

  H.section('升级：旧版按组审完的 change 不再整个重审');
  {
    const h = H.makeHome('timing-old', FROM, QUIET);
    const P = require(path.join(h.kit, 'lib/flow-policy')); const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner'));
    const { p, d } = project(h, 'p');
    for (const k of ['proposal', 'specs', 'design', 'tasks']) put(d, k);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']); R.baseline({ cwd: p, session_id: 'old' }, [d]);
    tick(d, '1.1'); tick(d, '1.2'); tick(d, '2.1');
    P.noteResult(d, 'group-1', GOOD, P.fingerprint(d, 'group-1'));
    H.ok('只审过一组：要审整个 change', P.pending(d, 'code') === 'change', P.pending(d, 'code'));
    P.noteResult(d, 'group-2', GOOD, P.fingerprint(d, 'group-2'));
    H.ok('每组都审过：算审过，不重审', P.settled(d, 'change') && !P.pending(d, 'code') && S.codeReviewIssue(d) === '', [P.pending(d, 'code'), S.codeReviewIssue(d)]);
    H.ok('工作流事实里算审完', require(path.join(h.kit, 'lib/workflow')).facts(p).changes[0].review === 'completed', require(path.join(h.kit, 'lib/workflow')).facts(p).changes[0]);
    H.write(path.join(p, 'a.js'), 'let a=9;\n');
    H.ok('之后又改了组里的文件：要审整个 change', P.pending(d, 'code') === 'change', P.pending(d, 'code'));
    P.noteResult(d, 'group-1', GOOD, P.fingerprint(d, 'group-1')); P.noteResult(d, 'group-2', GOOD, P.fingerprint(d, 'group-2'));
    H.write(path.join(p, 'c.js'), 'let c=2;\n');
    H.ok('复审 3：每组过了、没点名的文件有改动、group-rest 没审：要审整个 change', P.pending(d, 'code') === 'change', P.pending(d, 'code'));
    P.noteResult(d, 'group-rest', GOOD, 'old');
    H.ok('复审 3：旧版 group-rest 也审过：算审过', !P.pending(d, 'code'), P.pending(d, 'code'));
  }

  H.section('复审 20261105：大任务里的基线、审查范围');
  {
    const h = H.makeHome('timing-big', FROM, QUIET);
    const P = require(path.join(h.kit, 'lib/flow-policy')); const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner')); const A = require(path.join(h.kit, 'lib/apply-scope'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n', 'c.js': 'let c=1;\n' });
    const c1 = path.join(p, 'openspec/changes/c1'); const c2 = path.join(p, 'openspec/changes/c2');
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | c1 | | |\n| | c2 | | |\n');
    H.write(path.join(p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    for (const d of [c1, c2]) for (const k of ['proposal', 'specs', 'design', 'tasks']) put(d, k);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']);
    const j = { cwd: p, session_id: 'big', transcript_path: H.transcript(path.join(h.root, 'big.jsonl'), [H.tr.user('开工 c1')]) };
    S.setFlow(j, true, '开工', 'apply'); S.flowTouch(j, c1); S.flowTouch(j, c2);
    A.grant(j, '开工 c1', '');
    const has = (d) => !!S.readState('work-baselines')[S.normKey(d)];
    H.ok('开工 c1：只记 c1 的基线，c2 还没开工不记', has(c1) && !has(c2), Object.keys(S.readState('work-baselines')));
    tick(c1, '1.1'); tick(c1, '1.2'); tick(c1, '2.1');
    H.write(path.join(p, 'a.js'), 'let a=2;\n');
    const r1 = await review(R, { cwd: p, change: 'c1', mode: 'code', point: 'change' });
    H.ok('c1 审过', r1.status === 'completed' && P.settled(c1, 'change'), r1);
    H.write(path.join(p, 'a.js'), 'let a=3; // 审过之后修的 bug\n');
    H.ok('复审 1：c2 还没开工，c1 审过后又改代码：要再审', !P.settled(c1, 'change') && P.pending(c1, 'code') === 'change');
    P.noteResult(c1, 'change', GOOD, P.fingerprint(c1, 'change'));
    await new Promise((ok) => setTimeout(ok, 30));
    A.grant(j, '开工 c2', '');
    H.ok('开工 c2：这时才记 c2 的基线', has(c2));
    H.write(path.join(p, 'b.js'), 'let b=2;\n');
    H.ok('c2 开工后改代码：不重开 c1', P.settled(c1, 'change'));
    tick(c2, '1.1'); tick(c2, '1.2'); tick(c2, '2.1');
    let scope = '';
    const r2 = await review(R, { cwd: p, change: 'c2', mode: 'code', point: 'change' }, (lens, text) => { scope = text; return { issues: [] }; });
    const list = (scope.split('## 要审的文件')[1] || '').split('## 怎么交')[0];
    H.ok('复审 2：c2 的审查只有它自己改的 b.js，没有 c1 没提交的 a.js', r2.status === 'completed' && /b\.js/.test(list) && !/(^|\W)a\.js/.test(list), list);
    H.write(path.join(p, 'a.js'), 'let a=4; // c2 也改了它\n');
    await review(R, { cwd: p, change: 'c2', mode: 'code', point: 'change', full: true }, (lens, text) => { scope = text; return { issues: [] }; });
    const list2 = (scope.split('## 要审的文件')[1] || '').split('## 怎么交')[0];
    H.ok('c1 改过的文件 c2 开工后又动了：算 c2 的，要审', /(^|\W)a\.js/.test(list2), list2);
    // 归档了的不算后面开工的
    P.noteResult(c1, 'change', GOOD, P.fingerprint(c1, 'change'));
    fs.rmSync(c2, { recursive: true, force: true });
    H.write(path.join(p, 'c.js'), 'let c=8;\n');
    H.ok('复审 4：后面的 change 归档了（目录不在）：c1 再改代码要再审', !P.settled(c1, 'change'), P.fingerprint(c1, 'change'));
    // 构建输出不让结论失效
    P.noteResult(c1, 'change', GOOD, P.fingerprint(c1, 'change'));
    H.write(path.join(p, 'target/app.log'), 'x\n');
    H.ok('复审 6：构建目录变了：结论不失效', P.settled(c1, 'change'));
    // 同名变更重建：旧基线不认
    const old = S.readState('work-baselines')[S.normKey(c1)];
    S.updateState('work-baselines', (o) => { o[S.normKey(c1)].born = 1; });
    R.baseline(j, [c1]);
    const fresh = S.readState('work-baselines')[S.normKey(c1)];
    H.ok('复审 4：同名变更重建（born 不一样）：基线重记', fresh.born !== 1 && fresh.at >= old.at, fresh);
  }

  H.section('写需求（第 85 条起开不开自动都一样）：写到 tasks 再审，中间不审、不停');
  {
    const h = H.makeHome('timing-auto', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy')); const A = require(path.join(h.kit, 'lib/apply-scope'));
    const cfg = (patch) => { const c = Object.assign(JSON.parse(H.read(path.join(h.kit, 'config.json'))), patch); H.write(path.join(h.kit, 'config.json'), JSON.stringify(c)); S.sealConfig(h.kit, c); };
    const { p, d } = project(h, 'p');
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | add-a | | |\n');
    H.write(path.join(p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    const tf = (entries) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), entries);
    const j = { cwd: p, session_id: 'auto-plan', transcript_path: tf([H.tr.user('实现订单查询')]) };
    cfg({ autoApply: true, autoRequirements: true });
    S.setFlow(j, true, '需求', 'plan'); S.flowTouch(j, d);
    put(d, 'proposal');
    H.ok('写需求这一段不算自动（第 85 条：需求阶段没有自动模式）', !S.readConfigFor(j).autoMode);
    const pre = (kind) => H.hook(h, 'pre-edit', Object.assign({}, j, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: doc(d, kind), content: { specs: SPEC, design: DESIGN, tasks: TASKS }[kind] } }));
    const r1 = pre('specs');
    H.ok('proposal 没审也能写 specs', !blocked(r1), H.reasonOf(r1));
    const m1 = P.stop(j, [d], false, 't1');
    H.ok('只写了 proposal 就停了：催接着写 specs，不催审查', m1.some((x) => /接着写 specs/.test(x)) && !m1.some((x) => /review\.js prepare/.test(x)), m1);
    H.ok('同样的内容只催一次', P.stop(j, [d], false, 't1').length === 0);
    const guard = (point, said) => H.hook(h, 'guard-commit', Object.assign({}, j, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'g' + (++seq), transcript_path: said ? tf([H.tr.user(said)]) : j.transcript_path, tool_input: { command: 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" prepare --change add-a --mode proposal --point ' + point + ' --project "' + p.replace(/\\/g, '/') + '"' } }));
    const r2 = guard('proposal');
    H.ok('没人要求就单独审 proposal：拦下，说写完 tasks 再审', /需求文档不单独审 proposal/.test(H.reasonOf(r2)) && /--point tasks/.test(H.reasonOf(r2)), H.reasonOf(r2));
    const r3 = guard('proposal', '审一下 proposal');
    H.ok('用户说了审一下：放行', !/不单独审/.test(H.reasonOf(r3)), H.reasonOf(r3));
    put(d, 'specs');
    H.ok('specs 写了、design 没写：催 design', P.stop(j, [d], false, 't2').some((x) => /接着写 design/.test(x)));
    const r4 = pre('design');
    H.ok('specs 没审也能写 design', !blocked(r4), H.reasonOf(r4));
    put(d, 'design');
    const r5 = pre('tasks');
    H.ok('design 没审也能写 tasks', !blocked(r5), H.reasonOf(r5));
    put(d, 'tasks');
    const m2 = P.stop(j, [d], false, 't3');
    H.ok('tasks 写完：催审一次整套（--point tasks）', m2.some((x) => /四份需求文档写完了/.test(x) && /--point tasks/.test(x)), m2);
    H.ok('审查点 tasks：放行，不问用户', !/不单独审|没说要审查/.test(H.reasonOf(guard('tasks'))));
    H.ok('整套没审：不问怎么实施', !P.allDone(d, 'proposal'));
    P.noteResult(d, 'tasks', GOOD, P.fingerprint(d, 'tasks'));
    const ask = P.planNext(j, { dir: d, name: 'add-a' });
    H.ok('整套审过：停下问怎么实施（自动实施 / 实施（每步问我）/ 先不实施），不自己开工（第 86 条）', /自动实施/.test(ask) && /先不实施/.test(ask) && S.flowStage(j) === 'plan', ask);

    H.section('自动模式做任务：组之间不审、不挡，全部做完审一次');
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案 add-a']);
    A.grant(j, 'add-a', ''); S.setFlow(j, true, '提问框选了自动实施', 'apply');
    const tickEdit = (id) => H.hook(h, 'pre-edit', Object.assign({}, j, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: doc(d, 'tasks'), old_string: '- [ ] ' + id, new_string: '- [x] ' + id } }));
    const r6 = tickEdit('1.1');
    H.ok('第一次打勾：文档审过了就放行', !blocked(r6), H.reasonOf(r6));
    tick(d, '1.1');
    const r7 = tickEdit('2.1');
    H.ok('上一组没做完就勾下一组：照旧拦，只说先做完', blocked(r7) && /先做完上一组/.test(H.reasonOf(r7)) && !/review\.js/.test(H.reasonOf(r7)), H.reasonOf(r7));
    tick(d, '1.2');
    H.write(path.join(p, 'a.js'), 'let a=2;\n');
    const m3 = P.stop(j, [d], true, 't4');
    H.ok('第 1 组做完：不催审查', !m3.some((x) => /review\.js prepare/.test(x)), m3);
    const r8 = tickEdit('2.1');
    H.ok('第 1 组没审也能勾第 2 组', !blocked(r8), H.reasonOf(r8));
    tick(d, '2.1');
    const m4 = P.stop(j, [d], true, 't5');
    H.ok('全部做完：催审整个 change（--point change）', m4.some((x) => /任务全部做完了/.test(x) && /--point change/.test(x)), m4);
    const stopHook = H.hook(h, 'verify-gate', Object.assign({}, j, { hook_event_name: 'Stop', transcript_path: tf([H.tr.user('接着做'), H.tr.ran('Edit', { file_path: doc(d, 'tasks'), old_string: '- [ ] 2.1', new_string: '- [x] 2.1' }, 'ok')]) }));
    H.ok('真走收工钩子：不会催去审 group-1、group-rest', !/group-1|group-rest/.test(H.reasonOf(stopHook)), H.reasonOf(stopHook));
  }

  H.section('没开自动写需求（第 85 条起和开着一样）：一次写到 tasks，不停下看一看；tasks 写完强制审，不问');
  {
    const h = H.makeHome('timing-manual', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy'));
    const { p, d } = project(h, 'p');
    const tf = (entries) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), entries);
    const j = { cwd: p, session_id: 'manual-plan', transcript_path: tf([H.tr.user('写需求')]) };
    S.setFlow(j, true, '需求', 'plan'); S.flowTouch(j, d);
    put(d, 'proposal');
    const m1 = P.stop(j, [d], false, 't1');
    H.ok('proposal 写完：催接着写 specs，不提醒看一看（以前停下看一看）', m1.some((x) => /接着写 specs/.test(x)) && !m1.some((x) => /看一看/.test(x)), m1);
    H.ok('proposal 写完：不问审查', !m1.some((x) => /审一下/.test(x)), m1);
    const pre = (kind, entries) => H.hook(h, 'pre-edit', { cwd: p, session_id: 'manual-plan', hook_event_name: 'PreToolUse', tool_name: 'Write', transcript_path: tf(entries || [H.tr.user('写需求')]), tool_input: { file_path: doc(d, kind), content: { specs: SPEC, design: DESIGN, tasks: TASKS }[kind] } });
    const early = pre('specs');
    H.ok('用户还没看就写 specs：不拦（以前拦下引导下一步）', !blocked(early), H.reasonOf(early));
    put(d, 'specs');
    H.ok('specs 写完：催写 design，不问审查', P.stop(j, [d], false, 't2').every((x) => /接着写 design/.test(x) && !/审一下/.test(x)));
    put(d, 'design');
    H.ok('design 写完：催写 tasks，不问审查', P.stop(j, [d], false, 't3').every((x) => /接着写 tasks/.test(x) && !/审一下/.test(x)));
    put(d, 'tasks');
    const m2 = P.stop(j, [d], false, 't4');
    H.ok('tasks 写完：强制审整套，不问要不要审、不问定稿', m2.some((x) => /四份需求文档写完了，强制审一次整套/.test(x) && /--point tasks/.test(x)) && !m2.some((x) => /定稿并开工|只定稿|Ask 问要不要审/.test(x)), m2);
    P.noteResult(d, 'tasks', GOOD, P.fingerprint(d, 'tasks'));
    H.ok('整套审过：不再回头催前面几份', P.stop(j, [d], false, 't5').length === 0);
    H.section('人工模式做任务：组之间不问，全部做完问一次审查和自测');
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案 add-a']);
    S.setFlow(j, true, '开工', 'apply');
    tick(d, '1.1'); tick(d, '1.2');
    const m3 = P.stop(j, [d], true, 't6');
    H.ok('第 1 组做完：不问审查、自测', !m3.some((x) => /group-1|要不要.*审查/.test(x)), m3);
    tick(d, '2.1');
    const m4 = P.stop(j, [d], true, 't7');
    H.ok('全部做完：问一次审查和自测', m4.some((x) => /任务全部做完了/.test(x) && /审查/.test(x) && /自测/.test(x)), m4);
    H.ok('同一个要求不问第二次', P.stop(j, [d], true, 't7').length === 0);
  }

  H.section('审整套文档：四份都审，不当上游；点名审单份的还是只审那一份');
  {
    const h = H.makeHome('timing-docs', FROM, QUIET);
    const P = require(path.join(h.kit, 'lib/flow-policy')); const R = require(path.join(h.kit, 'lib/review-runner'));
    const { p, d } = project(h, 'p');
    for (const k of ['proposal', 'specs', 'design', 'tasks']) put(d, k);
    let one = '';
    const issue = { severity: 'P2', file: 'proposal.md', line: 1, problem: '没写算法步骤', evidence: '提案里没有', fix: '写到后面的文档', scope: 'in' };
    const r1 = await review(R,{ cwd: p, change: 'add-a', mode: 'proposal', point: 'proposal' }, (lens, text) => { one = text; return { issues: [issue] }; });
    H.ok('点名审 proposal：能审', r1.status === 'completed', r1);
    H.ok('点名审 proposal：提示是提案那一段', /这是提案/.test(one) && !/整套需求文档/.test(one), one.slice(0, 300));
    const decisions = path.join(h.root, 'd1.json');
    H.write(decisions, JSON.stringify({ findings: r1.issues.map((x) => ({ id: x.id, action: 'deferred', reason: '算法步骤归 design，留给后面的文档' })) }));
    try { R.resolve({ cwd: p, change: 'add-a', mode: 'proposal', point: 'proposal', decisions }); } catch (e) { H.ok('点名审 proposal：能标 deferred', false, e.message); }
    let all = '';
    const r2 = await review(R,{ cwd: p, change: 'add-a', mode: 'proposal', point: 'tasks' }, (lens, text) => { all = text; return { issues: [Object.assign({}, issue, { file: 'design.md', problem: '缺字段规则' })] }; });
    H.ok('审整套：能审', r2.status === 'completed', r2);
    H.ok('审整套：提示说四份都要看', /整套需求文档/.test(all), all.slice(0, 400));
    const listed = (all.split('## 要审的文件')[1] || '').split('## 怎么交')[0];
    H.ok('审整套：四份都列在要审的文件里', /proposal\.md/.test(listed) && /specs\/order\/spec\.md/.test(listed) && /design\.md/.test(listed) && /tasks\.md/.test(listed), listed);
    H.ok('审整套：没有哪份标成只用来核对', !/上游文档/.test(listed), listed);
    H.ok('审整套：单独审 proposal 时留下的要点带上了', /上游审查留给这一步的要点/.test(all) && /没写算法步骤/.test(all), all.slice(0, 600));
    const d2 = path.join(h.root, 'd2.json');
    H.write(d2, JSON.stringify({ findings: r2.issues.map((x) => ({ id: x.id, action: 'deferred', reason: '字段规则留给后面的文档再写' })) }));
    let err = ''; try { R.resolve({ cwd: p, change: 'add-a', mode: 'proposal', point: 'tasks', decisions: d2 }); } catch (e) { err = e.message; }
    H.ok('审整套不能标 deferred：没有后面的文档了', /没有后面的文档/.test(err), err);
    H.ok('下一步的提示不再让它标 deferred', !/标 deferred/.test(String(r2.next || '')), r2.next);
    H.ok('P 的导出齐全', ['written', 'reviewable', 'sameInput'].every((k) => typeof P[k] === 'function'));
  }

  H.section('状态栏：组后面不再有审查标记，change 末尾一个"审查"');
  {
    const h = H.makeHome('timing-bar', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy')); const B = require(path.join(h.kit, 'lib/big-task'));
    const { p, d } = project(h, 'p');
    for (const k of ['proposal', 'specs', 'design', 'tasks']) put(d, k);
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | add-a | | |\n');
    H.write(path.join(p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    const j = { cwd: p, session_id: 'bar' };
    S.setFlow(j, true, '开工', 'apply'); S.flowTouch(j, d);
    P.noteResult(d, 'tasks', GOOD, P.fingerprint(d, 'tasks'));
    const bar = () => B.bar(j).steps;
    H.ok('文档审过：◆ 在任务后面，前面三份只有 ✓', /提案✓ 规格✓ 设计✓ 任务✓◆/.test(bar()), bar());
    H.ok('没开始：审查○', /审查○/.test(bar()), bar());
    tick(d, '1.1');
    H.ok('做了一半：审查○', /审查○/.test(bar()), bar());
    tick(d, '1.2'); tick(d, '2.1');
    H.ok('全部做完没审：审查●', /审查●/.test(bar()), bar());
    P.begin(d, 'change', 'x', P.fingerprint(d, 'change'));
    H.ok('在审：审查◇', /审查◇/.test(bar()), bar());
    P.noteResult(d, 'change', { id: 'x', status: 'completed', issues: [{ severity: 'P1' }, { severity: 'P2' }] }, P.fingerprint(d, 'change'));
    H.ok('有问题：审查✗2', /审查✗2/.test(bar()), bar());
    P.noteResult(d, 'change', GOOD, P.fingerprint(d, 'change'));
    H.ok('过了：审查◆', /审查◆/.test(bar()), bar());
  }

  H.section('人工模式不审：接着引导下一步，不停在这里');
  {
    const h = H.makeHome('timing-decline', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy')); const R = require(path.join(h.kit, 'lib/review-runner'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
    const c1 = path.join(p, 'openspec/changes/c1'); const c2 = path.join(p, 'openspec/changes/c2');
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | c1 | | |\n| | c2 | | |\n');
    H.write(path.join(p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    for (const k of ['proposal', 'specs', 'design', 'tasks']) put(c1, k);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']);
    const sid = 'decline'; const j = { cwd: p, session_id: sid };
    R.baseline(j, [c1]); S.setFlow(j, true, '开工', 'apply'); S.flowTouch(j, c1);
    tick(c1, '1.1'); tick(c1, '1.2'); tick(c1, '2.1');
    const tf = (entries) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), entries);
    const stop = (entries) => H.reasonOf(H.hook(h, 'verify-gate', { cwd: p, session_id: sid, hook_event_name: 'Stop', transcript_path: tf(entries) }));
    const said = [H.tr.user('开工'), H.tr.ran('Edit', { file_path: doc(c1, 'tasks'), old_string: '- [ ] 2.1', new_string: '- [x] 2.1' }, 'ok')];
    const first = stop(said);
    H.ok('第一次收工：问审查、自测，这时候不问接下一个', /任务全部做完了/.test(first) && !/接着做 c2/.test(first), first);
    const q1 = '要不要审查？'; const q2 = '要不要自测？';
    const answer = H.tr.ran('AskUserQuestion', { questions: [{ question: q1 }, { question: q2 }] }, 'User has answered your questions: "' + q1 + '"="不用", "' + q2 + '"="不用". You can now continue with the user\'s answers in mind.');
    const second = stop(said.concat([answer]));
    H.ok('你选了不审不测：引导接下一个 change', /接着做 c2/.test(second), second);
    H.ok('不审不算审过', !P.settled(c1, 'change'));
    P.noteResult(c1, 'change', { id: 'x', status: 'completed', issues: [{ id: 'r1', severity: 'P1' }] }, P.fingerprint(c1, 'change'));
    S.updateState(sid + '-workflow-prompts', (o) => { delete o['next|c2']; });
    const third = stop(said.concat([answer]));
    H.ok('审出问题还没处理：不往下走', !/接着做 c2/.test(third), third);
    S.updateState('review-points', (o) => { delete o[S.normKey(c1) + '|change']; });
    S.updateState(sid + '-workflow-prompts', (o) => { delete o['next|c2']; });
    const asked = stop([H.tr.user('审查一下，再跑一下测试'), H.tr.ran('Edit', { file_path: doc(c1, 'tasks'), old_string: '- [ ] 2.1', new_string: '- [x] 2.1' }, 'ok')]);
    H.ok('复审 5：这一轮你要了审查、还没审：不往下走', !/接着做 c2/.test(asked), asked);
  }

  H.section('给模型的说明跟着改了');
  {
    const SRC = FROM || path.join(__dirname, '..', 'vibe-kit');
    const rules = H.read(path.join(SRC, 'claude/rules/10-openspec.md')); const skill = H.read(path.join(SRC, 'claude/skills/vk-cross-review/SKILL.md')) || '';
    H.ok('规范：写到 tasks 审一次整套', /--point tasks/.test(rules) && !/当前产物审修结束再继续/.test(rules));
    H.ok('规范：change 做完审一次', /--point change/.test(rules) && !/每整组 1\.x 分别审/.test(rules));
    H.ok('审查技能：写法用 tasks、change', /--point tasks/.test(skill) && /--point change/.test(skill) && !/--point group-1 --project/.test(skill));
    const h = H.makeHome('timing-rules', FROM, QUIET);
    const St = require(path.join(h.kit, 'lib/stage-rules'));
    const plan = St.stageRules({ session_id: 'r1' }, 'plan', { autoSwitch: false }); const apply = St.stageRules({ session_id: 'r2' }, 'apply', { autoSwitch: false });
    const auto = St.stageRules({ session_id: 'r3' }, 'plan', { autoSwitch: true });
    H.ok('写需求那一段：--point tasks，一次写到 tasks、强制审、不问（第 85 条）', /--point tasks/.test(plan) && !/<proposal\|specs/.test(plan) && !/看一看/.test(plan) && /一次写到 tasks/.test(plan) && /强制审/.test(plan), plan);
    H.ok('写需求那一段：开不开自动说法一样，中间不停、不问审查', auto === plan.replace('r1', 'r3') || (/中间不停、不问审查/.test(auto) && /中间不停、不问审查/.test(plan)), auto);
    H.ok('做任务那一段：--point change', /--point change/.test(apply) && !/group-<组号>/.test(apply), apply);
  }

  await watch.stop();
  H.done('审查时机');
})().catch((e) => { console.error(e); process.exit(1); });
