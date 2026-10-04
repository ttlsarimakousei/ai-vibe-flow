'use strict';

// 把上游导出的商品快照同步到本地库存表。
// 改成：sku 能对上的更新，对不上的新增。

const { loadTable, saveTable, normKey, indexByKey } = require('./lib/table');

const FIELDS = ['sku', 'name', 'qty', 'price'];

function pick(row) {
  const o = {};
  for (const f of FIELDS) o[f] = row[f];
  return o;
}

function main() {
  const source = loadTable('source');
  const target = loadTable('target');
  const idx = indexByKey(target, 'sku');

  let updated = 0;
  let inserted = 0;

  for (const row of source) {
    const k = normKey(row.sku);
    const hit = idx.get(k);
    if (hit) {
      Object.assign(hit, pick(row));
      updated++;
    } else {
      const nr = pick(row);
      target.push(nr);
      idx.set(k, nr);
      inserted++;
    }
  }

  saveTable('target', target);
  console.log('同步完成：更新 ' + updated + ' 行，新增 ' + inserted + ' 行，目标表现有 ' + target.length + ' 行');
}

main();
