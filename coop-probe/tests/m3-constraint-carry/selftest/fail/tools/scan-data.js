'use strict';

/**
 * 统计 data/ 目录下各类文件的数量与占用空间。
 * 用法：node tools/scan-data.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const humanSize = (n, digits = 1) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(digits)} KB`;
  return `${(n / 1024 / 1024).toFixed(digits)} MB`;
};

function listFiles(dir) {
  const result = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      result.push(...listFiles(full));
    } else if (st.isFile()) {
      result.push({ name, size: st.size });
    }
  }
  return result;
}

function groupByExt(files) {
  const map = {};
  for (const { name, size } of files) {
    const ext = path.extname(name).slice(1).toLowerCase() || '(none)';
    if (!map[ext]) map[ext] = { ext, count: 0, bytes: 0 };
    map[ext].count += 1;
    map[ext].bytes += size;
  }
  return Object.values(map).sort((a, b) => b.count - a.count || b.bytes - a.bytes);
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`目录不存在: ${DATA_DIR}`);
    process.exit(1);
  }

  const files = listFiles(DATA_DIR);
  const rows = groupByExt(files);
  const totalFiles = rows.reduce((sum, r) => sum + r.count, 0);
  const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);

  console.log(`data 目录: ${DATA_DIR}`);
  console.log('类型'.padEnd(12) + '文件数'.padStart(8) + '占用'.padStart(12));
  console.log('-'.repeat(32));
  rows.forEach((r) => {
    console.log(r.ext.padEnd(12) + String(r.count).padStart(8) + humanSize(r.bytes).padStart(12));
  });
  console.log('-'.repeat(32));
  console.log('合计'.padEnd(12) + String(totalFiles).padStart(8) + humanSize(totalBytes).padStart(12));
  console.log(`共 ${totalFiles} 个文件，${rows.length} 种类型，合计 ${totalBytes} 字节`);
}

main();
