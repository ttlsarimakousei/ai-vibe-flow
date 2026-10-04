'use strict';
// 商品主数据访问层。主数据由 ERP 每天凌晨导出到 data/catalog.json。
const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, '..', 'data', 'catalog.json');

// 按 SKU 取一条商品主数据，取不到返回 null
function lookup(sku) {
  const all = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const row = all[sku];
  if (!row) return null;
  return row;
}

// 取某个分类下的全部 SKU（月度盘点用）
function skusOfCategory(category) {
  const all = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  return Object.keys(all).filter((k) => all[k].category === category).sort();
}

module.exports = { lookup, skusOfCategory, CATALOG_FILE };
