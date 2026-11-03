'use strict';
/* 测试和审查也是 tasks；独立请求有限时、覆盖和取消判定。假模型只在回环端口回复，不调用 Claude 账户。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('review-evidence', process.argv[2]);
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n', 'openspec/changes/add-x/tasks.md': '- [x] 1.1 实现 a.js；验：node a.js\n- [x] 2.1 [联合验证] 验证 a.js；验：node a.js\n- [ ] 3.1 [代码审查] 独立审查；验：完整审查结果\n- [ ] 3.2 [审查意见处理] 核实并处理所有意见；验：复验与处理记录\n- [ ] 4.1 [用户验收] 用户自测；验：用户确认当前版本\n' });
  H.write(path.join(p, 'a.js'), 'const a=2;\n');
  const file = path.join(h.kit, 'lib/review-runner.js'); H.ok('独立审查执行器随包提供', fs.existsSync(file));
  if (!fs.existsSync(file)) { H.done('审查和证据'); return; }
  const R = require(file); const E = require(path.join(h.kit, 'lib/evidence')); const T = require(path.join(h.kit, 'lib/task-types')); const S = require(path.join(h.kit, 'lib/session'));
  const d = path.join(p, 'openspec/changes/add-x');
  H.ok('未勾审查和用户验收不阻止启动审查', T.readyForReview(d));
  H.ok('用户验收不算自动可执行任务', T.automatedLeft(d).every((t) => t.kind !== 'user'));
  H.ok('启动前不能勾审查', !!T.tickIssue('[代码审查] 审查', d, { cwd: p }));
  H.ok('真实打勾文本的裸编号仍识别审查', T.kind('3.1 [代码审查] 独立审查') === 'review' && !!T.tickIssue('3.1 [代码审查] 审查', d, { cwd: p }));
  const j = { cwd: p, session_id: 'evidence', tool_name: 'Bash', tool_use_id: 'test-1', tool_input: { command: 'node a.js' }, tool_response: { exit_code: 0, stdout: '通过' }, hook_event_name: 'PostToolUse' };
  E.recordTool(j, true); H.ok('当前代码有成功执行证据', E.commands(p).includes('node a.js'));
  E.recordTool(j, true); H.ok('重复工具通知不重复记录', S.readState('evidence').rows.length === 1);
  const after = require(path.join(h.kit, 'hooks/after-tool'));
  H.ok('后台启动不是成功完成', !after.successful(Object.assign({}, j, { tool_response: { task_id: 'fake-background', stdout: '已启动' } })));
  H.ok('别的仓库命令不借当前仓库证据', E.actual(Object.assign({}, j, { tool_input: { command: 'git -C "../other" status; node a.js' } })) === null);
  H.write(path.join(p, 'a.js'), 'const a=3;\n'); H.ok('代码变化使旧验证失效', E.commands(p).length === 0);
  j.tool_use_id = 'test-2'; E.recordTool(j, false); H.ok('失败不能成为通过证据', E.commands(p).length === 0);
  {
    const opts = { cwd: p, change: 'add-x', mode: 'code', base: 'HEAD' };
    const good = (x) => '审查任务：' + x.id + '/' + x.agents[0].lens + '\n```json\n{"issues":[],"summary":"本批审完"}\n```';
    const r = await H.fakeReview(R, opts); H.ok('子代理交齐完成审查', r.status === 'completed' && r.covered.includes('a.js'), r.status);
    H.ok('完整结果可勾审查和零意见处理', T.tickIssue('[代码审查] 审查', d, { cwd: p }) === '' && T.tickIssue('[审查意见处理] 处理', d, { cwd: p }) === '');
    H.ok('模型测试不能代替用户验收', !!T.tickIssue('[用户验收] 自测', d, { cwd: p }));
    const before = S.codeReviewed(d); H.write(path.join(d, 'tasks.md'), H.read(path.join(d, 'tasks.md')).replace('[ ] 3.1', '[x] 3.1'));
    H.ok('勾审查任务不让已审代码失效', before && S.codeReviewed(d));
    const stale = await H.fakeReview(R, opts, () => { H.write(path.join(p, 'a.js'), 'const a=4;\n'); return { issues: [] }; }); H.ok('审查期间输入变化不批准新版', stale.status === 'stale');
    H.ok('旧审查结果不能给新版打勾', !!T.tickIssue('[代码审查] 审查', d, { cwd: p }));
    const bp = R.prepare(opts); const bad = R.submit(bp.id, bp.agents[0].lens, '不是 JSON'); H.ok('不认识的回复不能算审完', bad.ok === false && R.status(opts).status === 'running', bad);
    R.cancel(opts); const late = R.submit(bp.id, bp.agents[0].lens, good(bp));
    H.ok('取消后迟到结果不记审查', late.late === true && R.status(opts).status === 'cancelled', late);
    // 2026-10-28 起不截断（用户定的，问题反馈表第 6 条）：慢过预期用时也等它审完，审完记一条问题反馈
    const sp = R.prepare(Object.assign({}, opts, { budgetSeconds: 10 }));
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === sp.id) o[k].started = Date.now() - 60000; });
    const slow = R.submit(sp.id, sp.agents[0].lens, good(sp));
    H.ok('不截断：慢过预期用时也等它审完', slow.status === 'completed', slow.status + ' ' + slow.reason);
    H.ok('超出预期用时：自动记了一条问题反馈', !!slow.reported, slow);
        H.write(path.join(d, 'proposal.md'), '需求'.repeat(30000));
    const tooLong = R.materials(opts, S.allChanges(p).find((c) => c.name === 'add-x'));
    H.ok('大需求材料分片完整送审', tooLong.items.filter((x) => x.file === 'proposal.md').length > 1 && !tooLong.skipped.some((x) => x.file === 'proposal.md'));
    H.ok('审查材料不删除鉴权代码逻辑', require(path.join(h.kit, 'lib/redact')).material('token = validate(input); password = "FAKE_REVIEW_PASSWORD"').includes('token = validate(input)') && !require(path.join(h.kit, 'lib/redact')).material('password = "FAKE_REVIEW_PASSWORD"').includes('FAKE_REVIEW_PASSWORD'));
  }
  H.done('审查和证据');
})();
