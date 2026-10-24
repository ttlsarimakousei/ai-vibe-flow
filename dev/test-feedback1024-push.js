'use strict';
/*
 * 问题反馈表第 5 条（仓库主人 2026-10-22 提的）：说"推送"就直接推。
 *   推送、push            直接 git push，几笔提交都一样，不出推送计划、不再问确认；壳子里几个子项目各推一次
 *   合并推送、合并 push    先给推送计划，用户确认后按计划推（照旧）
 *   合并成1条推送          不问，把没推的提交合成一条直接推（merge-push.js squash）
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

H.section('"合并推送"：照旧先出推送计划');
const rp = repo('plan', 2);
H.ok('说了合并推送：直接 git push 拦下，让它先出计划', blocked(guard(rp.dir, 'git push', '合并推送')) && /merge-push\.js" plan/.test(H.reasonOf(guard(rp.dir, 'git push', '合并推送'))));
H.ok('开口提示：先出推送计划', /推送预览[\s\S]*plan --dir/.test(JSON.stringify(prompt(rp.dir, '合并推送') || {})));

H.section('"合并成1条推送"：不问，合成一条直接推');
const rs = repo('squash', 3);
const squashCmd = 'node "' + tool + '" squash --dir "' + rs.dir.replace(/\\/g, '/') + '" --push';
H.ok('说了合并成1条推送：直接 git push 拦下，让它用 squash', blocked(guard(rs.dir, 'git push', '合并成1条推送')) && /squash --dir/.test(H.reasonOf(guard(rs.dir, 'git push', '合并成1条推送'))));
H.ok('说了合并成1条推送：squash --push 放行', guard(rs.dir, squashCmd, '合并成1条推送') === null, guard(rs.dir, squashCmd, '合并成1条推送'));
H.ok('只说了推送：squash 拦下（合成一条要用户说）', blocked(guard(rs.dir, squashCmd, '推送')));
H.ok('开口提示：合成一条直接推，不用再问', /squash --dir <仓库> --push/.test(JSON.stringify(prompt(rs.dir, '合并成1条推送') || {})));
const treeBefore = H.git(rs.dir, ['rev-parse', 'HEAD^{tree}']).out.trim();
const run = H.node(h, path.join(h.kit, 'tools/merge-push.js'), ['squash', '--dir', rs.dir, '--push']);
let res = {}; try { res = JSON.parse(run.out); } catch (e) { res = {}; }
H.ok('squash：3 条合成 1 条、推上去了', run.code === 0 && res.before === 3 && res.after === 1 && res.pushed, run.out + run.err);
H.ok('squash：文件内容和原来一样，远端只多一条提交', H.git(rs.dir, ['rev-parse', 'HEAD^{tree}']).out.trim() === treeBefore && H.run(h, 'git', ['--git-dir', rs.bare, 'rev-list', '--count', 'HEAD']).out.trim() === '2', H.run(h, 'git', ['--git-dir', rs.bare, 'log', '--oneline']).out);
H.ok('squash：原来三条的说明都留在新提交里，旧提交有备份', /第 1 处[\s\S]*第 2 处[\s\S]*第 3 处/.test(H.git(rs.dir, ['log', '-1', '--format=%B']).out) && !!res.backup && H.git(rs.dir, ['rev-parse', '--verify', res.backup]).code === 0);
const fresh = H.makeRepo(path.join(h.work, 'fresh'), { 'a.txt': '0\n' });
const fb = path.join(h.root, 'fresh.git'); H.run(h, 'git', ['init', '--bare', fb]); H.run(h, 'git', ['-C', fresh, 'remote', 'add', 'origin', fb]);
const first = H.node(h, path.join(h.kit, 'tools/merge-push.js'), ['squash', '--dir', fresh, '--push']);
H.ok('远端还没有这个分支：不合成（会把整个历史压成一条），让它先普通推送', first.code !== 0 && /第一次推送先普通 git push -u/.test(first.out), first.out);
H.done('1024 反馈：推送');
