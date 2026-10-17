'use strict';
/* 就绪、实际地址、恢复包、会话冲突与一次调用缓存的边界反例。全部在假用户目录；不访问真实数据库和 IDEA。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('optimization-runtime', process.argv[2]); const mod = (n) => path.join(h.kit, 'lib', n + '.js');
  for (const n of ['readiness', 'workflow', 'invocation', 'work-sessions', 'local-backup', 'entry-check']) H.ok(n + ' 随套件提供', fs.existsSync(mod(n)));
  if (!fs.existsSync(mod('workflow'))) { H.done('运行流程优化'); return; }
  const p = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>', 'a.js': 'const x=1;\n', '.gitignore': '.vibe/\n', 'openspec/changes/add-x/tasks.md': '- [x] 1.1 实现 a.js；验：node a.js\n- [ ] 2.1 [代码审查] 完整审查；验：完整结果\n- [ ] 3.1 [用户验收] 自测；验：用户确认\n' });
  const S = require(mod('session')); const W = require(mod('workflow')); const C = require(mod('invocation')); const ready = require(mod('readiness')); const B = require(mod('local-backup')); const Sessions = require(mod('work-sessions'));
  H.ok('就绪区分识别与实际验证', ready.inspect(p).identified.includes('Maven') && /未实际执行/.test(ready.inspect(p).verification));
  const first = ready.inspect(p); H.write(path.join(p, 'pom.xml'), '<project><version>2</version></project>'); H.ok('配置变化使就绪缓存失效', first.fingerprint !== ready.inspect(p).fingerprint);
  // 2026-10-17 起任务只写实现，不写"验："（用户定的），测试和验收写在 design.md 的验收用例里
  H.ok('任务模板只列要做的实现，不写验法和测试、审查、验收任务', !/\[联合验证\]|\[代码审查\]|\[审查意见处理\]|\[用户验收\]/.test(W.taskTemplate()) && !/验：/.test(W.taskTemplate()));
  H.ok('普通任务提交计划明确先确认', /普通任务/.test(W.commitPlan(p).confirmation) && !W.commitPlan(p).effectiveAuto);
  H.write(path.join(p, '.vibe/run/backend.json'), JSON.stringify({ name: 'backend', pid: process.pid, port: 36781 }));
  H.ok('自测使用实际登记地址', W.selfTest(p).services.some((s) => s.url === 'http://127.0.0.1:36781' && s.owner === 'devserver'));
  H.ok('恢复事实不授予历史许可', /不授予.*许可/.test(W.brief(p, { cwd: p, session_id: 'fresh' })) && !S.flowView({ cwd: p, session_id: 'fresh' }).effective);
  H.ok('事实摘要的任务进度来自任务文件', !/undefined/.test(W.brief(p)) && W.facts(p).changes[0].total === 3);
  const dir = path.join(p, 'openspec/changes/add-x'); S.writeState('one-flow', { on: true, stage: 'apply', at: Date.now(), changes: [S.normKey(dir)] }); S.writeState('two-flow', { on: true, stage: 'apply', at: Date.now(), changes: [S.normKey(dir)] });
  H.ok('第一个实施会话没有冲突', Sessions.touch({ cwd: p, session_id: 'one' }).length === 0);
  H.ok('同一变更第二会话提示冲突', Sessions.touch({ cwd: p, session_id: 'two' }).includes('one'));
  S.setFlow({ session_id: 'one' }, false, '取消'); Sessions.touch({ cwd: p, session_id: 'one' }); H.ok('取消后撤销占用', !S.readState('work-sessions').one);
  H.setConfig(h, { autoMode: true }); H.write(path.join(dir, 'tasks.md'), H.read(path.join(dir, 'tasks.md')).replace('[ ] 2.1', '[x] 2.1'));
  H.reviewPoints(h, dir);
  H.ok('只剩用户验收时执行和展示都暂停全自动', !S.readConfigFor({ cwd: p, session_id: 'two' }).autoMode && /用户自测/.test(S.flowView({ cwd: p, session_id: 'two' }).waiting), { flow: S.flowState({ session_id: 'two' }), view: S.flowView({ cwd: p, session_id: 'two' }), tasks: require(mod('task-types')).tasks(dir) });
  H.write(path.join(dir, 'proposal.md'), '## Why\n修复已确认问题。\n参考 [样例](assets/sample.txt)\n'); H.write(path.join(dir, 'assets/sample.txt'), '非敏感样例\n');
  const delivered = W.deliver(p, 'add-x'); H.ok('提案交付只用相对链接且没有假批准', /待用户核对/.test(H.read(delivered.file)) && !H.read(delivered.file).includes(h.root));
  H.git(p, ['add', 'openspec/changes/add-x/proposal.md', 'openspec/changes/add-x/assets/sample.txt', 'openspec/changes/add-x/delivery.md']); H.git(p, ['commit', '-m', 'docs: 交付提案材料']);
  const clean = path.join(h.work, 'clean'); const clone = H.git(h.work, ['-c', 'core.autocrlf=false', 'clone', '-q', p, clean]);
  H.ok('另一份干净检出能读取必要材料', clone.code === 0 && fs.existsSync(path.join(clean, 'openspec/changes/add-x/assets/sample.txt')) && require(mod('proposal-files')).changeIssues({ dir: path.join(clean, 'openspec/changes/add-x'), root: clean, name: 'add-x' }).length === 0);
  const src = path.join(h.kit, 'update/previous-package'); H.write(path.join(h.kit, 'secrets.json'), '{"token":"FAKE_BACKUP_SECRET"}');
  const saved = B.save(h.kit, src); H.ok('本地恢复包可验证', saved.ok && B.verify(src, saved), saved.reason);
  H.ok('运行配置与凭据不进入恢复包', !fs.existsSync(path.join(src, 'kit/secrets.json')) && !fs.existsSync(path.join(src, 'kit/state')) && !fs.existsSync(path.join(src, 'kit/config.json')));
  H.write(path.join(src, 'kit/statusline.js'), '// 被更改'); H.ok('恢复包被修改后拒绝执行', !B.verify(src, saved));
  H.ok('入口自检真实行为通过', require(mod('entry-check')).check().ok);
  let reads = 0; H.ok('一次调用复用结果', C.run(() => C.memo('x', () => ++reads) === C.memo('x', () => ++reads)) && reads === 1);
  C.run(() => C.memo('x', () => ++reads)); H.ok('下一次调用不复用旧结果', reads === 2);
  const results = await Promise.all([C.run(async () => { C.memo('sid', () => 'one'); await H.sleep(30); return C.memo('sid', () => 'wrong'); }), C.run(async () => { C.memo('sid', () => 'two'); await H.sleep(5); return C.memo('sid', () => 'wrong'); })]);
  H.ok('并发会话缓存隔离', results.join(',') === 'one,two');
  S.writeState('usage', { days: { [require(mod('usage')).dayKey()]: { n: { prompt: 3, 'review.ms': 999999 } } } });
  const usage = require(mod('usage')).collect(); H.ok('上报不含本机耗时', !Object.keys(usage.n).some((k) => k.endsWith('.ms')) && usage.hooks.every((r) => r.avg === undefined) && usage.tools.every((r) => r.avg === undefined) && !usage.hints.length);
  const tool = H.hook(h, 'after-tool', { cwd: p, session_id: 'ide', tool_name: 'mcp__jetbrains__execute_terminal_command', hook_event_name: 'PostToolUse', tool_use_id: 'ide-output', tool_input: { projectPath: p, command: 'git status' }, tool_response: { content: [{ type: 'text', text: 'password=FAKE_IDEA_PASSWORD; test failed' }] } });
  H.ok('IDEA 输出保留失败信息并遮口令', JSON.stringify(tool).includes('test failed') && !JSON.stringify(tool).includes('FAKE_IDEA_PASSWORD'));
  H.done('运行流程优化');
})().catch((e) => { H.ok('流程测试异常', false, e.stack); H.done('运行流程优化'); });
