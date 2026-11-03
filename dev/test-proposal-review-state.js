'use strict';
/* 独立提案审查绑定实质产物；打勾、交付摘要与实现进度不要求重复审提案，新增需求必须补审。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('proposal-review-state', process.argv[2]);
  const p = H.makeRepo(path.join(h.work, 'p'), { 'a.js': 'const a=1;\n', '.gitignore': '.vibe/\n', 'openspec/changes/add-x/proposal.md': '## Why\n实现确认的字段。\n', 'openspec/changes/add-x/design.md': '## Context\n已经核对当前工程。\n', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 实现 a.js；验：node a.js\n' });
  const S = require(path.join(h.kit, 'lib/session')); const file = path.join(h.kit, 'lib/review-runner.js');
  H.ok('独立审查模块随包提供', fs.existsSync(file)); if (!fs.existsSync(file)) { H.done('提案审查状态'); return; }
  const R = require(file); const dir = path.join(p, 'openspec/changes/add-x');
  {
    const opts = { cwd: p, change: 'add-x', mode: 'proposal' }; const result = await H.fakeReview(R, opts);
    H.ok('完整提案审查登记通过', result.status === 'completed' && S.proposalReviewed(dir), result);
    require(path.join(h.kit, 'lib/workflow')).deliver(p, 'add-x');
    H.ok('生成提案交付摘要不要求重审', S.proposalReviewed(dir));
    H.write(path.join(dir, 'tasks.md'), '- [x] 1.1 实现 a.js；验：node a.js\n'); H.write(path.join(p, 'a.js'), 'const a=2;\n');
    H.ok('实施代码与勾选进度不重开需求审查', S.proposalReviewed(dir));
    H.write(path.join(dir, 'proposal.md'), '## Why\n新增未审核的批量删除操作。\n');
    H.ok('审查后新增需求使旧结论失效', !S.proposalReviewed(dir));
    await H.fakeReview(R, opts); H.ok('当前提案重新完整审查后有效', S.proposalReviewed(dir));
    H.write(path.join(dir, 'tasks.md'), '- [x] 1.1 实现 a.js；验：node b.js\n');
    H.ok('任务验法变化使旧提案结论失效', !S.proposalReviewed(dir));
    await H.fakeReview(R, opts); H.write(path.join(dir, 'design.md'), '## Context\n改成调用另一个接口。\n');
    H.ok('设计变化使旧提案结论失效', !S.proposalReviewed(dir));
  }
  H.done('提案审查状态');
})().catch(e => { H.ok('提案状态测试异常', false, e.stack); H.done('提案审查状态'); });
