'use strict';

const fs = require('fs');
const path = require('path');
const { formatReport } = require('./src/format');

const snapshot = path.join(__dirname, 'dist', 'report.json');

if (!fs.existsSync(snapshot)) {
  console.error('没有找到 dist/report.json，请先执行: node build.js');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
console.log(formatReport(report));
