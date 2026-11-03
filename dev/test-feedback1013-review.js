'use strict';
/* #68、#71、#75、#76、#84、#85、#91、#92：模拟回包、分片覆盖及真实代理完成事件。旧版应检出解析和材料反例。 */
const fs = require('fs'); const path = require('path'); const http = require('http');
const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('feedback1013-review', process.argv[2]);
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'openspec/changes/add-a/tasks.md': '- [ ] 1.1 修改 a.js；验：node --check a.js\n', 'openspec/changes/add-a/proposal.md': '参考 src/area、src/large.js\n' });
  const d = path.join(p, 'openspec/changes/add-a'); const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner'));
  const redact = require(path.join(h.kit, 'lib/redact'));
  for (const field of ['password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'authorization']) {
    const source = JSON.stringify({ [field]: 'FAKE_QUOTED_"_SECRET', input_tokens: 42 });
    const masked = redact.material(source);
    H.ok('JSON 字面凭据脱敏含转义引号：' + field, !masked.includes('FAKE_QUOTED') && !masked.includes('_SECRET') && masked.includes('"input_tokens":42'), masked);
  }
  H.ok('审查鉴权逻辑原样保留', redact.material('token = validate(input); authorization = getAuth(req);') === 'token = validate(input); authorization = getAuth(req);');
  for (const field of ['dbPassword', 'accessToken', 'clientSecret']) H.ok('保留复合凭据字段的脱敏：' + field, !redact.material(field + ' = "FAKE_COMPOSITE_VALUE"').includes('FAKE_COMPOSITE_VALUE'));
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
  const bp = R.prepare({ cwd: p, change: 'add-a', mode: 'proposal' });
  const badText = '审查任务：' + bp.id + '/' + bp.agents[0].lens + '\n正文错误 password="FAKE_REVIEW_SECRET"';
  const bad = R.submit(bp.id, bp.agents[0].lens, badText);
  H.ok('回复不是 JSON：不入账，说清楚', bad.ok === false && /JSON/.test(bad.error) && R.status({ cwd: p, change: 'add-a', mode: 'proposal' }).status === 'running', bad);
  H.ok('诊断不含假秘密', !JSON.stringify(R.status({ cwd: p, change: 'add-a', mode: 'proposal' })).includes('FAKE_REVIEW_SECRET'));
  const scope = H.read(/范围文件：(.+)/.exec(bp.agents[0].prompt)[1].trim());
  H.ok('范围文件要求 JSON，不带材料原文', /JSON/.test(scope) && !scope.includes('FAKE_REVIEW_BOUNDARY_VALUE'), scope.slice(0, 300));
  const full = await H.fakeReview(R, { cwd: p, change: 'add-a', mode: 'proposal' }, () => ({ issues: [{ file: 'not-in-batch.js', problem: '范围外文件的问题', evidence: '模拟依据' }] }));
  H.ok('角度交齐后完整覆盖大文件', full.status === 'completed' && full.covered.filter((f) => f === 'src/large.js').length === 1, full.status);
  H.ok('报到材料之外的文件也算（子代理自己会读，连带影响常在别的文件）', full.issues.some((x) => x.file === 'not-in-batch.js'), full.issues);
  H.done('1013 审查诊断、材料与兼容结果');
})();
