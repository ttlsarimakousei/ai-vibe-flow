'use strict';
/*
 * 2026-11-10 这批（docs/feedback-20261110.md）：问题表第 76 条（做到一半改需求，阶段、下一步、拦截都乱）和议题 #435、#436、#438。
 *   - 人工模式做任务时用户让改需求：改完接着做，不用再说开工；收工之后模型自己改的照旧退回
 *   - 做任务时新建规格不被"一份一份来"拦；写别的 change 的文档不动现有的开工范围
 *   - 写需求那一段不改代码、不能申请放行；同一个大任务里前面的 change 开过工的放行，不相干的照旧拦
 *   - 状态栏：不显示内部值；需求改过有标记；要写的 change 还没建就显示它；另一个做到一半的带在后面；人工模式表外的 change 有步骤条
 *   - 提交方式"自动"：用户这一轮让改的小改动能提交；开工时没提交的算用户的，开工后提交过就不算；开工时提示先问要不要提交
 *   - #435 探索记录"（无。……）"算空；#436 流程走完后重新进流程不被旧名单判成走完；#438 已跟踪的 index-old.jsp 不算过程文件
 * 用法：node dev/test-feedback1110.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('feedback1110', FROM, { commitMode: 'auto' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
const B = require(path.join(h.kit, 'lib', 'big-task.js'));

let seq = 0;
const TASK = '导出';
function project(changes, withPlan, open) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n', '.gitignore': '.vibe/\n' });
  const os_ = path.join(proj, 'openspec');
  if (withPlan) {
    H.write(path.join(os_, 'plan.md'), '# 计划\n\n## ' + TASK + '\n\n探索记录：explore/' + TASK + '.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join(''));
    H.write(path.join(os_, 'explore', TASK + '.md'), '# 探索\n\n## 定了的\n\n导出 xlsx\n\n## 还没定的\n\n' + (open === undefined ? '无' : open) + '\n\n## 范围\n\n只做导出\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join('') + '## 落地偏差\n\n');
  }
  fs.mkdirSync(path.join(os_, 'changes'), { recursive: true });
  return proj;
}
function docs(proj, c, done, todo) {
  const d = path.join(proj, 'openspec', 'changes', c);
  H.write(path.join(d, 'proposal.md'), '# 导出\n\n## Why\n\n要导出。\n');
  H.write(path.join(d, 'design.md'), '# 设计\n\n- 放在 src/A.java\n\n## 验收用例\n\n- AC-01 导出：人工\n');
  H.write(path.join(d, 'tasks.md'), '## 1. x\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 做完：src/A.java\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 没做：src/A.java\n').join(''));
  H.write(path.join(d, 'specs', 'order', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 导出订单\n\nThe system SHALL export orders.\n\n#### Scenario: 导出\n\n- **WHEN** 点导出\n- **THEN** 得到文件\n');
  return d;
}
function session(proj) { const sid = 'k' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user('接着做')]) }; }
const hookOut = (name, j, tool, input) => H.hook(h, name, Object.assign({}, j, { tool_name: tool, tool_input: input, hook_event_name: 'PreToolUse' }));
const edit = (j, file, a, b) => H.reasonOf(hookOut('pre-edit', j, 'Edit', { file_path: file, old_string: a, new_string: b }));
const create = (j, file, content) => H.reasonOf(hookOut('pre-edit', j, 'Write', { file_path: file, content }));
const bash = (j, command) => H.reasonOf(hookOut('guard-commit', j, 'Bash', { command }));
const after = (j, file) => H.hook(h, 'after-tool', Object.assign({}, j, { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_response: { filePath: file }, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_' + (++seq) }));
const say = (j, prompt) => { H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.hook(h, 'task-anchor', Object.assign({}, j, { prompt, hook_event_name: 'UserPromptSubmit' })); };
// 现在这一刻说的话（支架的时钟在一小时前，和 git 提交时间比先后时要用真的时间）
const sayNow = (j, prompt) => H.transcript(j.transcript_path, [{ type: 'user', uuid: 'now-' + (++seq), timestamp: new Date(Date.now() + 1500).toISOString(), message: { role: 'user', content: prompt } }]);
// 用户现在说了一句，之后模型用 Edit 改了这几个文件
const sayThenEdit = (j, prompt, files) => H.transcript(j.transcript_path, [{ type: 'user', uuid: 'now-' + (++seq), timestamp: new Date(Date.now() + 1500).toISOString(), message: { role: 'user', content: prompt } }].concat(files.flatMap((x) => H.tr.ran('Edit', { file_path: x, old_string: 'a', new_string: 'b' }))));
const fl = (j) => S.flowState(j);
const bar = (j) => { const b = B.bar(j) || { steps: '', next: '' }; return b; };
const replaceIn = (f, a, b) => H.write(f, H.read(f).replace(a, b));
const apply = (j, name, dir) => { S.setFlow(j, true, '测试', 'apply'); if (dir) S.flowTouch(j, dir); return A.grant(j, '开工 ' + name, '', {}); };

H.section('人工模式做任务时用户让改需求：改完接着做');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 1, 2); const j = session(proj);
  apply(j, 'c1');
  say(j, '导出要带日期，把需求改一下，然后接着做');
  H.ok('这句话之后还在做任务', fl(j).stage === 'apply' && !!fl(j).applyScope, fl(j));
  let r = edit(j, path.join(d, 'proposal.md'), '要导出。', '要导出，带日期。');
  H.ok('改 proposal.md 放行', !r, r);
  replaceIn(path.join(d, 'proposal.md'), '要导出。', '要导出，带日期。');
  after(j, path.join(d, 'proposal.md'));
  H.ok('落盘之后马上重定范围：还在做任务、不在等用户', fl(j).stage === 'apply' && !!fl(j).applyScope && !S.flowView(j).waiting, [fl(j).stage, S.flowView(j).waiting]);
  H.ok('没有会话记录的调用（状态栏）看到的也是有效的范围', S.flowView({ session_id: j.session_id, cwd: proj }).waiting === '', S.flowView({ session_id: j.session_id, cwd: proj }));
  r = create(j, path.join(d, 'specs', 'date', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 带日期\n\nThe system SHALL add date.\n\n#### Scenario: 日期\n\n- **WHEN** 导出\n- **THEN** 文件名带日期\n');
  H.ok('同一轮新建一份规格：不被"一份一份来"拦', !r, r);
  r = edit(j, path.join(d, 'specs', 'order', 'spec.md'), '得到文件', '得到带日期的文件');
  H.ok('再改一份规格放行', !r, r);
  H.ok('第二次改需求文档之后还在做任务', fl(j).stage === 'apply' && !!fl(j).applyScope, fl(j));
  r = edit(j, path.join(d, 'tasks.md'), '- [ ] 1.3 没做：src/A.java\n', '- [ ] 1.3 没做：src/A.java\n- [ ] 1.4 加日期：src/A.java\n');
  H.ok('补一项任务放行', !r, r);
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('接着改代码放行', !r, r);
  r = edit(j, path.join(d, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做');
  H.ok('接着打勾放行', !r, r);
  H.ok('步骤条标出需求改过', /c1（需求改过）/.test(bar(j).steps), bar(j));
}

H.section('收工之后模型自己改需求：照旧退回，状态栏不显示内部值');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 1, 2); const j = session(proj);
  apply(j, 'c1');
  S.writeState(j.session_id + '-last-stop', { at: Date.now() });
  replaceIn(path.join(d, 'proposal.md'), '要导出。', '要导出，带日期。');
  let r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('需求改了、不是用户开口的那一轮：改代码拦下', /需求本身/.test(r), r);
  r = edit(j, path.join(d, 'specs', 'order', 'spec.md'), '得到文件', '得到带日期的文件');
  H.ok('改文档放行', !r, r);
  H.ok('退回写需求、等用户说开工', fl(j).stage === 'plan' && fl(j).waiting === 'scope' && !fl(j).applyScope, fl(j));
  const w = S.flowView(j).waiting;
  H.ok('给人看的话里没有 scope', !!w && !/scope/.test(w) && /开工/.test(w), w);
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('改代码拦下，说要用户重新说开工', /重新说开工/.test(r), r);
  say(j, '开工');
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('用户说开工之后放行', !r, r);
}

H.section('复审 P1-1：收工之后模型自己改的需求，用户随口说一句不算认下');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 1, 2); const j = session(proj);
  apply(j, 'c1');
  S.writeState(j.session_id + '-last-stop', { at: Date.now() });
  replaceIn(path.join(d, 'proposal.md'), '要导出。', '要导出，带日期。');
  after(j, path.join(d, 'proposal.md'));
  H.ok('工具做完当场退回写需求（不等下一次改文档）', fl(j).stage === 'plan' && fl(j).waiting === 'scope' && !fl(j).applyScope, fl(j));
  // 没经过 after-tool 的（状态还是做任务、范围失效）：用户之后说一句不相干的话，文档是在这句话之前改的，不重定
  const proj2 = project(['c1'], true); const d2 = docs(proj2, 'c1', 1, 2); const j2 = session(proj2);
  apply(j2, 'c1');
  S.writeState(j2.session_id + '-last-stop', { at: Date.now() - 5000 });
  replaceIn(path.join(d2, 'proposal.md'), '要导出。', '要导出，带日期。');
  const old = new Date(Date.now() - 4000); fs.utimesSync(path.join(d2, 'proposal.md'), old, old);
  sayNow(j2, '做到哪了，说一下进度');
  const v = A.valid(j2);
  H.ok('用户开口之前改的需求：不重定范围', !v.ok && /需求本身/.test(v.reason || ''), v);
  const r = edit(j2, path.join(proj2, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('改代码照旧拦', /需求本身/.test(r), r);
}

H.section('复审 P2-3、P2-5：范围外的 change 打勾、大任务里后面的 change 第一次写需求');
{
  // 新建一份带勾的 tasks.md、顺手改了任务文字：都是打勾，范围外的拦
  let proj = project(['c1'], false); let d1 = docs(proj, 'c1', 1, 2); let d2 = docs(proj, 'c2', 0, 2); let j = session(proj);
  apply(j, 'c1');
  let r = edit(j, path.join(d2, 'tasks.md'), '- [ ] 1.1 没做：src/A.java', '- [x] 1.1 做完了：src/A.java');
  H.ok('范围外的 change：打勾时顺手改了任务文字也拦', /不在当前 apply 许可里/.test(r), r);
  fs.unlinkSync(path.join(d2, 'tasks.md'));
  r = create(j, path.join(d2, 'tasks.md'), '## 1. x\n\n- [x] 1.1 做完：src/A.java\n- [ ] 1.2 没做：src/A.java\n');
  H.ok('范围外的 change：新建带勾的 tasks.md 也拦', /不在当前 apply 许可里|还没说开工|还不能/.test(r), r);
  // 大任务：c1 在做，c2 还没建。收工之后（不是用户开口的那一轮）模型接着写 c2 的 proposal：不算"需求改了"，c1 不受影响
  proj = project(['c1', 'c2'], true); d1 = docs(proj, 'c1', 1, 2); j = session(proj);
  apply(j, 'c1');
  S.writeState(j.session_id + '-last-stop', { at: Date.now() });
  d2 = path.join(proj, 'openspec', 'changes', 'c2');
  H.write(path.join(d2, '.openspec.yaml'), 'schema: spec-driven\n');
  r = edit(j, path.join(d2, '.openspec.yaml'), 'spec-driven', 'spec-driven ');
  H.write(path.join(d2, 'proposal.md'), '# 导入\n\n## Why\n\n要导入。\n');
  after(j, path.join(d2, 'proposal.md'));
  r = edit(j, path.join(d2, 'proposal.md'), '要导入。', '要导入 xlsx。');
  H.ok('后面的 change 第一次写需求：c1 的开工范围还在、没退回', fl(j).stage === 'apply' && !!fl(j).applyScope && !r, [fl(j).stage, r]);
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('c1 的代码照常能改', !r, r);
  H.ok('c2 不标"需求改过"', !(fl(j).reqEdited || {})[S.normKey(d2)], fl(j).reqEdited);
}

H.section('写别的 change 的文档不动现有的开工范围');
{
  const proj = project(['c1'], false); const d1 = docs(proj, 'c1', 1, 2); const d2 = docs(proj, 'c2', 0, 2); const j = session(proj);
  apply(j, 'c1');
  H.ok('人工模式、表外的 change：步骤条不是空的', /c1 提案✓/.test(bar(j).steps), bar(j));
  let r = edit(j, path.join(d2, 'proposal.md'), '要导出。', '要导入。');
  H.ok('改 c2 的 proposal.md 放行', !r, r);
  H.ok('c1 的开工范围还在、还在做任务', fl(j).stage === 'apply' && Object.keys((fl(j).applyScope || {}).dirs || {}).some((k) => /\/c1$/.test(k)), fl(j));
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('回头改 c1 的代码放行', !r, r);
  r = edit(j, path.join(d1, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做');
  H.ok('勾 c1 的任务放行', !r, r);
  r = edit(j, path.join(d2, 'tasks.md'), '- [ ] 1.1 没做', '- [x] 1.1 没做');
  H.ok('c2 没开工：勾 c2 的任务拦下', /不在当前 apply 许可里/.test(r), r);
}

H.section('写需求那一段不改代码');
{
  // 同一个大任务：c1 开过工，转去写 c2 的需求
  let proj = project(['c1', 'c2'], true); let d1 = docs(proj, 'c1', 3, 0); let j = session(proj);
  apply(j, 'c1');
  say(j, '/opsx:propose c2');
  H.ok('敲 /opsx:propose c2 之后在写需求', fl(j).stage === 'plan', fl(j));
  H.ok('步骤条显示要写的 c2，不是上一个', /c2 提案●/.test(bar(j).steps) && /写 c2 的需求/.test(bar(j).next), bar(j));
  say(j, 'c1 的导出文件名少了后缀，改一下');
  let r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('同一个大任务里 c1 开过工：改代码放行', !r, r);
  H.write(path.join(d1, 'tasks.md'), H.read(path.join(d1, 'tasks.md')) + '- [ ] 1.4 补后缀：src/A.java\n');
  r = edit(j, path.join(d1, 'tasks.md'), '- [ ] 1.4 补后缀', '- [x] 1.4 补后缀');
  H.ok('同一个大任务里 c1 开过工：勾它补的任务放行', !/还没说开工/.test(r), r);
  // 一个开工的都没有
  proj = project(['c1'], true); docs(proj, 'c1', 0, 2); j = session(proj);
  S.setFlow(j, true, '测试', 'plan');
  const out = hookOut('pre-edit', j, 'Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { }' });
  H.ok('没开工：改代码拦下', /不改代码/.test(H.reasonOf(out)), H.reasonOf(out));
  H.ok('不给拦截编号，不能申请放行', !/拦截编号/.test(H.reasonOf(out)) && /不能申请放行/.test(H.reasonOf(out)), H.reasonOf(out));
  // 不相干的两个 change（不在一个大任务里）：c1 开过工，转去写 c2
  proj = project(['c1'], false); docs(proj, 'c1', 3, 0); j = session(proj);
  apply(j, 'c1');
  say(j, '/opsx:propose c2');
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('不相干的 change：写需求时改代码照旧拦', /不改代码/.test(r), r);
}

H.section('大任务里做 c3 时回头改 c1（人工模式）');
{
  const proj = project(['c1', 'c2', 'c3'], true); const d1 = docs(proj, 'c1', 3, 0); docs(proj, 'c2', 3, 0); const d3 = docs(proj, 'c3', 1, 2); const j = session(proj);
  apply(j, 'c3');
  say(j, 'c1 的导出要带日期，回去改一下');
  let r = edit(j, path.join(d1, 'proposal.md'), '要导出。', '要导出，带日期。');
  replaceIn(path.join(d1, 'proposal.md'), '要导出。', '要导出，带日期。');
  after(j, path.join(d1, 'proposal.md'));
  r = edit(j, path.join(d1, 'tasks.md'), '- [x] 1.3 做完：src/A.java\n', '- [x] 1.3 做完：src/A.java\n- [ ] 1.4 加日期：src/A.java\n');
  H.ok('给 c1 补任务放行', !r, r);
  H.write(path.join(d1, 'tasks.md'), H.read(path.join(d1, 'tasks.md')) + '- [ ] 1.4 加日期：src/A.java\n');
  H.ok('开工范围还是整个大任务、还在做任务', fl(j).stage === 'apply' && Object.keys((fl(j).applyScope || {}).dirs || {}).length === 3, fl(j));
  r = edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }');
  H.ok('改代码放行', !r, r);
  const b = bar(j);
  H.ok('步骤条回到 c1，下一步带上 c3 做到哪', /c1（需求改过）/.test(b.steps) && /另有 c3 做到 1\/3/.test(b.next), b);
  r = edit(j, path.join(d1, 'tasks.md'), '- [ ] 1.4 加日期', '- [x] 1.4 加日期');
  H.ok('勾 c1 补的任务放行', !r, r);
  r = edit(j, path.join(d3, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做');
  H.ok('c1 没做完：勾 c3 按表的顺序拦（11-03 定的，没变）', /表的顺序/.test(r), r);
}

H.section('提交方式"自动"');
{
  // 用户这一轮让改的小改动：没对应任务也能提交
  let proj = project(['c1'], true); let d = docs(proj, 'c1', 1, 2); let j = session(proj);
  H.git(proj, ['add', '-A']); H.git(proj, ['commit', '-q', '-m', 'feat: 1.1']);
  apply(j, 'c1', d);
  try { S.syncTicks(d); } catch (e) { /* 记不了照旧 */ }
  H.write(path.join(proj, 'src', 'B.java'), 'class B { String t = "导出订单"; }\n');
  H.git(proj, ['add', 'src/B.java']);
  let r = bash(j, 'git commit -m "fix: 按钮文字"');
  H.ok('用户说的是"接着做"、没新勾任务：不提交', /还没做完一件事/.test(r), r);
  // 复审 P1-2：要提交的文件得是这句话之后才改的，这句话得像是让改东西
  H.transcript(j.transcript_path, H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'B.java'), old_string: 'a', new_string: 'b' }).concat([{ type: 'user', uuid: 'now-' + (++seq), timestamp: new Date(Date.now() + 1500).toISOString(), message: { role: 'user', content: '按钮的文字改成"导出订单"' } }]));
  r = bash(j, 'git commit -m "fix: 按钮文字"');
  H.ok('文件是这句话之前改的（做到一半的）：不提交', /还没做完一件事/.test(r), r);
  sayThenEdit(j, '好的，你继续', [path.join(proj, 'src', 'B.java')]);
  r = bash(j, 'git commit -m "fix: 按钮文字"');
  H.ok('用户说的是"好的，你继续"：不算让改一处', /还没做完一件事/.test(r), r);
  sayThenEdit(j, '按钮的文字改成"导出订单"', [path.join(proj, 'src', 'B.java')]);
  r = bash(j, 'git commit -m "fix: 按钮文字"');
  H.ok('用户这一轮让改的、这句话之后改的：能提交', !r, r);
  sayNow(j, '这个按钮现在叫什么？');
  r = bash(j, 'git commit -m "fix: 按钮文字"');
  H.ok('用户这一轮是问句：不算', /还没做完一件事/.test(r), r);
  // 开工时没提交的算用户的；开工之后提交过就不算
  proj = project(['c1'], true); d = docs(proj, 'c1', 0, 2); j = session(proj);
  H.git(proj, ['add', 'openspec']); H.git(proj, ['commit', '-q', '-m', 'docs: 提案']);
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int a; }\n');
  S.setFlow(j, true, '测试', 'plan'); S.flowTouch(j, d);
  const start = say(j, '开工 c1');
  const told = JSON.stringify(start || '');
  H.ok('开工时提示有没提交的改动、让先问要不要提交', /src\/A\.java/.test(told) && /先提交/.test(told), told.slice(0, 600));
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int a; int b; }\n');
  H.git(proj, ['add', 'src/A.java']);
  sayThenEdit(j, '把 b 字段加上', [path.join(proj, 'src', 'A.java')]);
  r = bash(j, 'git commit -m "feat: 导出"');
  H.ok('开工时没提交的文件：不自动提交', /开工前已有用户改动/.test(r) && /src\/A\.java/.test(r), r);
  H.git(proj, ['commit', '-q', '-m', 'feat: 用户先提交的']);
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int a; int b; int c; }\n');
  H.git(proj, ['add', 'src/A.java']);
  sayThenEdit(j, '再加一个 c 字段', [path.join(proj, 'src', 'A.java')]);
  r = bash(j, 'git commit -m "feat: 导出"');
  H.ok('开工之后提交过的：不再算用户的改动', !/开工前已有用户改动/.test(r), r);
  // 重新开工不再提示
  const again = JSON.stringify(say(j, '开工 c1') || '');
  H.ok('重新说开工：不再提示先提交', !/先提交/.test(again), again.slice(0, 400));
}

