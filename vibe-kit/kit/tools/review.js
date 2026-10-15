'use strict';
/* 限时审查与兼容记账入口。sync 仅登记会话中可核对的完整结果，诊断不输出提示词或审查正文；不调用 Claude CLI 或自主子代理。 */
const R = require('../lib/review-runner');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const opts = { cwd: val('--project') || process.cwd(), change: val('--change'), mode: val('--mode') || 'code', point: val('--point'), base: val('--base'), budgetSeconds: val('--budget'), newBudget: args.includes('--new-budget'), decisions: val('--decisions'), reason: val('--reason') };
(async () => {
  const cmd = args[0] || 'status'; let r;
  if (cmd === 'run') r = await R.run(opts, (s) => process.stderr.write(s + '\n'));
  else if (cmd === 'diagnose' || cmd === 'sync') {
    const S = require('../lib/session'); if (!val('--transcript')) throw new Error('诊断和记账要给 --transcript <当前会话记录>');
    const entries = S.tailEntries(val('--transcript'), cmd === 'sync' ? 16000000 : 3000000);
    if (cmd === 'sync') S.syncReviews(entries, opts.cwd);
    r = { records: S.reviewDiagnostics(entries, opts.cwd), note: cmd === 'sync' ? '只登记真实调用与完整结论，失败、迟到或缺失证据不会补成通过。' : '只读最近会话中的兼容审查；默认独立审查用 status 核对，不自动补记通过。' };
  } else if (cmd === 'status') r = R.status(opts);
  else if (cmd === 'cancel') r = R.cancel(opts);
  else if (cmd === 'resolve') r = R.resolve(opts);
  else if (cmd === 'waive') r = R.waive(opts);
  else throw new Error('用法：review.js run|status|diagnose|sync|cancel|resolve|waive --change <变更> --mode proposal|code；waive 还要 --reason <用户决定的原因>');
  console.log(JSON.stringify(r)); if (['failed', 'timed_out', 'partial', 'stale', 'interrupted'].includes(r.status)) process.exitCode = 1;
})().catch((e) => { console.error(require('../lib/redact').text(e.message)); process.exitCode = 1; });
