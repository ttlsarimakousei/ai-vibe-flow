'use strict';
/*
 * 问题表第 19 条"动不动被拦、确认再确认"（2026-10-30，docs/feedback-20261030.md 的 A 批）：同一件事用户说过一次，就不再要他说第二遍。
 *   A4 提交、推送、归档认本轮最后一次明确表态：用户说了"改完提交并推送"，中间答了一个和提交无关的提问框，许可照旧有效（审核 R1）；
 *      答案里明说"先别提交"的，收回；用户下一次自己开口，从头算
 * 用法：node dev/test-confirm-once.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const stopped = (o) => blocked(o) || (!!o && !!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'ask');
const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');

H.section('A4 提交、推送：说过一次，中间答了别的提问框也照旧有效；明说"先别"的收回；下一次开口从头算');
{
  // 提交方式"关"：用户说了提交才提交（默认）
  const h = H.makeHome('tco-a4', FROM, { commitMode: 'off' });
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'src/A.java': 'class A {}\n' });
  const bare = path.join(h.root, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { windowsHide: true });
  H.git(proj, ['remote', 'add', 'origin', bare]);
  H.git(proj, ['push', '-q', '-u', 'origin', 'HEAD']);
  let n = 0;
  const edit = H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok');
  const run = (command, entries) => { n++; return H.hook(h, 'guard-commit', { session_id: 's-a4-' + n, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_a4_' + n, transcript_path: H.transcript(path.join(h.root, 'a4-' + n + '.jsonl'), entries) }); };
  H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
  const commit = 'git add src/A.java && git commit -m "fix: A 加字段"';
  const said = H.tr.user('A 加个字段，改完提交并推送');
  const r1 = run(commit, [said, edit, ...ask('要不要审查一下这处改动？', '审查'), H.tr.say('审过了，没问题')]);
  H.ok('说了"改完提交并推送"，中间答了"要不要审查"：提交照旧放行', !stopped(r1), r1);
  const r2 = run('git push', [said, edit, ...ask('要不要审查一下这处改动？', '审查'), H.tr.say('审过了，提交好了')]);
  H.ok('同样的情况：推送照旧放行', !stopped(r2), r2);
  const r3 = run(commit, [said, edit, ...ask('导出用哪种格式？', 'xlsx，先别提交'), H.tr.say('好')]);
  H.ok('后面的提问框里明说"先别提交"：提交拦下', stopped(r3), r3);
  const r4 = run('git push', [H.tr.user('推送'), H.tr.say('推好了'), H.tr.user('再看看状态')]);
  H.ok('上一轮说的推送，用户这一轮换了话题：推送拦下', stopped(r4), r4);
}

H.done('同一件事不再确认第二遍（问题表第 19 条）');
