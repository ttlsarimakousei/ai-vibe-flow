'use strict';
/* #64—#67：真实临时仓库的预览、提问框确认、输出管道、失效和分组。远端只在假 HOME。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('./lib/harness');
const h = H.makeHome('feedback1012-push', process.argv[2]);
const repo = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.txt': '0\n' });
const git = (args) => H.run(h, 'git', ['-C', repo].concat(args));
const bare = path.join(h.root, 'remote.git'); H.run(h, 'git', ['init', '--bare', bare]);
git(['remote', 'add', 'origin', bare]); git(['push', '-u', 'origin', 'HEAD']);
for (let i = 1; i <= 8; i++) { H.write(path.join(repo, 'a.txt'), String(i)); git(['add', 'a.txt']); git(['commit', '-m', 'fix: 修改字段（源自 add-a 1.1）']); }
const cli = path.join(h.kit, 'tools/merge-push.js');
const command = 'node "' + cli.replace(/\\/g, '/') + '" plan --dir "' + repo.replace(/\\/g, '/') + '"';
const r = H.node(h, cli, ['plan', '--dir', repo]);
const p = JSON.parse(r.out);
H.ok('预览实际生成八条提交的分组', r.code === 0 && p.before === 8 && p.after === 1, r);
let n = 0;
const transcript = (entries) => H.transcript(path.join(h.root, 't' + (++n) + '.jsonl'), entries);
const ask = (a) => H.tr.ran('AskUserQuestion', { questions: [{ question: '按上面的计划合并推送？' }] }, 'Your questions have been answered: "按上面的计划合并推送？"="' + a + '"');
function preview(sid, suffix, stdout) {
  return H.hook(h, 'after-tool', { session_id: sid, cwd: repo, transcript_path: transcript([H.tr.user('合并push')]), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'preview', tool_input: { command: command + suffix }, tool_response: { stdout: stdout === undefined ? r.out : stdout, exit_code: 0 } });
}
for (const [sid, suffix] of [['pipe', ' 2>&1 | tail -5'], ['stderr', ' 2>&1'], ['head', ' | head -1']]) H.ok('完整 JSON 可以登记预览：' + suffix, /已生成推送预览/.test(JSON.stringify(preview(sid, suffix))));
for (const suffix of [' > .vibe/tmp/output.txt', ' | sed s/a/b/', ' && echo done']) H.ok('不支持的输出形式当场说明未登记：' + suffix, /预览未登记/.test(JSON.stringify(preview('unsupported' + n, suffix))));
H.ok('截断 JSON 当场说明未登记', /不是完整/.test(JSON.stringify(preview('truncated', ' | head -1', '{"ok":true'))));
preview('confirm', '');
const apply = 'node "' + cli.replace(/\\/g, '/') + '" apply --dir "' + repo.replace(/\\/g, '/') + '" --plan "' + p.plan.replace(/\\/g, '/') + '" --confirmed ' + p.hash + ' --push';
function guard(entries) { return H.hook(h, 'guard-commit', { session_id: 'confirm', cwd: repo, transcript_path: transcript(entries), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: apply } }); }
for (const a of ['照计划推送', '按照上面的计划推送', '确认合并推送']) H.ok('提问框确认有效：' + a, guard([H.tr.user('合并push'), ask(a)]) === null);
for (const a of ['先别照计划推送', '照计划推送有问题', '怎么照计划推送？']) H.ok('否定和讨论仍不授权：' + a, guard([H.tr.user('合并push'), ask(a)]) !== null);
H.ok('提问框确认后新取消优先', guard([H.tr.user('合并push'), ask('照计划推送'), H.tr.user('先别推送')]) !== null);
// 统计核对时实际调用的 Git；数量不得随未推送提交数增长，也不能使用超过 HTTP 预算的单次等待。
const original = cp.spawnSync; const seen = [];
cp.spawnSync = function (exe, args, opts) { if (exe === 'git') seen.push({ args, timeout: opts && opts.timeout }); return original.apply(this, arguments); };
const M = require(path.join(h.kit, 'lib/merge-push'));
const call = M.commandOf({ cwd: repo, tool_name: 'Bash', tool_input: { command: apply } });
const check = M.previewAllowed({ session_id: 'confirm', transcript_path: transcript([H.tr.user('确认推送')]) }, repo, call);
cp.spawnSync = original;
H.ok('确认后本机核对仍通过', check.ok, check);
H.ok('钩子不逐条读取提交详情', seen.length < 20 && !seen.some((x) => x.args.some((a) => /^(cat-file|diff-tree|show|tag|rev-list)$/.test(a))), seen);
H.ok('钩子每次 Git 等待不超过剩余八秒预算', seen.length > 0 && seen.every((x) => x.timeout > 0 && x.timeout <= 8000), seen);
const c = (id, title, files) => ({ id, title, files });
const groups = M.groupsOf([
  c('1', 'docs: 修订 add-a：调整说明', ['openspec/changes/add-a/specs/x/spec.md', 'docs/REQ/批注.md']),
  c('2', 'docs: 更新计划状态 add-a', ['openspec/plan.md']),
  c('3', 'docs: 修订 add-a：修订任务', ['openspec/changes/add-a/tasks.md']),
]);
H.ok('只有变更名没有任务或修复编号时保留各提交', groups.length === 3 && groups.every(g => g.ids.length === 1), groups);
H.ok('分组提供保留或合并原因', groups.every((g) => g.reason), groups);
H.ok('多变更提交不猜占比', M.eventOf(c('4', 'docs: 修订 add-a', ['openspec/changes/add-a/tasks.md', 'openspec/changes/add-b/tasks.md'])) === 'single:4');
H.ok('混入代码但无来源标记仍不猜', M.eventOf(c('5', 'docs: 修订 add-a', ['openspec/changes/add-a/tasks.md', 'src/A.java'])) === 'single:5');
const boundaries = M.groupsOf([c('6', 'fix: 实现（源自 add-a 1.1）', ['a']), c('7', 'docs: 归档 add-a', ['openspec/changes/archive/2026-10-12-add-a/tasks.md']), c('8', 'fix: 修复（源自 add-a 1.1）', ['a'])]);
H.ok('归档仍保留独立节点', boundaries.length === 3 && /独立/.test(boundaries[1].reason), boundaries);
H.write(path.join(repo, 'a.txt'), 'dirty');
H.ok('确认后工作区变动仍拒绝', guard([H.tr.user('确认推送')]) !== null);
H.done('1012 推送反馈');
