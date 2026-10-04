'use strict';
/*
 * 发版用：版本号取现在的时间（年月日.时分），把《更新说明.md》里的两处占位 @@VER@@ 换成它，再跑 pack.js 打包。
 * 《更新说明.md》里还没打包的那一版一直写 @@VER@@（标题一处、"先看你装的是哪一版"那张表一处），打包时才换：
 * 版本号不能比实际时间晚（发布时会被当成退回旧版），所以等真要打包的那一刻再定。
 *   node dev/stamp-and-pack.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const notes = path.join(REPO, 'vibe-kit', '更新说明.md');
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const version = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.' + p(d.getHours()) + p(d.getMinutes());
let t = fs.readFileSync(notes, 'utf8');
const n = t.split('@@VER@@').length - 1;
if (n !== 2) { console.log('《更新说明.md》里的占位 @@VER@@ 应该正好两处，现在是 ' + n + ' 处'); process.exit(1); }
t = t.split('@@VER@@').join(version);
fs.writeFileSync(notes, t);
console.log('版本号 ' + version);
const r = spawnSync(process.execPath, [path.join(__dirname, 'pack.js'), '--version', version], { stdio: 'inherit', windowsHide: true });
process.exit(r.status === null ? 1 : r.status);
