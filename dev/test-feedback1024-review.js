'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 4 类：审查模型只回思考、没有正文（#206、#209、#211，旧 #180、#186、#188、#175）
 *   deepseek-flash、MiniMax 先思考，以前的输出上限 5000 全花在思考上，正文还没写就停了，整轮 model-empty
 * 用法：node dev/test-feedback1024-review.js [旧版的 vibe-kit 目录]
 */
const path = require('path');
const http = require('http');
const H = require('./lib/harness');

(async () => {
  const h = H.makeHome('feedback1024-review', process.argv[2], { reviewBudgetSeconds: 60 });
  const R = require(path.join(h.kit, 'lib/review-runner'));
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
  const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();

  H.section('只回思考、到了输出上限：同一批加大上限重试一次；诊断记停止原因、用量、模型');
  let mode = 'thinking-then-text'; let calls = 0; const bodies = [];
  const reply = (blocks, stop) => JSON.stringify({ id: 'msg', model: 'deepseek-flash', content: blocks, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 16000 } });
  const ok = (text) => ({ type: 'text', text: JSON.stringify({ issues: [], summary: '已审本批：' + text }) });
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (b) => { body += b; }); req.on('end', () => {
      calls++; bodies.push(JSON.parse(body)); res.writeHead(200);
      const thinking = { type: 'thinking', thinking: '先看看 a.js 有没有问题……', signature: 'x' };
      if (mode === 'thinking-then-text') return res.end(calls % 2 === 1 ? reply([thinking], 'max_tokens') : reply([thinking, ok('a')], 'end_turn'));
      if (mode === 'thinking-always') return res.end(reply([thinking], 'max_tokens'));
      if (mode === 'thinking-end') return res.end(reply([thinking], 'end_turn'));
      return res.end(reply([ok('b')], 'end_turn'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
  try {
    H.write(path.join(p, 'a.js'), 'let a=2;\n');
    let r = await R.run({ cwd: p, mode: 'code', base, newBudget: true });
    H.ok('第一次只回思考、停在输出上限，重试一次拿到正文：completed', r.status === 'completed' && calls === 2, { status: r.status, calls, reason: r.reason, diagnostics: r.diagnostics });
    H.ok('请求的输出上限不再是 5000；重试时更大', bodies[0].max_tokens >= 16000 && bodies[1].max_tokens > bodies[0].max_tokens, bodies.map((b) => b.max_tokens));
    calls = 0; bodies.length = 0; mode = 'thinking-always';
    H.write(path.join(p, 'a.js'), 'let a=3;\n');
    r = await R.run({ cwd: p, mode: 'code', base, newBudget: true });
    const d = (r.diagnostics || [])[0] || {};
    H.ok('两次都只有思考：failed，只重试一次', r.status === 'failed' && calls === 2, { status: r.status, calls });
    H.ok('诊断里有停止原因、输出用量、模型名', d.stage === 'model-empty' && d.stopReason === 'max_tokens' && d.outputTokens === 16000 && d.model === 'deepseek-flash', d);
    H.ok('结果里说清楚：只输出了思考、到了输出上限；给可操作的话（缩小范围、兼容代理方式）', /只输出了思考/.test(JSON.stringify(r)) && /缩小范围|兼容代理/.test(String(r.hint || '')), { reason: r.reason, hint: r.hint, skipped: r.skipped });
    calls = 0; bodies.length = 0; mode = 'thinking-end';
    H.write(path.join(p, 'a.js'), 'let a=4;\n');
    r = await R.run({ cwd: p, mode: 'code', base, newBudget: true });
    H.ok('只回思考但正常结束（end_turn）：不重试，照旧 model-empty', r.status === 'failed' && calls === 1 && ((r.diagnostics || [])[0] || {}).stage === 'model-empty', { status: r.status, calls });
    calls = 0; bodies.length = 0; mode = 'text';
    H.write(path.join(p, 'a.js'), 'let a=5;\n');
    r = await R.run({ cwd: p, mode: 'code', base, newBudget: true });
    H.ok('正常回了正文：一次就完成，不重试', r.status === 'completed' && calls === 1, { status: r.status, calls });
  } finally { server.close(); delete process.env.VIBE_KIT_REVIEW_PORT; }
  H.done('1024 反馈：审查只回思考');
})().catch((e) => { console.error(e); process.exit(1); });
