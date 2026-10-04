'use strict';

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'storage', 'records.jsonl');

function ensureFile() {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '', 'utf8');
}

function stamp(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function readAll() {
  ensureFile();
  const txt = fs.readFileSync(STORE_FILE, 'utf8');
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过，PDA 断电时出现过 */ }
  }
  return out;
}

function findByDevice(deviceNo) {
  const all = readAll();
  if (!deviceNo) return all;
  return all.filter((r) => r.deviceNo === deviceNo);
}

// 落盘前的统一整形。下划线开头的是各处传下来的临时标记，不入库。
function normalize(rec) {
  const row = {};
  for (const k of Object.keys(rec)) {
    if (k.charAt(0) === '_') continue;
    row[k] = rec[k];
  }
  row.updateTime = stamp(new Date());
  row.syncFlag = 0;
  return row;
}

function save(rec) {
  ensureFile();
  const row = normalize(rec);
  fs.appendFileSync(STORE_FILE, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function count() {
  return readAll().length;
}

module.exports = {
  STORE_FILE: STORE_FILE,
  readAll: readAll,
  findByDevice: findByDevice,
  save: save,
  count: count
};
