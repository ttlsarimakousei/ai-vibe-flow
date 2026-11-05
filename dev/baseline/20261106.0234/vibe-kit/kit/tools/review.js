'use strict';
/* 审查脚本的命令行：审一轮（run，后台调 claude -p，等结果）、看结果（status）、取消、登记处理结果。worker 是 run 起的后台进程。 */
const R = require('../lib/review-runner');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
// --base 可以写几次（几个仓库各写一个：--base <仓库相对路径>=<提交>，#189）
const bases = args.flatMap((a, i) => (a === '--base' && args[i + 1] ? [args[i + 1]] : []));
const opts = { cwd: val('--project') || process.cwd(), change: val('--change'), mode: val('--mode') || 'code', point: val('--point'), base: bases.length > 1 ? bases : bases[0], budgetSeconds: val('--budget'), waitSeconds: val('--wait'), full: args.includes('--full'), decisions: val('--decisions'), reason: val('--reason') };
// #197：以前 --help 只有一行，没说 --change 必须是 openspec/changes 下已有的变更，也没写不走 OpenSpec 的改动怎么审
const HELP = [
  '用法：node review.js <prepare|status|cancel|resolve> [参数]',
  '',
  'run：审一轮（prepare 是它的别名）。脚本备好材料，后台调 claude -p，等结果，结论在输出里。Bash 的 timeout 写 600000。最多等 9 分钟，返回 running 就再跑一次一样的命令接着等，不会重开',
  '  OpenSpec 变更的需求文档：run --change <变更名> --mode proposal --point tasks --project <项目>（四份写完审一次整套；用户点名审单份的，--point 写 proposal、specs 或 design）',
  '  OpenSpec 变更的代码：    run --change <变更名> --mode code --point change --project <项目> [--base <改之前的提交>]（任务全部做完审一次整个 change；用户点名审某一组的，--point 写 group-1 这样的组号）',
  '  不走 OpenSpec 的改动：   run --mode code --project <项目> --base <改之前的提交>（不带 --change；--change 只认 openspec/changes 下已有的变更）',
  '  壳子里几个仓库：         --base 写几次，每个仓库一个：--base <仓库相对路径>=<提交>，例 --base gwjh=11325fd --base .=32171c4',
  '                           只写一个不带等号的 --base：只用在认得这个提交的仓库上，其余仓库用开工时登记的基线',
  '  第一轮按材料大小 1～3 个角度，后面的轮只审改过的地方；--full 整份再审一遍（用户要求全量再审时才用）',
  '  其它：--budget <秒> 这一次的预期用时（不截断，超了自动记问题反馈）',
  'status / cancel：和 run 一样的 --change、--mode、--point（不带变更名的再加同样的 --base），看结果或取消',
  'resolve：--change <变更名> --mode proposal|code --point <审查点> --decisions <处理明细 JSON>',
  '  action：fixed 修了（P1、P2 修了要再审一轮，P3 不用）、rejected 不成立、accepted 用户定了不改、deferred 实现细节留给后面的文档（只有用户点名审单份文档时能用；审整套的 --point tasks 没有后面的文档，不能用）',
  '  不走 OpenSpec 的审查（run 时没带 --change）：resolve --mode code --project <项目> --decisions <处理明细 JSON>，决定记进 .vibe/reviews/plain/code.json',
].join('\n');
(async () => {
  const cmd = args[0] || 'status'; let r;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }
  if (cmd === 'worker') { R.work(args[1], args[2]); return; }
  // VIBE_KIT_REVIEW_NO_RUN：只备材料不起进程，测试用
  if (cmd === 'prepare' || cmd === 'run') r = process.env.VIBE_KIT_REVIEW_NO_RUN ? R.prepare(opts) : R.run(opts);
  else if (cmd === 'status') r = R.status(opts);
  else if (cmd === 'cancel') r = R.cancel(opts);
  else if (cmd === 'resolve') r = R.resolve(opts);
  else throw new Error(HELP);
  console.log(JSON.stringify(r)); if (['failed', 'timed_out', 'partial', 'stale', 'interrupted'].includes(r.status)) process.exitCode = 1;
})().catch((e) => { console.error(require('../lib/redact').text(e.message)); process.exitCode = 1; });
