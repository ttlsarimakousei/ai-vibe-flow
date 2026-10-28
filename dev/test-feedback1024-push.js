'use strict';
/*
 * 问题反馈表第 5 条（仓库主人 2026-10-22 提的）：说"推送"就直接推。
 *   推送、push            直接 git push，几笔提交都一样，不出推送计划、不再问确认；壳子里几个子项目各推一次
 *   合并推送、合并成1条推送  2026-10-28 起合并推送取消（问题反馈表第 9 条、#233）：也算说了推送，照普通推送直接推，不出计划、不合成
 * 只推到临时目录里的裸仓库。用法：node dev/test-feedback1024-push.js [旧版的 vibe-kit 目录]
 */
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('feedback1024-push', process.argv[2], { commitMode: 'off' });
const blocked = (v) => !!v && (v.decision === 'block' || (!!v.hookSpecificOutput && v.hookSpecificOutput.permissionDecision === 'deny'));
const asks = (v) => !!v && !!v.hookSpecificOutput && v.hookSpecificOutput.permissionDecision === 'ask';
let seq = 0;
const tf = (es) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), es);
function repo(name, commits) {
  const dir = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n', 'a.txt': '0\n' });
  const bare = path.join(h.root, name + '.git');
  H.run(h, 'git', ['init', '--bare', bare]);
  H.run(h, 'git', ['-C', dir, 'remote', 'add', 'origin', bare]); H.run(h, 'git', ['-C', dir, 'push', '-u', 'origin', 'HEAD']);
  for (let i = 1; i <= commits; i++) { H.write(path.join(dir, 'a.txt'), i + '\n'); H.run(h, 'git', ['-C', dir, 'add', 'a.txt']); H.run(h, 'git', ['-C', dir, 'commit', '-m', 'fix: 第 ' + i + ' 处']); }
  return { dir, bare };
}
const guard = (cwd, command, said, sid) => H.hook(h, 'guard-commit', { session_id: sid || 'push-' + (++seq), cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'push-' + seq, tool_input: { command }, transcript_path: tf([H.tr.user(said)]) });
const prompt = (cwd, text) => H.hook(h, 'task-anchor', { session_id: 'p-' + (++seq), cwd, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: tf([H.tr.user(text)]) });
const tool = path.join(h.kit, 'tools/merge-push.js').replace(/\\/g, '/');

H.section('"推送"：三笔没推的提交也直接推，不出推送计划');
const r3 = repo('three', 3);
const plain = guard(r3.dir, 'git push', '推送');
H.ok('说了推送：git push 放行（不拦、不弹确认）', plain === null, plain);
H.ok('说了 push：git -C <仓库> push origin <分支> 放行', guard(r3.dir, 'git -C "' + r3.dir.replace(/\\/g, '/') + '" push origin HEAD', 'push') === null);
const hint = prompt(r3.dir, '推送');
H.ok('开口提示：直接 git push，不用推送计划', /直接 git -C <仓库> push/.test(H.reasonOf(hint) || JSON.stringify(hint || {})) && !/merge-push\.js" plan/.test(JSON.stringify(hint || {})), hint);
H.ok('没说推送：git push 拦下', blocked(guard(r3.dir, 'git push', '继续')));
H.ok('说了推送但要强推：弹确认，不直接放', asks(guard(r3.dir, 'git push --force', '推送')), guard(r3.dir, 'git push --force', '推送'));
H.ok('说了推送但推到别的分支：弹确认', asks(guard(r3.dir, 'git push origin HEAD:other', '推送')));

H.section('壳子里两个子项目：一句"推送"各推一次');
const shell = path.join(h.work, 'shell'); H.write(path.join(shell, 'CLAUDE.md'), '# 壳子\n');
const sa = repo('shell/gwjh', 2); const sb = repo('shell/gwjhmq', 2);
const both = guard(shell, 'git -C "' + sa.dir.replace(/\\/g, '/') + '" push && git -C "' + sb.dir.replace(/\\/g, '/') + '" push', '推送');
H.ok('一条命令推两个子项目：放行', both === null, both);

H.section('"合并推送""合并成1条推送"（1028 起合并推送取消）：照普通推送直接推');
const rp = repo('plan', 2);
H.ok('说了合并推送：git push 直接放行（不再要求先出计划）', guard(rp.dir, 'git push', '合并推送') === null, guard(rp.dir, 'git push', '合并推送'));
H.ok('说了合并成1条推送：git push 直接放行（不合成）', guard(rp.dir, 'git push', '合并成1条推送') === null, guard(rp.dir, 'git push', '合并成1条推送'));
const ph = JSON.stringify(prompt(rp.dir, '合并推送') || {});
// 用户 2026-10-28 补充：去掉的是套件的合并推送工具；用户自己说合并推送时照他说的用 git 合并再推，不拦
H.ok('开口提示：照用户说的用 git 自己合并没推的提交再推，不提套件的合并工具', /用户要把没推的提交合并了再推/.test(ph) && /reset --soft/.test(ph) && !/merge-push|plan --dir|squash --dir/.test(ph), ph);
H.ok('只说推送的开口提示：直接推，不提合并', /直接 git -C <仓库> push/.test(JSON.stringify(prompt(rp.dir, '推送') || {})) && !/合并/.test(JSON.stringify(prompt(rp.dir, '推送') || {})));
H.ok('合并推送的工具不在了', !require('fs').existsSync(tool));
// 提交方式"关"（这个假目录的设置）：用户说了合并成1条推送，合并时的 reset --soft 和重新提交都不拦
H.ok('说了合并成1条推送：git reset --soft 到远端分支不拦', guard(rp.dir, 'git reset --soft origin/HEAD', '合并成1条推送') === null, guard(rp.dir, 'git reset --soft origin/HEAD', '合并成1条推送'));
H.ok('说了合并成1条推送：合并后的重新提交不拦（不要求再说"提交"）', guard(rp.dir, 'git commit -m "fix: 合并两处修改"', '合并成1条推送') === null, guard(rp.dir, 'git commit -m "fix: 合并两处修改"', '合并成1条推送'));
H.ok('只说了推送：提交方式"关"时 git commit 照旧不提交', blocked(guard(rp.dir, 'git commit -m "fix: 合并两处修改"', '推送')), guard(rp.dir, 'git commit -m "fix: 合并两处修改"', '推送'));

H.section('#233 看过合并计划后改主意直推：不再有预览挡着');
const r19 = repo('front', 19);
H.ok('19 笔没推的提交，说"推送"：直接放行', guard(r19.dir, 'git push origin HEAD', '不合并了，直接推送') === null, guard(r19.dir, 'git push origin HEAD', '不合并了，直接推送'));
H.done('1024 反馈：推送');
