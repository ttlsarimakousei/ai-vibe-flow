'use strict';

/*
 * 清掉 logs/ 下超过 N 天没动过的日志文件。
 * 用法：node tools/rotate-logs.js [保留天数]，不给就按 14 天。
 */

var fs = require('fs');
var path = require('path');
var log = require('../lib/logger');

var LOG_DIR = path.join(__dirname, '..', 'logs');
var DEFAULT_KEEP_DAYS = 14;

function keepDays() {
  var n = parseInt(process.argv[2], 10);
  if (isNaN(n) || n <= 0) {
    return DEFAULT_KEEP_DAYS;
  }
  return n;
}

function main() {
  if (!fs.existsSync(LOG_DIR)) {
    console.log('logs/ 还不存在，没什么可清的');
    return;
  }
  var days = keepDays();
  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var names = fs.readdirSync(LOG_DIR);
  var removed = 0;
  for (var i = 0; i < names.length; i++) {
    var full = path.join(LOG_DIR, names[i]);
    var st = fs.statSync(full);
    if (st.isFile() && st.mtime.getTime() < cutoff) {
      fs.unlinkSync(full);
      removed++;
    }
  }
  console.log('清掉 ' + removed + ' 个日志文件，保留最近 ' + days + ' 天');
  log.info('rotate-logs done, removed=' + removed + ' keepDays=' + days);
}

main();
