'use strict';

/*
 * 把 data/ 下的巡检结果 json 合成一份 out/summary.json，顺便在窗口里打个表。
 * 用法：node tools/collect.js
 */

var fs = require('fs');
var path = require('path');
var fmt = require('../lib/fmt');
var log = require('../lib/logger');

var ROOT = path.join(__dirname, '..');
var DATA_DIR = path.join(ROOT, 'data');
var OUT_DIR = path.join(ROOT, 'out');

function listInspFiles() {
  var names = fs.readdirSync(DATA_DIR);
  var out = [];
  for (var i = 0; i < names.length; i++) {
    if (fmt.hasPrefix(names[i], 'insp-') && path.extname(names[i]) === '.json') {
      out.push(names[i]);
    }
  }
  out.sort();
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  var files = listInspFiles();
  log.info('collect start, 巡检文件 ' + files.length + ' 个');

  var byDevice = {};
  var abnormal = 0;
  var i;
  for (i = 0; i < files.length; i++) {
    var doc = readJson(path.join(DATA_DIR, files[i]));
    var records = doc.records || [];
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      if (!byDevice[r.device]) {
        byDevice[r.device] = { device: r.device, count: 0, abnormal: 0 };
      }
      byDevice[r.device].count++;
      if (r.status !== 'ok') {
        byDevice[r.device].abnormal++;
        abnormal++;
      }
    }
  }

  var devices = Object.keys(byDevice).sort();
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR);
  }
  var summary = {
    generatedAt: fmt.nowStamp(),
    sourceFiles: files.length,
    devices: devices.length,
    abnormal: abnormal,
    byDevice: byDevice
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(fmt.padRight('设备', 18) + fmt.padLeft('记录', 6) + fmt.padLeft('异常', 6));
  console.log(fmt.repeat('-', 30));
  for (i = 0; i < devices.length; i++) {
    var d = byDevice[devices[i]];
    console.log(fmt.padRight(d.device, 18) + fmt.padLeft(d.count, 6) + fmt.padLeft(d.abnormal, 6));
  }
  console.log(fmt.repeat('-', 30));
  console.log('共 ' + devices.length + ' 台设备，异常 ' + abnormal + ' 条，结果已写入 out/summary.json');

  log.info('collect done, 设备 ' + devices.length + ' 台，异常 ' + abnormal + ' 条');
}

main();