H.section('#435 探索记录"还没定的"');
{
  const open = (text) => { const proj = project(['c1'], true, text); return B.exploreIssues(B.tasks(proj)[0]).filter((x) => /还没定的/.test(x)); };
  H.ok('（无。12/13 已明确本次不做，不算阻塞项。）算空', open('（无。12/13 已明确本次不做，不算阻塞项。）').length === 0, open('（无。12/13 已明确本次不做，不算阻塞项。）'));
  H.ok('无，都确认过了 算空', open('无，都确认过了').length === 0);
  H.ok('（无）照旧算空', open('（无）').length === 0);
  H.ok('无法确定分页 不算空', open('无法确定分页').length === 1);
  H.ok('无。\\n- 分页大小要问 不算空', open('无。\n- 分页大小要问').length === 1);
  H.ok('- 导出格式 不算空', open('- 导出格式').length === 1);
  H.ok('没有，但分页方式还要问用户 不算空（复审 P3-11）', open('没有，但分页方式还要问用户').length === 1);
  H.ok('无，导出格式待定 不算空', open('无，导出格式待定').length === 1);
}

H.section('#436 流程走完后重新进流程');
{
  const proj = project(['old1'], false); const d = docs(proj, 'old1', 2, 0); const j = session(proj);
  S.setFlow(j, true, '测试', 'apply'); S.flowTouch(j, d);
  fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true });
  fs.renameSync(d, path.join(proj, 'openspec', 'changes', 'archive', '2026-11-09-old1'));
  H.ok('动过的变更归档了：流程走完', S.flowDone(j) === true);
  S.setFlow(j, false, '变更归档了');
  say(j, '/opsx:propose 渗透测试漏洞整改');
  H.ok('敲 /opsx:propose 进流程', fl(j).on === true, fl(j));
  say(j, '使用一个change进行修改');
  H.ok('下一句话还在流程里（新变更的目录还没建）', fl(j).on === true && S.flowDone(j) === false, fl(j));
  const r = bash(j, 'openspec new change fix-pentest-findings');
  H.ok('建变更不被拦"用户没说要走 OpenSpec"', !/没说要走 OpenSpec/.test(r), r);
}

