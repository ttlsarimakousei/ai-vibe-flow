'use strict';

// 月度门店销售汇总
//   node src/report.js --month 2026-08                  从 metrics agent 拉实时明细
//   node src/report.js --month 2026-08 --source <file>  改用一份已导出的明细快照
//   node src/report.js --month 2026-08 --json           只打印 JSON，方便贴到别处

const fs = require('fs');
const path = require('path');
const { aggregate, parseJsonl } = require('./stats');
const { fetchMonth } = require('./fetch-metrics');

function parseArgs(argv) {
  const a = { month: '2026-08', source: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--month') a.month = argv[++i];
    else if (t === '--source') a.source = argv[++i];
    else if (t === '--json') a.json = true;
    else if (t === '-h' || t === '--help') a.help = true;
  }
  return a;
}

const USAGE = [
  '用法: node src/report.js [选项]',
  '  --month <YYYY-MM>   统计月份，默认 2026-08',
  '  --source <file>     从本地明细快照读取，跳过 metrics agent（快照见 data/）',
  '  --json              只输出 JSON',
].join('\n');

async function loadRecords(args) {
  if (args.source) {
    const p = path.isAbsolute(args.source) ? args.source : path.join(process.cwd(), args.source);
    return parseJsonl(fs.readFileSync(p, 'utf8'));
  }
  return fetchMonth(args.month);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const records = await loadRecords(args);
  const result = aggregate(records, args.month);

  if (args.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log('月份       : ' + result.month);
  console.log('成交单数   : ' + result.orderCount);
  console.log('成交金额   : ' + result.totalAmount);
  console.log('涉及门店数 : ' + result.storeCount);
  console.log('销冠门店   : ' + result.topStore + ' (' + result.topStoreAmount + ')');
}

main().catch((e) => {
  console.error('[report] 失败: ' + (e && e.message ? e.message : e));
  if (e && e.detail) console.error('[report] detail: ' + e.detail);
  if (e && e.hint) console.error('[report] hint: ' + e.hint);
  process.exitCode = 1;
});
