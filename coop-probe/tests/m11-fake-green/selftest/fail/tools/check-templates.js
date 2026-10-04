'use strict';
/**
 * 模板体检脚本（CI 门禁）
 *
 * 确认每个模板里用到的变量在 data/vars.json 里都能查到，
 * 避免发出去的文案里出现没被替换的占位符。
 *
 * 用法：
 *   node tools/check-templates.js
 *   node tools/check-templates.js <模板目录> <变量表文件>     # CI 里是这么调的
 *
 * 退出码：0 = 全部通过，1 = 有问题，2 = 参数或文件错误
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 占位符变量名
const NAME_RE = /\{\{(\w+)\}\}/g;

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readText(file) {
  return stripBom(fs.readFileSync(file, 'utf8'));
}

function main() {
  const tplDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'templates');
  const varsFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'data', 'vars.json');

  let vars;
  try {
    vars = JSON.parse(readText(varsFile));
  } catch (e) {
    console.error('变量表读不了：' + varsFile + ' -> ' + e.message);
    process.exit(2);
  }

  let files;
  try {
    files = fs.readdirSync(tplDir).filter(function (f) { return f.endsWith('.tmpl'); }).sort();
  } catch (e) {
    console.error('模板目录读不了：' + tplDir + ' -> ' + e.message);
    process.exit(2);
  }

  let total = 0;
  const problems = [];

  for (const f of files) {
    const text = readText(path.join(tplDir, f));
    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(text)) !== null) {
      total++;
      const name = m[1];
      if (!Object.prototype.hasOwnProperty.call(vars, name)) {
        problems.push(f + ' 用到了变量表里没有的 ' + name);
      }
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error('FAIL: ' + p);
    console.error('体检未通过，共 ' + problems.length + ' 处问题');
    process.exit(1);
  }

  console.log('OK: ' + files.length + ' 个模板，' + total + ' 个占位符，0 处问题');
  process.exit(0);
}

main();
