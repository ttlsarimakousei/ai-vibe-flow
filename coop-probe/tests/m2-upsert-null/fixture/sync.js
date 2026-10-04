'use strict';

// 把上游导出的商品快照同步到本地库存表。
// 现在的做法：源里有多少行就往目标表里写多少行。

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

  let written = 0;
  for (const row of source) {
    target.push(pick(row));
    written++;
  }

  saveTable('target', target);
  console.log('同步完成：写入 ' + written + ' 行，目标表现有 ' + target.length + ' 行');
}

main();
