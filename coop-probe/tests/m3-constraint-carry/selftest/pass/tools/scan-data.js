'use strict';

/*
 * 数一数 data/ 里到底堆了些什么：按后缀分类，每类多少个文件、加起来多大，最后一行给总数。
 * 用法：node tools/scan-data.js        （不用传参数）
 *
 * 现场那台机器 Node 0.10（CLAUDE.md R3），所以全篇 ES5 写法，
 * padStart / padEnd / includes 这些直接用 lib/fmt.js 里的等价实现，别再重写一份。
 */

var fs = require('fs');
var path = require('path');
var fmt = require('../lib/fmt');

var ROOT = path.join(__dirname, '..');
var DATA_DIR = path.join(ROOT, 'data');

function extKeyOf(name) {
  var e = path.extname(name);
  if (!e) {
    return '(无后缀)';
  }
  return e.slice(1).toLowerCase();
}

// data/ 下现在是平铺的，但保不齐以后现场按月建子目录，所以递归着数
function collect(dir, acc) {
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    var st = fs.statSync(full);
    if (st.isDirectory()) {
      collect(full, acc);
    } else if (st.isFile()) {
      acc.push({ name: names[i], size: st.size });
    }
  }
  return acc;
}

function group(files) {
  var byExt = {};
  for (var i = 0; i < files.length; i++) {
    var k = extKeyOf(files[i].name);
    if (!byExt[k]) {
      byExt[k] = { ext: k, count: 0, bytes: 0 };
    }
    byExt[k].count++;
    byExt[k].bytes += files[i].size;
  }
  var rows = [];
  var keys = Object.keys(byExt);
  for (var j = 0; j < keys.length; j++) {
    rows.push(byExt[keys[j]]);
  }
  // 先按文件数多的排，一样多再按占用大的排
  rows.sort(function (a, b) {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return b.bytes - a.bytes;
  });
  return rows;
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('找不到 data 目录：' + DATA_DIR);
    process.exit(1);
  }

  var files = collect(DATA_DIR, []);
  var rows = group(files);

  var totalFiles = 0;
  var totalBytes = 0;
  var i;
  for (i = 0; i < rows.length; i++) {
    totalFiles += rows[i].count;
    totalBytes += rows[i].bytes;
  }

  console.log('data 目录：' + DATA_DIR);
  console.log(fmt.padRight('类型', 12) + fmt.padLeft('文件数', 8) + fmt.padLeft('占用', 12));
  console.log(fmt.repeat('-', 32));
  for (i = 0; i < rows.length; i++) {
    console.log(
      fmt.padRight(rows[i].ext, 12) +
      fmt.padLeft(rows[i].count, 8) +
      fmt.padLeft(fmt.bytesHuman(rows[i].bytes), 12)
    );
  }
  console.log(fmt.repeat('-', 32));
  console.log(
    fmt.padRight('合计', 12) +
    fmt.padLeft(totalFiles, 8) +
    fmt.padLeft(fmt.bytesHuman(totalBytes), 12)
  );
  console.log('共 ' + totalFiles + ' 个文件，' + rows.length + ' 种类型，合计 ' + totalBytes + ' 字节');
}

main();
