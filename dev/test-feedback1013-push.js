'use strict';
/* #69、#79、#80、#81、#82：空远端、单笔推送、引用文本与包装开关。所有实际 push 只推临时裸仓库。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
const h = H.makeHome('feedback1013-push', process.argv[2]);
const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.txt': '1\n' }); const bare = path.join(h.root, 'empty.git'); H.run(h, 'git', ['init', '--bare', bare]);
const git = (a) => H.run(h, 'git', ['-C', p].concat(a)); git(['remote', 'add', 'origin', bare]); const branch = git(['branch', '--show-current']).out.trim();
const cli = path.join(h.kit, 'tools/merge-push.js'); const q = (s) => '"' + s.replace(/\\/g, '/') + '"'; let n = 0;
const tf = (es) => H.transcript(path.join(h.root, 't' + (++n) + '.jsonl'), es);
const guard = (command, entries) => H.hook(h, 'guard-commit', { cwd: p, session_id: 'push', transcript_path: tf(entries || [H.tr.user('推送')]), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'push-action', tool_input: { command } });
H.ok('空远端单笔普通推送可用真人许可', guard('git push -u origin ' + branch) === null);
H.ok('单笔也不能没有真人许可', guard('git push -u origin ' + branch, [H.tr.user('继续')]) !== null);
H.ok('单笔也不能强推', guard('git push --force origin ' + branch) !== null);
H.ok('其它目标分支不借单笔快捷入口', guard('git push origin HEAD:other') !== null);
const first = H.node(h, cli, ['plan', '--dir', p]); let preview; try { preview = JSON.parse(first.out); } catch (e) { preview = {}; }
H.ok('没有 upstream 的空远端可预览', first.code === 0 && preview.before === 1, first);
if (preview.plan) {
  const original = git(['rev-parse', 'HEAD']).out.trim();
  const voice = H.tr.user('推送');
  const after = H.hook(h, 'after-tool', { cwd: p, session_id: 'push', transcript_path: tf([voice]), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node ' + q(cli) + ' plan --dir ' + q(p) }, tool_response: { stdout: first.out, exit_code: 0 } });
  H.ok('首次预览登记回执', /已生成推送预览/.test(JSON.stringify(after)), after);
  const apply = 'node ' + q(cli) + ' apply --dir ' + q(p) + ' --plan ' + q(preview.plan) + ' --confirmed ' + preview.hash + ' --push 2>&1 | tail -5';
  H.ok('原推送消息位置变化不能充当第二次确认', guard(apply, [H.tr.say('之前的记录'), voice]) !== null);
  const S = require(path.join(h.kit, 'lib/session'));
  S.updateState('push-push-preview', (s) => { for (const r of Object.values(s.roots || {})) delete r.voiceSchema; });
  H.ok('升级旧预览要重新生成', guard(apply, [H.tr.user('确认推送')]) !== null);
  S.updateState('push-push-preview', (s) => { for (const r of Object.values(s.roots || {})) r.voiceSchema = 2; });
  H.ok('apply 完整只读管道不再误判命令', guard(apply, [H.tr.user('确认推送')]) === null, guard(apply, [H.tr.user('确认推送')]));
  const pushed = H.node(h, cli, ['apply', '--dir', p, '--plan', preview.plan, '--confirmed', preview.hash, '--push']);
  H.ok('首次应用成功推到临时空远端', pushed.code === 0 && JSON.parse(pushed.out).pushed, pushed);
  H.ok('首次推送保留原提交和设置 upstream', git(['rev-parse', 'HEAD']).out.trim() === original && git(['rev-parse', '@{u}']).out.trim() === original);
}
H.write(path.join(p, 'a.txt'), '2\n'); git(['add', 'a.txt']); git(['commit', '-m', 'fix: 修改一项']);
H.ok('已有远端单笔也可直接推送', guard('git push') === null);
const feedback = 'node ' + q(path.join(h.kit, 'tools/feedback.js')) + ' add --what "merge-push.js apply 无法核对"';
H.ok('记录问题的正文不触发执行检查', guard(feedback) === null, guard(feedback));
const node = 'cmd /C "' + process.execPath.replace(/\\/g, '/') + '" --version';
H.ok('cmd /C 不按凭据路径读文件', !/令牌|模型的 key/.test(H.reasonOf(guard(node))), H.reasonOf(guard(node)));
const mvnd = '"/d/maven/mvnd.cmd" -f "' + p.replace(/\\/g, '/') + '/pom.xml" -s "' + h.home.replace(/\\/g, '/') + '/.m2/settings.xml" compile';
H.ok('Maven settings 参数可用于编译', guard(mvnd) === null, guard(mvnd));
H.ok('真正读套件秘密仍拦截', /令牌|模型的 key/.test(H.reasonOf(guard('cat ' + q(path.join(h.kit, 'secrets.json'))))));
git(['checkout', '-b', 'new-feature']);
const newBranch = H.node(h, cli, ['plan', '--dir', p]);
H.ok('已有远端的新分支也可首次预览', newBranch.code === 0 && JSON.parse(newBranch.out).before >= 1, newBranch);
H.done('1013 首次推送与命令解析');
