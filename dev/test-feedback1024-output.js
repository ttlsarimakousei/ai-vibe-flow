'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 8 类：产出位置记好了还被拦，提示误导（#218，旧 #196）
 *   模型往 .vibe/project.md 加了"## Output locations"（英文标题）还是被拦：会话里自己加的不算（有意的），英文标题以后也不认（毛病）
 *   提示只说"产出位置里没有"，模型照提示记进项目说明以后还拦、提示不变，模型就反复改写法
 * 用法：node dev/test-feedback1024-output.js [旧版的 vibe-kit 目录]
 */
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('feedback1024-output', process.argv[2], {});
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
let seq = 0;
const tf = (es) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), es);
const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');
const write = (p, sid, rel, entries) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(p, rel), content: '差异清单\n' }, transcript_path: tf(entries || [H.tr.user('整理一份差异清单')]) });

H.section('英文标题的"产出位置"一节也认');
{
  const p = H.makeRepo(path.join(h.work, 'en'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n', '.vibe/project.md': '# 项目说明\n\n## Output locations\n\n- docs, reports and diff lists: docs/business-handbook/\n' });
  const r = write(p, 's-en', 'docs/business-handbook/运行规则-差异清单.md');
  H.ok('会话开始前就记着的 "## Output locations"：写到 docs/business-handbook/ 放行', !blocked(r), H.reasonOf(r));
}

H.section('会话里自己加的不算：提示直说，要用提问框问用户、选项写实际目录');
{
  const p = H.makeRepo(path.join(h.work, 'self'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n', '.vibe/project.md': '# 项目说明\n' });
  const sid = 's-self';
  // 模型先改项目说明（钩子在改之前记下原来的内容），自己加了产出位置
  H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, '.vibe/project.md'), old_string: '# 项目说明\n', new_string: '# 项目说明\n\n## 产出位置\n\n- 文档：docs/business-handbook/\n' }, transcript_path: tf([H.tr.user('整理一份差异清单')]) });
  H.write(path.join(p, '.vibe/project.md'), '# 项目说明\n\n## 产出位置\n\n- 文档：docs/business-handbook/\n');
  const r = write(p, sid, 'docs/business-handbook/差异清单.md');
  H.ok('自己加的照样拦', blocked(r), H.reasonOf(r));
  H.ok('提示说清：这个会话里自己加的不算，用提问框问用户', /这个会话里.{0,8}自己加的.{0,10}不算/.test(H.reasonOf(r)) && /提问框/.test(H.reasonOf(r)), H.reasonOf(r));
  const ok = write(p, sid, 'docs/business-handbook/差异清单.md', [H.tr.user('整理一份差异清单'), ...ask('差异清单放哪？', 'docs/business-handbook/')]);
  H.ok('用户在提问框里选了 docs/business-handbook/：放行', !blocked(ok), H.reasonOf(ok));
}

H.section('提问框的选项写"子项目根目录"这种说法：拦下，要求写目录');
{
  const shell = path.join(h.work, 'shell'); H.write(path.join(shell, 'CLAUDE.md'), '# 壳子\n');
  const sub = H.makeRepo(path.join(shell, 'jssslt-oa'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
  const r = H.hook(h, 'pre-edit', { session_id: 's-sub', cwd: shell, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(sub, '1.txt'), content: '返回示例\n' }, transcript_path: tf([H.tr.user('把接口返回存一份'), ...ask('返回示例放哪？', '子项目根目录')]) });
  H.ok('答"子项目根目录"：拦下', blocked(r), H.reasonOf(r));
  H.ok('提示要求选项写实际目录（例：jssslt-oa/），不写"子项目根目录"这种说法', /jssslt-oa\//.test(H.reasonOf(r)) && /根目录/.test(H.reasonOf(r)), H.reasonOf(r));
  const ok = H.hook(h, 'pre-edit', { session_id: 's-sub2', cwd: shell, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(sub, '1.txt'), content: '返回示例\n' }, transcript_path: tf([H.tr.user('把接口返回存一份'), ...ask('返回示例放哪？', 'jssslt-oa/')]) });
  H.ok('答"jssslt-oa/"：放行', !blocked(ok), H.reasonOf(ok));
}
H.done('1024 反馈：产出位置');
