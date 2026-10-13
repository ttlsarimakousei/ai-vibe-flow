'use strict';
/* #68、#71、#75、#76、#84、#85、#91、#92：模拟回包、分片覆盖及真实代理完成事件。旧版应检出解析和材料反例。 */
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('feedback1013-review', process.argv[2]);
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'openspec/changes/add-a/tasks.md': '- [ ] 1.1 修改 a.js；验：node --check a.js\n', 'openspec/changes/add-a/proposal.md': '参考 src/area、src/large.js\n' });
  const d = path.join(p, 'openspec/changes/add-a'); const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner'));
  const large = ('const value=1;\n').repeat(12000); H.write(path.join(p, 'src/large.js'), large); H.write(path.join(p, 'src/area/b.js'), 'let b=1;');
  H.write(path.join(d, 'revisions.md'), '过去参考 src/historical.js\n'); H.write(path.join(p, 'src/historical.js'), '旧代码');
  H.write(path.join(d, 'proposal.md'), '参考 src/area、src/large.js、src/boundary.js\n');
  H.write(path.join(p, 'src/boundary.js'), ' '.repeat(39980) + 'token = "FAKE_REVIEW_BOUNDARY_VALUE";' + ' '.repeat(1000) + '\n');
  const material = R.materials({ cwd: p, mode: 'proposal' }, S.allChanges(p)[0]);
  H.ok('目录引用不造成未覆盖', !material.skipped.some((x) => x.file === 'src/area'));
  H.ok('修订历史不扩大当前材料', !material.items.some((x) => /historical|revisions/.test(x.file)));
  const chunks = material.items.filter((x) => x.file === 'src/large.js');
  H.ok('大文件分片完整保留内容', chunks.length > 1 && chunks.map((x) => x.text).join('') === large);
  H.ok('分片含行号和总片数', chunks.length > 1 && chunks.every((x, i) => x.part === i + 1 && x.parts === chunks.length && x.startLine > 0));
  const secretChunks = material.items.filter((x) => x.file === 'src/boundary.js');
  H.ok('跨片凭据字面值先脱敏', secretChunks.length > 1 && !secretChunks.map((x) => x.text).join('').includes('FAKE_REVIEW_BOUNDARY_VALUE'));
  let shape = 'outer', calls = 0; const bodies = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', (b) => body += b); req.on('end', () => {
    calls++; bodies.push(JSON.parse(body)); res.writeHead(200);
    if (shape === 'outer') return res.end('{bad');
    const text = shape === 'body' ? '正文错误 password="FAKE_REVIEW_SECRET"' : JSON.stringify({ issues: shape === 'file' ? [{ file: 'not-in-batch.js', problem: '模拟问题', evidence: '模拟依据' }] : [], summary: '已审本批' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const old = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
  try {
    for (shape of ['outer', 'body']) {
      const result = await R.run({ cwd: p, change: 'add-a', mode: 'proposal', newBudget: true });
      H.ok('解析阶段可分辨：' + shape, result.diagnostics && result.diagnostics[0].stage === (shape === 'outer' ? 'router-json' : 'model-json'), result);
      H.ok('已收到回复和已覆盖分开：' + shape, result.attemptedBatches === 1 && result.receivedBatches === 1 && result.covered.length === 0);
      H.ok('本机诊断不含假秘密：' + shape, !JSON.stringify(result).includes('FAKE_REVIEW_SECRET'));
    }
    shape = 'file'; const partial = await R.run({ cwd: p, change: 'add-a', mode: 'proposal', newBudget: true });
    H.ok('无效意见路径只记部分结果', partial.status === 'partial' && partial.skipped.some((x) => /意见路径/.test(x.reason)), partial.status);
    shape = 'ok'; const progress = []; const full = await R.run({ cwd: p, change: 'add-a', mode: 'proposal', newBudget: true }, (s) => progress.push(s));
    H.ok('所有分片成功后完整覆盖大文件', full.status === 'completed' && full.covered.filter((f) => f === 'src/large.js').length === 1, full.status);
    H.ok('进度展示片段与尝试数', progress.every((s) => /片段.*已尝试/.test(s)), progress);
    H.ok('请求有明确 JSON 结构要求', bodies.every((b) => /返回 JSON/.test(b.system)));
    const sentChunks = bodies.flatMap((b) => JSON.parse(b.messages[0].content.split('\n本批材料：\n')[1])).filter((m) => m.file === 'src/boundary.js');
    H.ok('所有实际请求不含跨片假凭据', !sentChunks.map((m) => m.text).join('').includes('FAKE_REVIEW_BOUNDARY_VALUE'));
    H.ok('确有独立请求', calls >= 4);
  } finally { if (old === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = old; server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  const input = { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/add-a/' };
  const output = H.hook(h, 'after-tool', { cwd: p, session_id: 'agent', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'actual-agent', tool_input: input, tool_response: { content: [{ type: 'text', text: '已独立审查\n问题 0 条' }] } });
  H.ok('真实完成事件立即登记兼容审查', S.reviewRecord('code', d) && S.reviewRecord('code', d).executor === 'agent', output);
  const transcript = H.transcript(path.join(h.root, 'agent.jsonl'), [H.tr.user('审代码'), H.tr.ran('Agent', input, '结论：问题 0 条')]);
  const sync = H.node(h, path.join(h.kit, 'tools/review.js'), ['sync', '--project', p, '--transcript', transcript]);
  H.ok('可核对记录可显式补登记', sync.code === 0 && /已识别完整结论/.test(sync.out), sync);
  H.done('1013 审查诊断、材料与兼容结果');
})();
