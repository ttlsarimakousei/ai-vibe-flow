'use strict';
/* 独立审查与兼容记账入口（2026-10-28 起不限时：配置页的秒数是预期用时，超了记问题反馈）。sync 仅登记会话中可核对的完整结果，诊断不输出提示词或审查正文；不调用 Claude CLI 或自主子代理。 */
const R = require('../lib/review-runner');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
// --base 可以写几次（几个仓库各写一个：--base <仓库相对路径>=<提交>，#189）
const bases = args.flatMap((a, i) => (a === '--base' && args[i + 1] ? [args[i + 1]] : []));
const opts = { cwd: val('--project') || process.cwd(), change: val('--change'), mode: val('--mode') || 'code', point: val('--point'), base: bases.length > 1 ? bases : bases[0], budgetSeconds: val('--budget'), newBudget: args.includes('--new-budget'), decisions: val('--decisions'), reason: val('--reason') };
// #197：以前 --help 只有一行，没说 --change 必须是 openspec/changes 下已有的变更，也没写不走 OpenSpec 的改动怎么审
const HELP = [
  '用法：node review.js <run|status|cancel|resolve|diagnose|sync|waive> [参数]',
  '',
  'run：审一次（经本机路由向独立模型发有限材料）',
  '  OpenSpec 变更的需求文档：run --change <变更名> --mode proposal --point proposal|specs|design|tasks --project <项目>',
  '  OpenSpec 变更的代码：    run --change <变更名> --mode code --point group-1 --project <项目> [--base <改之前的提交>]',
  '  不走 OpenSpec 的改动：   run --mode code --project <项目> --base <改之前的提交>（不带 --change；--change 只认 openspec/changes 下已有的变更）',
  '  壳子里几个仓库：         --base 写几次，每个仓库一个：--base <仓库相对路径>=<提交>，例 --base gwjh=11325fd --base .=32171c4',
  '                           只写一个不带等号的 --base：只用在认得这个提交的仓库上，其余仓库用开工时登记的基线',
  '  其它：--budget <秒> 这一次的预期用时（不截断，超了自动记问题反馈）；--new-budget 不再需要（没有累计预算了）',
  'status / cancel：和 run 一样的 --change、--mode、--point（不带变更名的再加同样的 --base），看进度或取消',
  'resolve：--change <变更名> --mode proposal|code --point <审查点> --decisions <处理明细 JSON>',
  '  不走 OpenSpec 的审查（run 时没带 --change）：resolve --mode code --project <项目> --decisions <处理明细 JSON>，决定记进 .vibe/reviews/plain/code.json',
  'diagnose / sync：--project <项目> --transcript <当前会话记录>，看兼容审查代理的结果、补登记能核对的完整结论',
].join('\n');
(async () => {
  const cmd = args[0] || 'status'; let r;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }
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
  else throw new Error(HELP);
  console.log(JSON.stringify(r)); if (['failed', 'timed_out', 'partial', 'stale', 'interrupted'].includes(r.status)) process.exitCode = 1;
})().catch((e) => { console.error(require('../lib/redact').text(e.message)); process.exitCode = 1; });
