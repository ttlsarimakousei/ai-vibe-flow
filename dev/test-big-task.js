'use strict';
/*
 * 大任务（lib/big-task.js，2026-11-03）：做到哪从文件算；plan.md 按大任务分节；探索记录骨架；/opsx:explore 边谈边写。
 * 用法：node dev/test-big-task.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('big-task', FROM);
const has = fs.existsSync(path.join(h.kit, 'lib', 'big-task.js'));
const B = has ? require(path.join(h.kit, 'lib', 'big-task.js')) : null;
const S = require(path.join(h.kit, 'lib', 'session.js'));

H.section('有 big-task.js');
H.ok('lib/big-task.js 在', has);
if (!has) H.done('大任务');

const proj = H.makeRepo(path.join(h.work, 'p'), { 'README.md': '# x\n' });
const os_ = path.join(proj, 'openspec');
const tool = (...a) => spawnSync(process.execPath, [path.join(h.kit, 'tools', 'plan.js')].concat(a), { cwd: proj, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const change = (n, done, todo) => H.write(path.join(os_, 'changes', n, 'tasks.md'), '## 1. x\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 做完的：a.js\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 没做的：a.js\n').join(''));

H.section('建大任务');
const r = tool('new', '--task', '订单导出', '--changes', 'c1-model,c2-api,c3-page');
H.ok('plan.js new 成功', r.status === 0, r.stdout + r.stderr);
const planText = H.read(path.join(os_, 'plan.md'));
H.ok('plan.md 有这一节和探索记录指针', /## 订单导出/.test(planText) && /探索记录：explore\/订单导出\.md/.test(planText), planText);
H.ok('表里有三个 change', ['c1-model', 'c2-api', 'c3-page'].every((c) => planText.includes('| ' + c + ' |')));
const ex = path.join(os_, 'explore', '订单导出.md');
const exText = H.read(ex);
H.ok('探索记录有固定的几节', ['原话和材料', '定了的', '否了的', '还没定的', '现状', '范围', '跨 change 约定', 'change: c2-api', '整体验收用例', '落地偏差'].every((s) => exText.includes('## ' + s)), exText);
tool('new', '--task', '订单导出', '--changes', 'c1-model,c4-extra');
const again = H.read(path.join(os_, 'plan.md'));
H.ok('再跑一次：不重复，缺的 change 补上', (again.match(/## 订单导出/g) || []).length === 1 && again.includes('| c4-extra |') && (again.match(/\| c1-model \|/g) || []).length === 1, again);
H.ok('探索记录已有就不动', H.read(ex) === exText);
fs.writeFileSync(path.join(os_, 'plan.md'), planText);

H.section('阶段从文件算');
const task = () => B.named(proj, '订单导出');
H.ok('认得这个大任务', !!task() && !task().legacy && task().explore === ex, task());
H.ok('范围没写：还在探索', B.phaseOf(task()).phase === 'explore', B.phaseOf(task()));
H.ok('缺什么说得出来', B.exploreIssues(task()).some((x) => /范围/.test(x)), B.exploreIssues(task()));
const fill = (t) => t.replace('<!-- 做什么、不做什么。需求、apply、自测都对着这一节，没写的不加 -->', '只做导出。').replace(/(## change: c1-model\n)<!--[^\n]*-->/, '$1目标：表结构。');
H.write(ex, fill(exText).replace('<!-- 写了就不能开工；定了就挪到"定了的" -->', '要不要带日期？'));
H.ok('还没定的有内容：不算探索完', B.phaseOf(task()).phase === 'explore' && B.exploreIssues(task()).some((x) => /还没定的/.test(x)), B.exploreIssues(task()));
H.write(ex, fill(exText));
H.ok('探索完：第一个 change 写需求', B.phaseOf(task()).phase === 'plan' && B.phaseOf(task()).change === 'c1-model', B.phaseOf(task()));
H.ok('这个 change 有一节', B.exploreIssues(task(), 'c1-model').length === 0);
H.ok('没有这一节的 change 说得出来', B.exploreIssues(task(), 'c9').some((x) => /c9/.test(x)));
H.ok('这一节是空的也说得出来', B.exploreIssues(task(), 'c2-api').some((x) => /c2-api/.test(x)));
change('c1-model', 0, 3);
H.ok('写了任务、一项没勾：还在写需求', B.phaseOf(task()).phase === 'plan' && B.phaseOf(task()).change === 'c1-model', B.phaseOf(task()));
change('c1-model', 1, 2);
H.ok('勾了一项：apply', B.phaseOf(task()).phase === 'apply' && B.phaseOf(task()).change === 'c1-model', B.phaseOf(task()));
change('c1-model', 3, 0);
H.ok('c1 做完：接 c2', B.phaseOf(task()).phase === 'plan' && B.phaseOf(task()).change === 'c2-api', B.phaseOf(task()));
change('c2-api', 2, 3);
H.ok('进度说得出后面还有 c3', /c1-model 任务全勾完/.test(B.progressText(task())) && /c2-api 做到 2\/5/.test(B.progressText(task())) && /后面还有 c3-page/.test(B.progressText(task())), B.progressText(task()));
change('c1-model', 3, 1);
H.ok('回改：c1 补了任务，先做 c1', B.phaseOf(task()).change === 'c1-model' && B.phaseOf(task()).phase === 'apply', B.phaseOf(task()));
change('c1-model', 4, 0); change('c2-api', 5, 0); change('c3-page', 2, 0);
H.ok('全勾完：全面自测', B.phaseOf(task()).phase === 'selftest', B.phaseOf(task()));
B.setTaskState(task(), { selfTest: { at: Date.now() } });
H.ok('自测过：等人工核验', B.phaseOf(task()).phase === 'verify', B.phaseOf(task()));
H.ok('状态跨会话留着（GLOBAL_STATE）', S.isGlobalStateFile ? S.isGlobalStateFile('big-task.json') : /big-task/.test(H.read(path.join(h.kit, 'lib', 'session-state.js'))));
fs.mkdirSync(path.join(os_, 'changes', 'archive'), { recursive: true });
fs.renameSync(path.join(os_, 'changes', 'c1-model'), path.join(os_, 'changes', 'archive', '2026-11-03-c1-model'));
H.ok('归档了一个：归档中，下一个是 c2', B.phaseOf(task()).phase === 'archive' && B.phaseOf(task()).change === 'c2-api', B.phaseOf(task()));
for (const c of ['c2-api', 'c3-page']) fs.renameSync(path.join(os_, 'changes', c), path.join(os_, 'changes', 'archive', '2026-11-03-' + c));
H.ok('都归档：做完', B.phaseOf(task()).phase === 'done', B.phaseOf(task()));

H.section('一张 plan.md 两个大任务，汇总不混');
const p2 = H.makeRepo(path.join(h.work, 'p2'), { 'README.md': '# x\n' });
const os2 = path.join(p2, 'openspec');
H.write(path.join(os2, 'plan.md'), '# 计划\n\n## 甲\n\n探索记录：explore/甲.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | a1 | | |\n| | a2 | | |\n\n## 乙\n\n探索记录：explore/乙.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | b1 | | |\n');
H.write(path.join(os2, 'changes', 'a1', 'tasks.md'), '- [x] 1.1 做完：a.js\n');
const sum = S.refreshPlan(os2);
H.ok('汇总按大任务分开', sum.tasks.length === 2 && sum.tasks[0].name === '甲' && sum.tasks[0].next === 'a2' && sum.tasks[1].name === '乙' && sum.tasks[1].next === 'b1', sum.tasks);
H.ok('big-task 认得两个', B.tasks(p2).map((t) => t.name).join() === '甲,乙');
H.ok('ofChange 找得到所属大任务', B.ofChange(p2, 'b1').name === '乙' && !B.ofChange(p2, 'zz'));
S.refreshPlan(os2, true);
const after = H.read(path.join(os2, 'plan.md'));
H.ok('写回状态列不动别的节', /## 乙/.test(after) && /探索记录：explore\/乙\.md/.test(after) && /\| a2 \| 未开始 \|/.test(after), after);

H.section('老的 plan.md');
const p3 = H.makeRepo(path.join(h.work, 'p3'), { 'README.md': '# x\n' });
const os3 = path.join(p3, 'openspec');
H.write(path.join(os3, 'plan.md'), '# 计划：老需求\n\n说明。\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | o1 | | |\n');
H.write(path.join(os3, 'changes', 'o1', 'tasks.md'), '- [ ] 1.1 没做：a.js\n');
const old = B.tasks(p3)[0];
H.ok('没有分节也认得，名字取标题', old && old.name === '老需求' && old.legacy, old);
H.ok('老任务不查探索记录', B.exploreIssues(old, 'o1').length === 0 && B.phaseOf(old).phase === 'plan', B.phaseOf(old));
const oldSum = S.refreshPlan(os3);
H.ok('老的汇总数字照旧', oldSum.total === 1 && oldSum.active.length === 1, oldSum);

H.section('/opsx:explore 的规矩');
const O = require(path.join(h.kit, 'lib', 'openspec.js'));
if (O.usable()) {
  const out = path.join(h.root, 'claude-out');
  fs.mkdirSync(out, { recursive: true });
  const inst = O.installClaudeFiles(out);
  H.ok('生成成功', inst.ok, inst);
  for (const f of ['commands/opsx/explore.md', 'skills/openspec-explore/SKILL.md']) {
    const t = H.read(path.join(out, f)) || '';
    H.ok(f + ' 带边谈边写的规矩', /探索结果边谈边写进文件/.test(t) && /plan\.js" new --task/.test(t), t.slice(0, 300));
    H.ok(f + ' frontmatter 还在最前面', t.startsWith('---'));
  }
  H.ok('propose 的规矩还在', /一份一份写/.test(H.read(path.join(out, 'commands/opsx/propose.md')) || ''));
  H.ok('别的命令不带', !/探索结果边谈边写/.test(H.read(path.join(out, 'commands/opsx/apply.md')) || ''));
} else H.ok('Node 不够，跳过 OpenSpec 生成', true);

H.done('大任务');
