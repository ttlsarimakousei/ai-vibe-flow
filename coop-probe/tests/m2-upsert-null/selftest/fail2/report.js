'use strict';

// 打印目标表的概况，仓库那边每天看一眼。

const { loadTable, indexByKey } = require('./lib/table');

function main() {
  const target = loadTable('target');
  const idx = indexByKey(target, 'sku');

  let qty = 0;
  let amount = 0;
  for (const r of target) {
    qty += Number(r.qty) || 0;
    amount += (Number(r.qty) || 0) * (Number(r.price) || 0);
  }

  console.log('目标表共 ' + target.length + ' 行');
  console.log('可按 sku 定位的品种数：' + idx.size);
  console.log('总件数：' + qty + '，总金额：' + amount.toFixed(2));
}

main();
