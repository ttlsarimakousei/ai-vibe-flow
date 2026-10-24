'use strict';
/* 普通 push 也要给用户具体预览后再确认。只向假 HOME 中的临时裸仓库推送，检查同事件合并、标签保留和计划失效。 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const h = H.makeHome('push-preview', process.argv[2]);
const repo = H.makeRepo(path.join(h.work, 'repo'), { '.gitignore': '.vibe/\n', 'a.txt': '0\n' });
const bare = path.join(h.root, 'remote.git');
H.run(h, 'git', ['init', '--bare', bare]);
const git = (args) => H.run(h, 'git', ['-C', repo].concat(args));
git(['remote', 'add', 'origin', bare]); git(['push', '-u', 'origin', 'HEAD']);
const add = (n, title) => { H.write(path.join(repo, 'a.txt'), n + '\n'); git(['add', 'a.txt']); git(['commit', '-m', title]); };
add(1, 'feat: 实现导出（源自 export 1.1）');
add(2, 'fix: 审查修复导出（源自 export 1.1）');
const cli = path.join(h.kit, 'tools/merge-push.js');
const tf = path.join(h.root, 'dialog.jsonl'); const turns = [];
function say(text) { turns.push(H.tr.user(text)); H.write(tf, turns.map(JSON.stringify).join('\n') + '\n'); }
function hook(name, extra) { return H.hook(h, name, Object.assign({ session_id: 'push', cwd: repo, transcript_path: tf }, extra)); }
const command = (args) => 'node "' + cli.replace(/\\/g, '/') + '" ' + args;
const guard = (cmd) => hook('guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'push-action', tool_input: { command: cmd } });
const blocked = (v) => !!v && v.decision === 'block';
function preview() {
  const cmd = command('plan --dir "' + repo.replace(/\\/g, '/') + '"');
  const r = H.node(h, cli, ['plan', '--dir', repo]);
  let p; try { p = JSON.parse(r.out); } catch (e) { p = {}; }
  const after = hook('after-tool', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'plan-action', tool_input: { command: cmd }, tool_response: { stdout: r.out, stderr: r.err, exit_code: r.code } });
  return { p, r, after, cmd };
}
function applyCommand(p) { return command('apply --dir "' + repo.replace(/\\/g, '/') + '" --plan "' + String(p.plan || '').replace(/\\/g, '/') + '" --confirmed ' + (p.hash || 'missing') + ' --push'); }
say('push');
const note = hook('task-anchor', { hook_event_name: 'UserPromptSubmit', prompt: 'push' });
// 2026-10-25 起（用户定的）：说"push"就直接推，几笔提交都一样；"合并推送"才先出计划（下面的计划流程照旧）
H.ok('普通 push 指令提示直接推，不出推送计划', /直接 git -C <仓库> push/.test(JSON.stringify(note || {})) && !/merge-push\.js" plan/.test(JSON.stringify(note || {})), note);
H.ok('说了 push：两笔没推的提交也直接 git push', guard('git push') === null, guard('git push'));
const first = preview();
H.ok('预览成功并列出原记录和最终标题', first.r.code === 0 && first.p.before === 2 && first.p.after === 1 && Array.isArray(first.p.groups[0].titles) && first.p.groups[0].titles.length === 2, first.r);
H.ok('成功完成钩子登记并给用户可见提醒', /等待你看过并确认/.test(JSON.stringify(first.after || {})), first.after);
H.ok('第一次 push 指令不能当作预览后的确认', blocked(guard(applyCommand(first.p))));
H.ok('没有确认编号的执行工具拒绝改历史', H.node(h, cli, ['apply', '--dir', repo, '--plan', first.p.plan, '--push']).code !== 0);
say('先别推送');
H.ok('否定推送不能授权合并计划', blocked(guard(applyCommand(first.p))));
say('确认推送');
H.ok('另一次明确确认可以执行同一计划', guard(applyCommand(first.p)) === null, guard(applyCommand(first.p)));
hook('after-tool', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'unrelated-push', tool_input: { command: applyCommand(first.p) }, tool_response: { stdout: '{"ok":false,"pushed":false}', exit_code: 1 } });
H.ok('失败推送不消费已确认预览', guard(applyCommand(first.p)) === null);
H.ok('另一个会话不能借用预览', blocked(H.hook(h, 'guard-commit', { session_id: 'other', cwd: repo, transcript_path: tf, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: applyCommand(first.p) } })));
H.ok('不能借确认跳过计划直接 git push', blocked(guard('git push')));
const applied = H.node(h, cli, ['apply', '--dir', repo, '--plan', first.p.plan, '--confirmed', first.p.hash, '--push']);
let result; try { result = JSON.parse(applied.out); } catch (e) { result = {}; }
H.ok('确认后合并同事件并正常推到临时裸仓库', applied.code === 0 && result.before === 2 && result.after === 1 && result.pushed, applied);
H.ok('最终文件和原说明保留', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === '2\n' && /审查修复导出/.test(git(['log', '-1', '--format=%B']).out));
hook('after-tool', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'push-action', tool_input: { command: applyCommand(first.p) }, tool_response: { stdout: applied.out, exit_code: applied.code } });
H.ok('成功推送后的预览不能再次消费', blocked(guard(applyCommand(first.p))));
add(3, 'feat: 新增下一项（源自 export 1.2）');
say('推送'); const stale = preview(); say('确认推送');
add(4, 'fix: 确认后又修改（源自 export 1.2）');
H.ok('预览后新增提交需要重新预览确认', blocked(guard(applyCommand(stale.p))));
say('推送'); const changed = preview(); say('确认推送');
git(['config', 'remote.origin.url', path.join(h.root, 'different.git')]);
H.ok('相同远端名换地址使计划失效', blocked(guard(applyCommand(changed.p))));
git(['config', 'remote.origin.url', bare]);
git(['tag', 'v-test-local']); say('push'); const tagged = preview();
H.ok('版本标签不会阻止生成保留历史的预览', tagged.r.code === 0 && tagged.p.before === tagged.p.after && Array.isArray(tagged.p.warnings) && tagged.p.warnings.length === 1, tagged.r);
say('确认推送'); H.ok('带标签的历史确认后可普通推送', guard(applyCommand(tagged.p)) === null, guard(applyCommand(tagged.p)));
const tagHead = git(['rev-parse', 'HEAD']).out.trim();
const kept = tagged.p.plan ? H.node(h, cli, ['apply', '--dir', repo, '--plan', tagged.p.plan, '--confirmed', tagged.p.hash, '--push']) : { code: 1, out: '旧版没有保留历史的预览' };
H.ok('受保护历史的提交 ID 保持不变', kept.code === 0 && git(['rev-parse', 'HEAD']).out.trim() === tagHead && git(['rev-parse', '@{u}']).out.trim() === tagHead, kept);
say('合并push'); const oldWord = hook('task-anchor', { hook_event_name: 'UserPromptSubmit', prompt: '合并push' });
H.ok('旧合并push口令仍进入预览', /推送预览/.test(JSON.stringify(oldWord || {})), oldWord);
H.done('推送预览和合并确认');
