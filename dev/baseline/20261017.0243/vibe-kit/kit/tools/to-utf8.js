'use strict';
/*
 * 把一个 GBK 文件转成 UTF-8（无 BOM）。转前备份，转后读回来逐字比对，对不上就还原。
 * 用法：node to-utf8.js <文件>
 * 只转"严格按 UTF-8 解不开、严格按 GBK 能解开"的文件，其他情况一律不动。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = process.argv[2];
if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { console.error('用法：node to-utf8.js <文件>'); process.exit(2); }
const buf = fs.readFileSync(file);
try { new TextDecoder('utf-8', { fatal: true }).decode(buf); console.log('已经是 UTF-8，没动：' + file); process.exit(0); } catch (e) { /* 继续 */ }
let text;
try { text = new TextDecoder('gbk', { fatal: true }).decode(buf); } catch (e) { console.error('按 GBK 也解不开，没动：' + file); process.exit(1); }

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
// 备份跟着套件的安装位置走（本文件在 <套件>/tools/ 下）。放在 backup/to-utf8/ 下，和安装器自己的备份分开：
// 安装器的备份只留最近 20 份，转的文件恰好叫 CLAUDE.md、settings.json 时会被当成安装器的备份轮转删掉
const backupDir = path.join(__dirname, '..', 'backup', 'to-utf8', stamp);
fs.mkdirSync(backupDir, { recursive: true });
// 同一秒里转两个同名文件时不能互相覆盖：目标已存在就加序号
let backup;
for (let n = 0; ; n++) {
  backup = path.join(backupDir, (n ? n + '-' : '') + path.basename(file));
  try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); break; } catch (e) { if (e.code !== 'EEXIST' || n > 99) throw e; }
}

fs.writeFileSync(file, Buffer.from(text, 'utf8'));
const back = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
if (back !== text) {
  fs.copyFileSync(backup, file);
  console.error('写回后内容对不上，已还原：' + file);
  process.exit(1);
}
const cjk = (text.match(/[一-鿿]/g) || []).length;
console.log('已转成 UTF-8：' + file + '（' + cjk + ' 个汉字，备份在 ' + backup + '）');
