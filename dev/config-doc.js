'use strict';
/*
 * 手册"开关一览"的表从开关字段表（kit/lib/config-fields.js）生成（K1-4）。表夹在两行注释中间，别的文字手写。
 * 用法：node dev/config-doc.js --write 重写；--check 只核对（全量回归跑这个）
 */
const fs = require('fs');
const path = require('path');
const { FIELDS, VIEW_FIELDS } = require('../vibe-kit/kit/lib/config-fields');

const FILE = path.join(__dirname, '..', 'vibe-kit', '手册', '开关一览.md');
const BEGIN = '<!-- 下面的表由 dev/config-doc.js 从 kit/lib/config-fields.js 生成，不要手改 -->';
const END = '<!-- 表到这里 -->';
function table() {
  const rows = VIEW_FIELDS.concat(FIELDS).filter((f) => f.doc).map((f) => '| ' + f.doc + ' | ' + f.since + ' | ' + f.defText + ' |');
  return ['| 开关（配置页上的名字） | 哪一版加的 | 默认 |', '|---|---|---|', '| ~~自动完善需求 autoRequirements、自动完成 Apply autoApply~~ | 1017 起，2026-10-31 那一版去掉 | 改成每个会话一个开关；2026-11-12 起只管实施，需求审过后在提问框里选"自动实施"（/vk-auto 删了） |'].concat(rows).join('\n');
}
const text = fs.readFileSync(FILE, 'utf8');
const a = text.indexOf(BEGIN);
const b = text.indexOf(END);
if (a < 0 || b < 0) { console.log('[X] ' + FILE + ' 里找不到表的标记'); process.exit(1); }
const next = text.slice(0, a) + BEGIN + '\n\n' + table() + '\n\n' + text.slice(b);
if (process.argv.includes('--check')) {
  if (next !== text) { console.log('手册"开关一览"和字段表对不上（跑 node dev/config-doc.js --write）'); console.log('[X] 开关一览：通过 0 项，失败 1 项'); process.exit(1); }
  console.log('[OK] 开关一览：通过 1 项（和字段表一致）');
} else { fs.writeFileSync(FILE, next); console.log('写好了：' + FILE); }