H.section('#438 已经跟踪着的文件不算过程文件');
{
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'web/index.jsp': '<a/>\n', 'web/index-old.jsp': '<b/>\n', '.gitignore': '.vibe/\n' });
  const j = session(proj);
  H.write(path.join(proj, 'web', 'index-old.jsp'), '<b>改了</b>\n');
  let r = bash(j, 'git add web/index.jsp web/index-old.jsp');
  H.ok('改了 git 里原来就有的 index-old.jsp 再 add：不拦', !/过程文件/.test(r), r);
  H.write(path.join(proj, 'web', 'login-old.jsp'), '<c/>\n'); H.write(path.join(proj, 'web', 'login.jsp'), '<c/>\n');
  r = bash(j, 'git add web/login-old.jsp');
  H.ok('新建的 login-old.jsp（旁边有 login.jsp）：照旧拦', /过程文件/.test(r), r);
}

H.section('#430、#434、#442 用户在话里点了目录（20261109 已修，这里留一条）');
{
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'docs/2026年11月9日漏洞扫描/扫描报告.pdf': 'x', '.gitignore': '.vibe/\n' });
  const j = session(proj);
  H.transcript(j.transcript_path, [H.tr.user('@docs/2026年11月9日漏洞扫描/ 把扫描结果总结成md文档落到这个文件夹中')]);
  let r = create(j, path.join(proj, 'docs', '2026年11月9日漏洞扫描', '漏洞汇总.md'), '# 汇总\n');
  H.ok('用户点了目录：新建汇总不问放哪', !/产出位置/.test(r), r);
  r = create(j, path.join(proj, 'docs', '2026年11月9日漏洞扫描', '整改方案.md'), '# 整改\n');
  H.ok('同一个目录里拆出来的第二份也不问', !/产出位置/.test(r), r);
  r = create(j, path.join(proj, 'docs', '别的目录', '说明.md'), '# 说明\n');
  H.ok('没点过的目录照旧问', /产出位置/.test(r), r);
}

H.done('2026-11-10 这批：第 76 条和 #435、#436、#438');
