'use strict';
/* #100、#103：探索清单不自动扩成材料，明确指定的文件和随提案材料仍发送；用假路由核对实际请求。 */
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('feedback1013-context', process.argv[2]);
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'openspec/changes/add-a/proposal.md': '# 提案\n', 'openspec/changes/add-a/tasks.md': '- [ ] 1.1 实现\n', 'openspec/changes/add-a/specs/a/spec.md': '# 规格\n' });
  const d = path.join(p, 'openspec/changes/add-a');
  const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner'));
  for (let i = 0; i < 30; i++) H.write(path.join(p, 'src/read-' + i + '.js'), 'const source=' + i + ';\n');
  H.write(path.join(p, 'src/required.js'), 'const required=1;\n');
  H.write(path.join(d, 'assets/example.json'), '{"example":true}\n');
  const context = Array.from({ length: 30 }, (_, i) => '- 读过 src/read-' + i + '.js').join('\n');
  const opts = { cwd: p, change: 'add-a', mode: 'proposal', newBudget: true };
  const collect = () => R.materials(opts, S.allChanges(p)[0]);
  for (const title of ['Context', 'Context（现状）', '现状', '背景']) {
    H.write(path.join(d, 'design.md'), '# 设计\n## ' + title + '\n### 已读文件\n' + context + '\n## Decisions\n采用既有接口。\n');
    const m = collect();
    H.ok(title + '：只发送四份核心产物', new Set(m.items.map(x => x.file)).size === 4 && m.skipped.length === 0, m.skipped);
    H.ok(title + '：明确列出只作探索依据的路径', m.contextOnly && m.contextOnly.length === 30);
  }
  H.write(path.join(d, 'design.md'), '# 设计\n## Context\n' + context + '\n审查材料：src/read-29.js\n## Decisions\n审查材料：src/required.js\n参考 assets/example.json\n');
  let m = collect();
  H.ok('探索内显式材料可以选择', m.items.some(x => x.file === 'src/read-29.js'));
  H.ok('其它章节当前引用仍送审', m.items.some(x => x.file === 'src/required.js'));
  H.ok('随提案的非敏感材料实际送审', m.items.some(x => x.file === 'assets/example.json'));
  H.ok('已选中的材料不再列为仅探索', m.contextOnly && m.contextOnly.length === 29 && !m.contextOnly.includes('src/read-29.js'));
  const design = H.read(path.join(d, 'design.md'));
  H.write(path.join(d, 'design.md'), design + '\n审查材料：src/missing.js、src\n');
  m = collect();
  H.ok('明确指定的缺失文件不静默漏掉', m.skipped.some(x => x.file === 'src/missing.js'));
  H.write(path.join(d, 'design.md'), design);
  H.write(path.join(d, 'assets/example.json'), '{"password":"FAKE_CONTEXT_SECRET","example":true}');
  let calls = 0; const bodies = [];
  const server = http.createServer((req, res) => { let text = ''; req.on('data', b => text += b); req.on('end', () => { calls++; bodies.push(text); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ issues: [], summary: '提供的材料已审' }) }] })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const oldPort = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
  try {
    const r = await R.run(opts);
    H.ok('明确范围审查可完整完成', r.status === 'completed' && r.covered.length === 7, r.status);
    H.ok('报告保留探索路径清单', r.contextOnly && r.contextOnly.length === 29);
    const sent = bodies.flatMap(b => JSON.parse(JSON.parse(b).messages[0].content.split('\n本批材料：\n')[1]));
    H.ok('实际请求未读取非指定探索源码', !sent.some(x => x.file === 'src/read-0.js') && sent.some(x => x.file === 'src/read-29.js'));
    H.ok('补充材料仍遮盖假凭据', !bodies.join('').includes('FAKE_CONTEXT_SECRET'));
    H.ok('原材料下的提案审查有效', S.proposalReviewed(d));
    H.write(path.join(d, 'assets/example.json'), '{"example":false}');
    H.ok('补充材料修改后旧结论失效', !S.proposalReviewed(d));
    H.setConfig(h, { reviewMaxFiles: 4 });
    const partial = await R.run(opts);
    H.ok('必要材料超过限额仍明确部分覆盖', partial.status === 'partial' && partial.skipped.some(x => /required/.test(x.file)));
    const before = calls;
    const noMaterial = await R.run({ cwd: p, mode: 'code', newBudget: true });
    H.ok('确无材料时不发请求', calls === before && noMaterial.attemptedBatches === 0 && noMaterial.status !== 'completed');
  } finally { if (oldPort === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = oldPort; server.closeAllConnections(); await new Promise(r => server.close(r)); }
  H.done('1013 提案探索材料范围');
})().catch(e => { console.error(e); H.cleanup(); process.exitCode = 1; });
