'use strict';
/* 优化后的边界反例：旧任务分类、非秘密开关、恢复包附加文件、审查链接与预算。全部用假目录和回环模型。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');
const rejected = (fn) => { try { fn(); return false; } catch (e) { return e.message; } };
(async () => {
  const h = H.makeHome('optimization-boundaries', process.argv[2]);
  const mod = (n) => path.join(h.kit, 'lib', n + '.js');
  for (const n of ['task-types', 'redact', 'local-backup', 'review-runner']) H.ok(n + ' 随包提供', fs.existsSync(mod(n)));
  if (!fs.existsSync(mod('review-runner'))) { H.done('优化边界'); return; }
  const T = require(mod('task-types')); const R = require(mod('review-runner')); const B = require(mod('local-backup')); const S = require(mod('session')); const E = require(mod('evidence'));
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n', 'links/example.js': 'const source=1;\n', 'openspec/changes/add-x/tasks.md': '- [x] 1.1 实现 a.js；验：node a.js\n- [ ] 2.1 [代码审查] 独立审查；验：完整结果\n- [ ] 2.2 [审查意见处理] 处理审查发现；验：处理记录和复验\n- [ ] 3.1 改库；验：查库（留给用户：需确认）\n' });
  const d = path.join(p, 'openspec/changes/add-x');
  const handoverTranscript = path.join(h.root, 'handover.jsonl');
  const handoverEvent = { cwd: p, session_id: 'handover-check', transcript_path: handoverTranscript, tool_name: 'Skill', tool_input: { skill: 'ttls-handover' } };
  for (const said of ['继续', '不要交接', '交接文档有什么用？']) {
    H.transcript(handoverTranscript, [H.tr.user(said)]);
    H.ok(said + '不授权交接技能', !!H.hook(h, 'guard-ask', handoverEvent));
    H.ok(said + '不授权直接写交接', !!H.hook(h, 'pre-edit', Object.assign({}, handoverEvent, { tool_name: 'Write', tool_input: { file_path: path.join(p, '.vibe/handover.md'), content: '# 当前事实\n' } })));
  }
  for (const said of ['写一份交接文档', '交接吧']) {
    H.transcript(handoverTranscript, [H.tr.user(said)]);
    H.ok(said + '允许手动交接技能', H.hook(h, 'guard-ask', handoverEvent) === null);
  }
  H.transcript(handoverTranscript, [H.tr.user('<command-name>/ttls-handover</command-name><command-args></command-args>')]);
  H.ok('用户执行交接命令允许写当前记录', H.hook(h, 'pre-edit', Object.assign({}, handoverEvent, { tool_name: 'Write', tool_input: { file_path: path.join(p, '.vibe/handover.md'), content: '# 当前事实\n' } })) === null);
  H.ok('明确选择旧策略的有效全自动仍可交接', S.canWriteHandover(handoverEvent, { contextStrategy: 'handover', autoMode: true, autoHandover: true }));
  H.transcript(handoverTranscript, [H.tr.user('继续')]);
  H.ok('旧策略关闭自动交接也不能自行写', !S.canWriteHandover(handoverEvent, { contextStrategy: 'handover', autoMode: true, autoHandover: false }));
  H.ok('旧的留给用户项不催自动执行', !T.automatedLeft(d).some((t) => /改库/.test(t.text)));
  H.ok('旧的人工项不阻塞代码审查前置', T.readyForReview(d));
  H.ok('下一项显示编号而不带复选框', /^2\.1/.test(T.automatedLeft(d)[0].text));
  const redactor = require(mod('redact'));
  const publicConfig = redactor.tree({ kitBypass: 'ask', sshToken: 'auto', tokenSource: 'manual', tokenExpires: '2026-11-01', tokenMasked: 'glpat-…1234', password: 'FAKE_PRIVATE_VALUE' });
  H.ok('非秘密开关保留合法选项', publicConfig.kitBypass === 'ask' && publicConfig.sshToken === 'auto');
  H.ok('令牌来源和有效期保持可用', publicConfig.tokenSource === 'manual' && publicConfig.tokenExpires === '2026-11-01' && publicConfig.tokenMasked === 'glpat-…1234');
  H.ok('假秘密仍被遮盖', !JSON.stringify(publicConfig).includes('FAKE_PRIVATE_VALUE'));
  H.ok('同名字段的非法值不能借白名单', !JSON.stringify(redactor.tree({ kitBypass: 'FAKE_BYPASS_SECRET', tokenSource: 'FAKE_SOURCE_SECRET', tokenMasked: 'FAKE_FULL_TOKEN' })).includes('FAKE_'));
  const typedSecret = redactor.tree({ password: 998812, apiKey: { raw: 'FAKE_NESTED_OPAQUE_VALUE' }, refreshToken: ['FAKE_ARRAY_TOKEN'], input_tokens: 42, output_tokens: 12 });
  H.ok('数值和复合形态凭据也遮盖', !JSON.stringify(typedSecret).includes('998812') && !JSON.stringify(typedSecret).includes('FAKE_'));
  H.ok('合法 token 计数保持数值', typedSecret.input_tokens === 42 && typedSecret.output_tokens === 12);
  const folder = path.join(h.kit, 'update/previous-package'); const saved = B.save(h.kit, folder);
  H.ok('恢复包初始可验证', saved.ok && B.verify(folder, saved));
  H.write(path.join(folder, 'kit/secrets.json'), '{"token":"FAKE_INJECTED_SECRET"}');
  H.ok('恢复包新增敏感文件也拒绝', !B.verify(folder, saved));
  fs.unlinkSync(path.join(folder, 'kit/secrets.json'));
  H.write(path.join(folder, 'kit/extra.js'), 'throw new Error("不应执行");');
  H.ok('恢复包新增普通文件也拒绝', !B.verify(folder, saved));
  fs.unlinkSync(path.join(folder, 'kit/extra.js'));
  const outside = H.tempDir('review-outside'); H.write(path.join(outside, 'example.js'), 'const outside="FAKE_EXTERNAL_REVIEW_VALUE";\n');
  fs.symlinkSync(outside, path.join(folder, 'kit/injected-link'), process.platform === 'win32' ? 'junction' : 'dir');
  H.ok('恢复包新增目录链接也拒绝', !B.verify(folder, saved));
  fs.rmSync(path.join(folder, 'kit/injected-link'), { recursive: true });
  H.ok('删除附加内容后原包仍有效', B.verify(folder, saved));
  fs.rmSync(path.join(p, 'links'), { recursive: true }); fs.symlinkSync(outside, path.join(p, 'links'), process.platform === 'win32' ? 'junction' : 'dir');
  H.write(path.join(p, 'invalid.js'), Buffer.from([0xff, 0xfe, 0x61, 0x00])); H.write(path.join(p, 'a.js'), 'const a=2;\n');
  const opts = { cwd: p, change: 'add-x', mode: 'code', base: 'HEAD', newBudget: true };
  const materials = R.materials(opts, S.allChanges(p).find((c) => c.name === 'add-x'));
  H.ok('代码审查不读取目录链接外的材料', !JSON.stringify(materials.items).includes('FAKE_EXTERNAL_REVIEW_VALUE'));
  H.ok('外部链接明确列为未覆盖', materials.skipped.some((x) => /example\.js/.test(x.file)));
  H.ok('二进制或无效编码明确列为未覆盖', materials.skipped.some((x) => /invalid\.js/.test(x.file)));
  fs.rmSync(path.join(p, 'links'), { recursive: true }); H.write(path.join(p, 'links/example.js'), 'const source=1;\n'); fs.unlinkSync(path.join(p, 'invalid.js'));
  let mode = 'clean';
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (mode === 'hang') return; const issues = mode === 'issue' ? [{ severity: 'P2', file: 'a.js', line: 1, problem: '测试问题', evidence: 'const a=2', fix: '核对 a 的值' }] : []; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ issues, summary: '有限材料完成' }) }] })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const oldPort = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
  const decisions = path.join(p, '.vibe/decisions.json');
  try {
    const clean = await R.run(opts); const report = JSON.parse(H.read(clean.file));
    H.ok('报告落盘为可读取的结构化对象', report && typeof report === 'object' && Array.isArray(report.issues) && report.id === clean.id);
    H.write(decisions, JSON.stringify({ findings: [] })); H.write(path.join(p, 'a.js'), 'const a=3;\n');
    H.ok('零问题报告不能批准后来变更的代码', !!rejected(() => R.resolve(Object.assign({}, opts, { decisions }))));
    H.write(path.join(p, 'a.js'), 'const a=2;\n'); mode = 'issue'; await R.run(opts);
    H.write(decisions, JSON.stringify({ findings: [{ id: 'r1', action: 'rejected', reason: '核对设计要求后，该值符合已确认规则，不成立。' }] }));
    H.ok('同版不成立意见可登记可核对理由', !rejected(() => R.resolve(Object.assign({}, opts, { decisions }))));
    H.write(path.join(p, 'a.js'), 'const a=4;\n');
    H.ok('仅驳回意见不能批准未审查的新代码', !!rejected(() => R.resolve(Object.assign({}, opts, { decisions }))));
    H.write(decisions, JSON.stringify({ findings: [{ id: 'r1', action: 'fixed', reason: '已改 a.js 并用 node a.js 复验当前版本通过。' }] }));
    H.ok('成立问题未复验不能登记完成', !!rejected(() => R.resolve(Object.assign({}, opts, { decisions }))));
    E.recordTool({ cwd: p, session_id: 'fixed', tool_use_id: 'fix-verify', tool_name: 'Bash', tool_input: { command: 'node a.js' }, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0, stdout: '通过' } }, true);
    H.ok('修复和当前版复验可登记完成', !rejected(() => R.resolve(Object.assign({}, opts, { decisions }))));
    mode = 'issue'; await R.run(opts);
    H.ok('重新审查不继承上一轮意见处理许可', !S.reviewRecord('code', d).resolved && !S.reviewRecord('code', d).resolvedFingerprint);
    mode = 'hang'; const pending = R.run(opts); await H.sleep(350); R.cancel(opts); const cancelled = await pending; const firstSpent = R.status(opts).spentMs;
    H.ok('取消审查保留已消耗预算', cancelled.status === 'cancelled' && firstSpent >= 300, firstSpent);
    const again = R.run(Object.assign({}, opts, { newBudget: false })); await H.sleep(350); R.cancel(opts); await again;
    H.ok('重复取消仍累计总预算', R.status(opts).spentMs >= firstSpent + 300, R.status(opts).spentMs);
    const key = R.jobKey(p, 'add-x', 'code'); const interrupted = Object.assign({}, R.status(opts), { id: 'dead-review', status: 'running', pid: 999999, started: Date.now() - 800, deadline: Date.now() + 5000, spentBefore: 250, spentMs: 250 }); S.updateState('review-jobs', (s) => { s[key] = interrupted; });
    H.ok('退出进程的已用预算仍保留', R.status(opts).status === 'interrupted' && R.status(opts).spentMs >= 1000, R.status(opts));
    const transcript = path.join(h.root, 'budget.jsonl'); const command = 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" run --project "' + p.replace(/\\/g, '/') + '" --change add-x --mode code --base HEAD --new-budget';
    const j = { cwd: p, session_id: 'budget', transcript_path: transcript, tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command }, tool_use_id: 'budget-run' };
    H.setConfig(h, { kitLock: false });
    for (const text of ['继续', '不要重开审查预算', '新审查预算有什么用？']) { H.transcript(transcript, [H.tr.user(text)]); H.ok(text + '不授权新预算', !!H.hook(h, 'guard-commit', j)); }
    H.transcript(transcript, [H.tr.user('重新开启 add-x 的审查预算')]);
    H.ok('真人明确重开预算可执行', H.hook(h, 'guard-commit', j) === null);
    H.hook(h, 'after-tool', Object.assign({}, j, { hook_event_name: 'PostToolUse', tool_response: { stdout: JSON.stringify({ status: 'completed', id: 'budget-complete' }), exit_code: 0 } }));
    H.ok('同一句新预算许可不能重复使用', !!H.hook(h, 'guard-commit', Object.assign({}, j, { tool_use_id: 'budget-again' })));
    H.transcript(transcript, [H.tr.user('重新开启 add-x 的审查预算')]);
    const failedRun = Object.assign({}, j, { tool_use_id: 'budget-failed' }); H.hook(h, 'guard-commit', failedRun);
    H.hook(h, 'after-tool', Object.assign({}, failedRun, { hook_event_name: 'PostToolUseFailure', error: '审查超时', tool_response: { exit_code: 1 } }));
    H.ok('失败不释放重开预算的一次许可', !!H.hook(h, 'guard-commit', Object.assign({}, j, { tool_use_id: 'budget-failed-retry' })));
  } finally { if (oldPort === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = oldPort; server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  const cp = require('child_process'); const originalExec = cp.execFileSync; let gitCalls = 0;
  try {
    cp.execFileSync = (...args) => { if (args[0] === 'git') gitCalls++; return originalExec(...args); };
    delete require.cache[require.resolve(mod('workspace'))]; const W = require(mod('workspace')); const C = require(mod('invocation'));
    C.run(() => { W.git(p, ['rev-parse', 'HEAD']); W.git(p, ['rev-parse', 'HEAD']); });
    H.ok('同一次调用的相同只读 Git 只启动一次', gitCalls === 1, gitCalls);
    C.run(() => W.git(p, ['rev-parse', 'HEAD'])); H.ok('下一次调用重新核对 Git', gitCalls === 2, gitCalls);
  } finally { cp.execFileSync = originalExec; }
  H.write(path.join(d, 'proposal.md'), '## Why\n已确认需要改 a.js。\n');
  const delivery = require(mod('workflow')).deliver(p, 'add-x');
  H.ok('提案交付说明是实际 Markdown 而非 JSON 字符串', /^# 提案交付\n/.test(H.read(delivery.file)));
  H.done('优化边界');
})().catch((e) => { H.ok('边界测试异常', false, e.stack); H.done('优化边界'); });
