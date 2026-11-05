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
  {
    const scopes = [];
    const r = await H.fakeReview(R, opts, (l, s) => { scopes.push(s); return { issues: [], summary: '提供的材料已审' }; });
    H.ok('明确范围审查可完整完成', r.status === 'completed' && r.covered.length === 7, r.status);
    H.ok('报告保留探索路径清单', r.contextOnly && r.contextOnly.length === 29);
    H.ok('范围文件没列非指定探索源码', !scopes.join('').includes('src/read-0.js') && scopes.join('').includes('src/read-29.js'), scopes.join('').slice(0, 600));
    H.ok('范围文件不带材料原文，假凭据不外流', !scopes.join('').includes('FAKE_CONTEXT_SECRET'));
    H.ok('原材料下的提案审查有效', S.proposalReviewed(d));
    H.write(path.join(d, 'assets/example.json'), '{"example":false}');
    H.ok('补充材料修改后旧结论失效', !S.proposalReviewed(d));
    const noMaterial = R.prepare({ cwd: p, mode: 'code' });
    H.ok('确无材料时不开子代理', !noMaterial.pending && noMaterial.status !== 'completed', noMaterial);
  }
  H.done('1013 提案探索材料范围');
})().catch(e => { console.error(e); H.cleanup(); process.exitCode = 1; });
