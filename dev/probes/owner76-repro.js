'use strict';
/*
 * 问题表第 76 条的复现（2026-11-10）：做到一半改需求，阶段、下一步、拦截会怎样。
 * 只打印现在的行为，不判对错；结论写在 docs/feedback-20261110.md。套件拷进临时目录里的假用户目录跑，用完删。
 * 用法：node dev/probes/owner76-repro.js [别的版本的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness');

const h = H.makeHome('owner76', process.argv[2] || H.SRC, { commitMode: 'auto' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
const B = require(path.join(h.kit, 'lib', 'big-task.js'));

let seq = 0;
const TASK = '导出';
function project(changes, withPlan) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n', '.gitignore': '.vibe/\n' });
  const os_ = path.join(proj, 'openspec');
  if (withPlan) {
    H.write(path.join(os_, 'plan.md'), '# 计划\n\n## ' + TASK + '\n\n探索记录：explore/' + TASK + '.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join(''));
    H.write(path.join(os_, 'explore', TASK + '.md'), '# 探索\n\n## 定了的\n\n导出 xlsx\n\n## 还没定的\n\n无\n\n## 范围\n\n只做导出\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join('') + '## 落地偏差\n\n');
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
function session(proj) { const sid = 'q' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user('接着做')]) }; }
const edit = (j, file, a, b) => H.reasonOf(H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Edit', tool_input: { file_path: file, old_string: a, new_string: b }, hook_event_name: 'PreToolUse' })));
const create = (j, file, content) => H.reasonOf(H.hook(h, 'pre-edit', Object.assign({}, j, { tool_name: 'Write', tool_input: { file_path: file, content }, hook_event_name: 'PreToolUse' })));
const bash = (j, command) => H.reasonOf(H.hook(h, 'guard-commit', Object.assign({}, j, { tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PreToolUse' })));
const say = (j, prompt) => { H.transcript(j.transcript_path, [H.tr.user(prompt)]); return H.reasonOf(H.hook(h, 'task-anchor', Object.assign({}, j, { prompt, hook_event_name: 'UserPromptSubmit' }))); };
const one = (s) => String(s || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ').slice(0, 330) || '（放行）';
function show(label, j) {
  const st = S.flowState(j); const v = S.flowView(j); let b = null;
  try { b = B.bar(j); } catch (e) { b = { steps: '出错 ' + e.message, next: '' }; }
  // 状态栏第三行：statusline.js 第 104 行的算法
  let next = b ? b.next : '';
  if (v.waiting && !/^等你核验/.test(next)) next = '等你：' + v.waiting + (/范围变化/.test(v.waiting) ? '，说开工或 /vk-go' : '');
  console.log('  ' + label + '\n      流程 stage=' + st.stage + ' waiting=' + JSON.stringify(st.waiting || '') + ' 开工范围=' + (st.applyScope ? Object.keys(st.applyScope.dirs).map((d) => path.basename(d)).join(',') : '无') + ' 自动生效=' + v.effective
    + '\n      步骤条：' + (b ? b.steps : '（不显示）') + '\n      下一步：' + (next || '（空）'));
}
const out = (label, r) => console.log('  ' + label + ' → ' + one(r));

H.section('一、单个 change、人工模式、做到 1/3，用户说改需求');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 1, 2); const j = session(proj);
  S.setFlow(j, true, '测试', 'apply'); A.grant(j, '开工 c1', '', {});
  show('开工后', j);
  say(j, '导出要带日期，把需求改一下，然后接着做');
  show('用户说"导出要带日期，把需求改一下，然后接着做"之后', j);
  out('改 proposal.md', edit(j, path.join(d, 'proposal.md'), '要导出。', '要导出，带日期。'));
  H.write(path.join(d, 'proposal.md'), H.read(path.join(d, 'proposal.md')).replace('要导出。', '要导出，带日期。'));
  show('proposal 改完', j);
  out('同一轮新建一份规格 specs/date/spec.md', create(j, path.join(d, 'specs', 'date', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 带日期\n\nThe system SHALL add date.\n\n#### Scenario: 日期\n\n- **WHEN** 导出\n- **THEN** 文件名带日期\n'));
  out('同一轮改已有的 spec.md', edit(j, path.join(d, 'specs', 'order', 'spec.md'), '得到文件', '得到带日期的文件'));
  show('第二次改需求文档之后', j);
  out('往 tasks.md 加一项任务', edit(j, path.join(d, 'tasks.md'), '- [ ] 1.3 没做：src/A.java\n', '- [ ] 1.3 没做：src/A.java\n- [ ] 1.4 加日期：src/A.java\n'));
  out('接着改代码 src/A.java', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  out('勾 1.2', edit(j, path.join(d, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做'));
  say(j, '继续');
  out('用户说"继续"后改代码', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  say(j, '接着做');
  out('用户说"接着做"后改代码', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  show('用户说"接着做"之后', j);
  say(j, '开工');
  out('用户说"开工"后改代码', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  show('用户说"开工"之后', j);
}

H.section('二、c1 任务全勾完，会话转去写 c2 的需求（plan），用户报 c1 的问题要改代码');
{
  const proj = project(['c1', 'c2'], true); docs(proj, 'c1', 3, 0); const j = session(proj);
  S.setFlow(j, true, '测试', 'apply'); A.grant(j, '开工 c1', '', {});
  say(j, '/opsx:propose c2');
  show('敲 /opsx:propose c2 之后', j);
  say(j, 'c1 的导出文件名少了后缀，改一下');
  out('改 c1 的代码 src/A.java', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  show('这时', j);
}

H.section('三、不在 plan.md 表里的两个 change：c1 做到 1/3，中途新开 c2 写提案');
{
  const proj = project(['c1'], false); const d1 = docs(proj, 'c1', 1, 2); const j = session(proj);
  S.setFlow(j, true, '测试', 'apply'); A.grant(j, '开工 c1', '', {});
  show('c1 开工后', j);
  say(j, '另外加一个导入的需求，新开一个 change c2 写提案，c1 接着做');
  out('新建 c2/proposal.md', create(j, path.join(proj, 'openspec', 'changes', 'c2', 'proposal.md'), '# 导入\n\n## Why\n\n要导入。\n'));
  const d2 = docs(proj, 'c2', 0, 2);
  out('改 c2 已有的 proposal.md', edit(j, path.join(d2, 'proposal.md'), '要导出。', '要导入。'));
  show('动过 c2 的文档之后', j);
  out('回头改 c1 的代码', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  out('勾 c1 的 1.2', edit(j, path.join(d1, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做'));
}

H.section('四、大任务 c1 c2 c3：做 c3 时回头给 c1 补任务（人工模式）');
{
  const proj = project(['c1', 'c2', 'c3'], true); const d1 = docs(proj, 'c1', 3, 0); docs(proj, 'c2', 3, 0); const d3 = docs(proj, 'c3', 1, 2); const j = session(proj);
  S.setFlow(j, true, '测试', 'apply'); A.grant(j, '开工 c3', '', {});
  show('做 c3 时', j);
  say(j, 'c1 的导出要带日期，回去改一下');
  out('改 c1 的 proposal.md', edit(j, path.join(d1, 'proposal.md'), '要导出。', '要导出，带日期。'));
  H.write(path.join(d1, 'proposal.md'), H.read(path.join(d1, 'proposal.md')).replace('要导出。', '要导出，带日期。'));
  out('给 c1 的 tasks.md 补一项', edit(j, path.join(d1, 'tasks.md'), '- [x] 1.3 做完：src/A.java\n', '- [x] 1.3 做完：src/A.java\n- [ ] 1.4 加日期：src/A.java\n'));
  H.write(path.join(d1, 'tasks.md'), H.read(path.join(d1, 'tasks.md')) + '- [ ] 1.4 加日期：src/A.java\n');
  show('c1 补了任务之后', j);
  out('改代码', edit(j, path.join(proj, 'src', 'A.java'), 'class A {}', 'class A { }'));
  out('勾 c1 的 1.4', edit(j, path.join(d1, 'tasks.md'), '- [ ] 1.4 加日期', '- [x] 1.4 加日期'));
  out('勾 c3 的 1.2', edit(j, path.join(d3, 'tasks.md'), '- [ ] 1.2 没做', '- [x] 1.2 没做'));
}

H.section('五、提交方式"自动"：开工前就改过的代码');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 0, 2); const j = session(proj);
  H.git(proj, ['add', 'openspec']); H.git(proj, ['commit', '-q', '-m', 'docs: 提案']);
  // 进流程之前（或者写需求那一段放行过）Claude 直接改过 A.java，没提交
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int a; }\n');
  // 敲 /opsx:apply c1 会把 c1 记成这个会话在做的（flowTouch）
  S.setFlow(j, true, '测试', 'apply'); S.flowTouch(j, d); A.grant(j, '开工 c1', '', {});
  H.write(path.join(proj, 'src', 'B.java'), 'class B { int b; }\n');
  H.write(path.join(d, 'tasks.md'), H.read(path.join(d, 'tasks.md')).replace('- [ ] 1.1', '- [x] 1.1'));
  try { S.syncTicks(d, ['1.1 没做：src/A.java']); } catch (e) { /* 记不了照旧 */ }
  H.git(proj, ['add', 'src/A.java', 'src/B.java', 'openspec/changes/c1/tasks.md']);
  out('git commit（A.java 开工前改的，B.java 开工后改的）', bash(j, 'git commit -m "feat: 导出"'));
  H.git(proj, ['reset', '-q']); H.git(proj, ['add', 'src/B.java']);
  out('只提交开工后改的 B.java', bash(j, 'git commit -m "feat: 导出"'));
}

H.section('六、提交方式"自动"：任务没新勾，用户中途让直接改一处代码');
{
  const proj = project(['c1'], true); const d = docs(proj, 'c1', 1, 2); const j = session(proj);
  H.git(proj, ['add', '-A']); H.git(proj, ['commit', '-q', '-m', 'feat: 1.1']);
  S.setFlow(j, true, '测试', 'apply'); S.flowTouch(j, d); A.grant(j, '开工 c1', '', {});
  try { S.syncTicks(d); } catch (e) { /* 记不了照旧 */ }
  say(j, '按钮的文字改成"导出订单"');
  H.write(path.join(proj, 'src', 'B.java'), 'class B { String t = "导出订单"; }\n');
  H.git(proj, ['add', 'src/B.java']);
  out('git commit', bash(j, 'git commit -m "fix: 按钮文字"'));
}

H.done('第 76 条复现（只看输出）');
