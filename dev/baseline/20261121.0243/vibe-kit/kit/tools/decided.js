'use strict';
/*
 * 提问框没人回、到点让模型自己定的，定了之后用这个登记一句（问题表第 94 条）：
 *   node decided.js --file <.vibe/auto-decisions.json> --id <编号> --text "<定了什么>" --why "<理由>"
 * 编号、文件路径在 ask-timeout 收掉提问框时给的那句话里。大任务全部做完时，收工钩子把这些一起列给用户。
 * 只写这一个文件。没给 --file 从当前目录往上找。
 */
const AD = require('../lib/auto-decisions');
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const HELP = '用法：node decided.js --file <.vibe/auto-decisions.json> --id <编号> --text "<这一问你定了什么>" --why "<理由>"';
try {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
  const file = val('--file') || AD.findFile(process.cwd());
  const id = Number(val('--id'));
  const text = String(val('--text') || '').trim();
  if (!file || !(id > 0) || !text) { console.error(HELP + (file ? '' : '\n没找到 .vibe/auto-decisions.json，--file 写全路径')); process.exit(1); }
  const r = AD.fill(file, id, text, String(val('--why') || '').trim());
  console.log(JSON.stringify(r));
  if (!r.ok) process.exitCode = 1;
} catch (e) { console.error((e && e.message) || String(e)); process.exitCode = 1; }
