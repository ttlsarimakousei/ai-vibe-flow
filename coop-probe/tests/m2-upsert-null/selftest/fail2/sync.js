'use strict';

// 把上游导出的商品快照同步到本地库存表。
// 改成：sku 一样的更新，找不到的新增。

const { loadTable, saveTable } = require('./lib/table');

const FIELDS = ['sku', 'name', 'qty', 'price'];

function pick(row) {
  const o = {};
  for (const f of FIELDS) o[f] = row[f];
  return o;
}

function main() {
  const source = loadTable('source');
  const target = loadTable('target');

  let updated = 0;
  let inserted = 0;

  for (const row of source) {
    const i = target.findIndex(function (r) { return r.sku === row.sku; });
    if (i >= 0) {
      Object.assign(target[i], pick(row));
      updated++;
    } else {
      target.push(pick(row));
      inserted++;
    }
  }

  saveTable('target', target);
  console.log('同步完成：更新 ' + updated + ' 行，新增 ' + inserted + ' 行，目标表现有 ' + target.length + ' 行');
}

main();
