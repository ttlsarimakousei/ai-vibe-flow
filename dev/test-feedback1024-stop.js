'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 3 类：收工检查
 *   #219 只 cat 过旧变更的文件，收工检查就把它当成当前变更
 *   #220 提问框选了"就这样定稿"，收工检查又问同一份
 * 用法：node dev/test-feedback1024-stop.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false };
const h = H.makeHome('feedback1024-stop', process.argv[2], QUIET);
const S = require(path.join(h.kit, 'lib/session'));
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
let seq = 0;
const tf = (es) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), es);
const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');
const DESIGN = '## Context\n\n- 读过 src/A.java\n\n## Decisions\n\n- 放在 A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 返回 200 | 人工 | 1 |\n';
const change = (name) => ({
  ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要做 ' + name + '。\n\n## What Changes\n\n- 改 src/A.java\n',
  ['openspec/changes/' + name + '/specs/x/spec.md']: '## ADDED Requirements\n\n### Requirement: 做\n\n系统 SHALL 做。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  ['openspec/changes/' + name + '/design.md']: DESIGN,
  ['openspec/changes/' + name + '/tasks.md']: '- [ ] 1.1 改 src/A.java：加功能\n',
});
const repo = (name) => H.makeRepo(path.join(h.work, name), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, change('feat-019'), change('opt-group')));
const tick = (p, sid, entries, name) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'openspec/changes/' + (name || 'feat-019') + '/tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: tf(entries) });
const prompt = (p, sid, text, entries) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: tf(entries) });

// ---------------------------------------------------------------------------------------------
H.section('#219 只读过的旧变更不算这个会话在做的');
{
  const p = H.makeRepo(path.join(h.work, 'readonly'), Object.assign({ 'package.json': '{}\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
    'openspec/changes/old-ref/proposal.md': '## Why\n\n老变更。\n\n## What Changes\n\n- 老的\n', 'openspec/changes/old-ref/tasks.md': '## 1. 老任务\n\n没有复选框。\n' }));
  const sid = 's-readonly';
  const u = H.tr.user('做一个智能物资分发的需求，新建变更 smart-dist');
  prompt(p, sid, u.message.content, [u]);
  const es = [u, ...H.tr.ran('Bash', { command: 'cat openspec/changes/old-ref/proposal.md openspec/changes/old-ref/tasks.md' }, '## Why ...'), ...H.tr.ran('Bash', { command: 'grep -n "Why" openspec/changes/old-ref/proposal.md' }, '1:## Why')];
  const chg = path.join(p, 'openspec/changes/smart-dist');
  const docs = change('smart-dist');
  for (const [rel, text] of Object.entries(docs)) { H.write(path.join(p, rel), text); es.push(...H.tr.ran('Write', { file_path: path.join(p, rel), content: text }, 'ok')); }
  const r = H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tf(es) });
  H.ok('收工：问的是新写的 smart-dist', /smart-dist 的 tasks 写完了/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('收工：只 cat、grep 过的 old-ref 不提', !/old-ref/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('流程记录里没有 old-ref', !S.flowChanges({ session_id: sid }).some((d) => /old-ref/.test(d)), S.flowChanges({ session_id: sid }));
  // 真的 openspec 命令里点了名的照样算
  const es2 = [H.tr.user('接着做 old-ref'), ...H.tr.ran('Bash', { command: 'openspec status --change old-ref' }, 'ok')];
  H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tf(es2) });
  H.ok('openspec status --change old-ref：算在做 old-ref', S.flowChanges({ session_id: sid }).some((d) => /old-ref/.test(d)));
  void chg;
}

// ---------------------------------------------------------------------------------------------
H.section('#220 选了"就这样定稿"不再问同一份');
{
  const p = H.makeRepo(path.join(h.work, 'settle'), { 'package.json': '{}\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const sid = 's-settle';
  const u = H.tr.user('写 smart-dist 的需求');
  prompt(p, sid, u.message.content, [u]);
  const es = [u];
  for (const [rel, text] of Object.entries(change('smart-dist'))) { H.write(path.join(p, rel), text); es.push(...H.tr.ran('Write', { file_path: path.join(p, rel), content: text }, 'ok')); }
  // 文件写在回答之前
  const old = (Date.now() - 2 * 3600000) / 1000; // 支架的会话记录从一小时前记起：文件要比回答更早
  for (const rel of Object.keys(change('smart-dist'))) fs.utimesSync(path.join(p, rel), old, old);
  const stop = (entries) => H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tf(entries) });
  const r1 = stop(es);
  H.ok('第一次收工：问 tasks 审不审', /smart-dist 的 tasks 写完了/.test(H.reasonOf(r1)), H.reasonOf(r1));
  // 用户在对话里回一句"就这样定稿"（新一轮），模型之后又动了一下设计
  const e2 = es.concat([H.tr.say('要审一下吗？'), H.tr.user('就这样定稿')]);
  H.write(path.join(p, 'openspec/changes/smart-dist/design.md'), DESIGN + '\n补一句。\n');
  fs.utimesSync(path.join(p, 'openspec/changes/smart-dist/design.md'), old, old);
  const r2 = stop(e2);
  H.ok('用户说了"就这样定稿"：收工不再问 tasks', !/smart-dist 的 tasks 写完了/.test(H.reasonOf(r2)), H.reasonOf(r2));
  // 提问框里选"就这样定稿"也一样
  const e3 = es.concat([...ask('tasks 写完了，审一下还是就这样定稿？', '就这样定稿')]);
  const r3 = stop(e3);
  H.ok('提问框选了"就这样定稿"：收工不再问 tasks', !/smart-dist 的 tasks 写完了/.test(H.reasonOf(r3)), H.reasonOf(r3));
}
{
  // "直接写下一份"只管上一份：之后新写的 specs 照样要问
  const p = H.makeRepo(path.join(h.work, 'next'), { 'package.json': '{}\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const sid = 's-next';
  const u = H.tr.user('写 next-x 的需求');
  prompt(p, sid, u.message.content, [u]);
  const docs = change('next-x');
  const prop = Object.keys(docs).find((k) => /proposal/.test(k)); const spec = Object.keys(docs).find((k) => /spec\.md/.test(k));
  H.write(path.join(p, prop), docs[prop]);
  const old = (Date.now() - 2 * 3600000) / 1000; fs.utimesSync(path.join(p, prop), old, old);
  const es = [u, ...H.tr.ran('Write', { file_path: path.join(p, prop), content: docs[prop] }, 'ok'), ...ask('proposal 写完了，审一下？', '直接写下一份')];
  H.write(path.join(p, spec), docs[spec]);
  es.push(...H.tr.ran('Write', { file_path: path.join(p, spec), content: docs[spec] }, 'ok'));
  const r = H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tf(es) });
  H.ok('选了"直接写下一份"之后新写的 specs：照样问', /next-x 的 specs 写完了/.test(H.reasonOf(r)), H.reasonOf(r));
}
H.done('1024 反馈：收工检查');
