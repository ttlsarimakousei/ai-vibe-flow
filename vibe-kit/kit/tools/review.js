'use strict';
/* 审查脚本的命令行：备材料（prepare）、看结果（status）、取消、登记处理结果。审查本身是子代理 vk-reviewer 做的，这里不发请求。 */
const R = require('../lib/review-runner');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
// --base 可以写几次（几个仓库各写一个：--base <仓库相对路径>=<提交>，#189）
const bases = args.flatMap((a, i) => (a === '--base' && args[i + 1] ? [args[i + 1]] : []));
const opts = { cwd: val('--project') || process.cwd(), change: val('--change'), mode: val('--mode') || 'code', point: val('--point'), base: bases.length > 1 ? bases : bases[0], budgetSeconds: val('--budget'), full: args.includes('--full'), decisions: val('--decisions'), reason: val('--reason') };
// #197：以前 --help 只有一行，没说 --change 必须是 openspec/changes 下已有的变更，也没写不走 OpenSpec 的改动怎么审
const HELP = [
  '用法：node review.js <prepare|status|cancel|resolve> [参数]',
  '',
  'prepare：备一轮审查（run 是它的别名）。不发请求，输出每个子代理的提示；照它开 vk-reviewer',
  '  OpenSpec 变更的需求文档：prepare --change <变更名> --mode proposal --point tasks --project <项目>（四份写完审一次整套；用户点名审单份的，--point 写 proposal、specs 或 design）',
  '  OpenSpec 变更的代码：    prepare --change <变更名> --mode code --point change --project <项目> [--base <改之前的提交>]（任务全部做完审一次整个 change；用户点名审某一组的，--point 写 group-1 这样的组号）',
  '  不走 OpenSpec 的改动：   prepare --mode code --project <项目> --base <改之前的提交>（不带 --change；--change 只认 openspec/changes 下已有的变更）',
  '  壳子里几个仓库：         --base 写几次，每个仓库一个：--base <仓库相对路径>=<提交>，例 --base gwjh=11325fd --base .=32171c4',
  '                           只写一个不带等号的 --base：只用在认得这个提交的仓库上，其余仓库用开工时登记的基线',
  '  第一轮按材料大小开 1～3 个子代理，后面的轮只审改过的地方；--full 整份再审一遍（用户要求全量再审时才用）',
  '  其它：--budget <秒> 这一次的预期用时（不截断，超了自动记问题反馈）',
  'status / cancel：和 prepare 一样的 --change、--mode、--point（不带变更名的再加同样的 --base），看结果或取消',
  'resolve：--change <变更名> --mode proposal|code --point <审查点> --decisions <处理明细 JSON>',
  '  action：fixed 修了（P1、P2 修了要再审一轮，P3 不用）、rejected 不成立、accepted 用户定了不改、deferred 实现细节留给后面的文档（只有用户点名审单份文档时能用；审整套的 --point tasks 没有后面的文档，不能用）',
  '  不走 OpenSpec 的审查（prepare 时没带 --change）：resolve --mode code --project <项目> --decisions <处理明细 JSON>，决定记进 .vibe/reviews/plain/code.json',
].join('\n');
(async () => {
  const cmd = args[0] || 'status'; let r;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }
  if (cmd === 'prepare' || cmd === 'run') r = R.prepare(opts);
  else if (cmd === 'status') r = R.status(opts);
  else if (cmd === 'cancel') r = R.cancel(opts);
  else if (cmd === 'resolve') r = R.resolve(opts);
  else throw new Error(HELP);
  console.log(JSON.stringify(r)); if (['failed', 'timed_out', 'partial', 'stale', 'interrupted'].includes(r.status)) process.exitCode = 1;
})().catch((e) => { console.error(require('../lib/redact').text(e.message)); process.exitCode = 1; });
