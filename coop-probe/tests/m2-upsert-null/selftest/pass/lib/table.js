'use strict';

// 迷你"表"存取层：一张表就是 data/<名字>.json，里面 rows 是行数组。
// 没有数据库，也不许有第三方依赖，够用就行。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function tablePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function loadTable(name) {
  const raw = fs.readFileSync(tablePath(name), 'utf8');
  const obj = JSON.parse(raw);
  return Array.isArray(obj.rows) ? obj.rows : [];
}

function saveTable(name, rows) {
  const body = { table: name, rows: rows };
  fs.writeFileSync(tablePath(name), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

// 上游导出的编码有时带前后空格、大小写也不统一，比对之前统一成规范形式。
function normKey(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toUpperCase();
}

// 按某个字段给行建索引，方便按键定位。
function indexByKey(rows, field) {
  const m = new Map();
  for (const r of rows) {
    const k = normKey(r[field]);
    if (!k) continue;
    m.set(k, r);
  }
  return m;
}

module.exports = { tablePath, loadTable, saveTable, normKey, indexByKey };
