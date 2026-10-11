'use strict';
/* 限时审查入口。run/status/cancel/resolve 共用同一份本机记录，不调用 Claude CLI 或自主子代理。 */
const R = require('../lib/review-runner');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const opts = { cwd: val('--project') || process.cwd(), change: val('--change'), mode: val('--mode') || 'code', base: val('--base'), budgetSeconds: val('--budget'), newBudget: args.includes('--new-budget'), decisions: val('--decisions') };
(async () => { const cmd = args[0] || 'status'; let r; if (cmd === 'run') r = await R.run(opts, (s) => process.stderr.write(s + '\n')); else if (cmd === 'status') r = R.status(opts); else if (cmd === 'cancel') r = R.cancel(opts); else if (cmd === 'resolve') r = R.resolve(opts); else throw new Error('用法：review.js run|status|cancel|resolve --change <变更> --mode proposal|code'); console.log(JSON.stringify(r)); if (['failed', 'timed_out', 'partial', 'stale', 'interrupted'].includes(r.status)) process.exitCode = 1; })().catch((e) => { console.error(require('../lib/redact').text(e.message)); process.exitCode = 1; });
