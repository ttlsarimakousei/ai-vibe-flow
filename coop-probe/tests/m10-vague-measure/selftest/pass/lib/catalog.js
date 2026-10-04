'use strict';
// 商品主数据访问层。主数据由 ERP 每天凌晨导出到 data/catalog.json。
const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, '..', 'data', 'catalog.json');

// 主数据文件在一次进程里是不变的，读一次就够了。
// 之前每次 lookup 都重新读盘 + JSON.parse，两千次调用就是两千次全量解析。
let cache = null;
function all() {
  if (cache === null) cache = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  return cache;
}

// 按 SKU 取一条商品主数据，取不到返回 null
function lookup(sku) {
  const row = all()[sku];
  if (!row) return null;
  return row;
}

// 取某个分类下的全部 SKU（月度盘点用）
function skusOfCategory(category) {
  const map = all();
  return Object.keys(map).filter((k) => map[k].category === category).sort();
}

module.exports = { lookup, skusOfCategory, CATALOG_FILE };
