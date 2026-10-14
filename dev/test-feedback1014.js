'use strict';
/* 18:27 问题单：时间预算、无关验证、提交误拦、审查分批失败与收工摘要；所有项目和请求都在测试支架内。 */
const fs = require('fs'); const path = require('path'); const http = require('http'); const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('feedback1014', process.argv[2], { autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', specGate: false, lessons: 'off', vibeTidy: false });
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'openspec/changes/add-a/proposal.md': '审查材料：large.js\n', 'openspec/changes/add-a/tasks.md': '- [ ] 1.1 修改 a.js；验：node --check a.js\n' });
  const d = path.join(p, 'openspec/changes/add-a'); const S = require(path.join(h.kit, 'lib/session')); const I = require(path.join(h.kit, 'lib/invocation')); const E = require(path.join(h.kit, 'lib/evidence'));
  if (I.external) { let remaining; await I.run(async () => { await I.external(() => new Promise(r => setTimeout(r, 80))); remaining = I.remaining(100); }, { budgetMs: 60 }); H.ok('#105 外部等待不耗本机预算', remaining > 10); }
  else H.ok('#105 外部等待不耗本机预算', false);
  H.ok('#110 查库只读命令不收集测试指纹', E.actual({ cwd: p, tool_name: 'Bash', tool_input: { command: 'python "' + path.join(h.cfg, 'skills/ttls-db-crud/scripts/db.py') + '" find MENU --tables-only' }, tool_response: { exit_code: 0 } }) === null);
  H.write(path.join(p, '.claude/rules/learned-rules.md'), '经验\n'); H.git(p, ['add', '.claude/rules/learned-rules.md']);
  S.setFlow({ session_id: 'metadata' }, true, '写提案', 'plan');
  const transcript = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('继续整理规则')]);
  const commit = H.hook(h, 'guard-commit', { cwd: p, session_id: 'metadata', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'git commit -m "docs: 更新经验规则"' } });
  H.ok('#112 非提案暂存文件不套提案提交许可', !/提案提交要单独确认/.test(JSON.stringify(commit)), commit);
  H.write(path.join(p, 'large.js'), 'const value=1;\n'.repeat(15000));
  const R = require(path.join(h.kit, 'lib/review-runner')); let calls = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { calls++; res.writeHead(200); res.end(JSON.stringify({ content: calls === 1 ? [{ type: 'thinking', thinking: '模拟空正文' }] : [{ type: 'text', text: '{"issues":[],"summary":"本批完成"}' }] })); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const prev = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
  try {
    const result = await R.run({ cwd: p, mode: 'proposal', change: 'add-a', newBudget: true });
    H.ok('#116 首批失败后继续后续独立批次', result.totalBatches > 1 && result.attemptedBatches === result.totalBatches && result.completedBatches > 0, result);
    H.ok('#113 空正文不冒充无材料', result.diagnostics.some(x => x.stage === 'model-empty') && result.attemptedFiles.length > 0);
    H.ok('#116 失败批次有真实原因且不算完整通过', result.status !== 'completed' && result.skipped.some(x => /失败/.test(x.reason)) && !result.skipped.some(x => /超过本轮文件上限/.test(x.reason)), result.skipped);
  } finally { if (prev === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = prev; server.closeAllConnections(); await new Promise(r => server.close(r)); }
  const feedback = require(path.join(h.kit, 'lib/feedback'));
  feedback.record({ kind: '出错', hook: 'test', source: '钩子自动记录', title: '详细问题标题不应进入收尾', what: '模拟', sid: 'summary', cwd: p });
  const out = H.hook(h, 'verify-gate', { cwd: p, session_id: 'summary', hook_event_name: 'Stop', transcript_path: H.transcript(path.join(h.root, 'done.jsonl'), [H.tr.user('处理结束')]), last_assistant_message: '已经完成。' });
  H.ok('#115 套件问题摘要有数量和链接且无逐条要求', /套件问题.*1|1.*套件问题/.test(JSON.stringify(out)) && /127\.0\.0\.1.*ui/.test(JSON.stringify(out)) && !/逐条写|详细问题标题/.test(JSON.stringify(out)), out);
  H.done('1014 非数据库反馈');
})().catch(e => { console.error(e); H.ok('测试正常执行', false); H.done('1014 非数据库反馈'); });
