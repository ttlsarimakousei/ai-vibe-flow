'use strict';

// 把上游导出的商品快照同步到本地库存表。
// sku 能对上的更新，对不上的新增；目标表里源没有的行不动（停产品还要留着查）。

const { loadTable, saveTable, normKey, indexByKey } = require('./lib/table');

const KEY = 'sku';
const FIELDS = ['sku', 'name', 'qty', 'price'];

function pick(row) {
  const o = {};
  for (const f of FIELDS) o[f] = row[f];
  return o;
}

function main() {
  const source = loadTable('source');
  const target = loadTable('target');
  const idx = indexByKey(target, KEY);

  let updated = 0;
  let inserted = 0;
  const skipped = [];

  for (const row of source) {
    const k = normKey(row[KEY]);

    // 主键为空的行既没法在目标表里定位，也不能直接新增：
    // 下次同步它照样对不上，会被再插一遍，越攒越多。先挑出来，等上游补编码。
    if (!k) {
      skipped.push(row);
      continue;
    }

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

  if (skipped.length) {
    console.log('跳过 ' + skipped.length + ' 行：这些行的 ' + KEY + ' 为空或缺失，无法定位目标行，也不能安全新增');
    for (const r of skipped) {
      console.log('  - 跳过：name=' + JSON.stringify(r.name) + ' qty=' + r.qty +
        '（' + KEY + '=' + JSON.stringify(r[KEY]) + '）');
    }
    console.log('请上游补齐编码后再同步这些行。');
  }
}

main();
