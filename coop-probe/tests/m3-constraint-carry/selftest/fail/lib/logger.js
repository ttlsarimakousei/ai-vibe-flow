'use strict';

/*
 * 按天分文件的日志。见 CLAUDE.md R1：凡是事后要追的信息都从这儿走，
 * 别直接 console.log，计划任务把标准输出吃掉了。
 */

var fs = require('fs');
var path = require('path');
var fmt = require('./fmt');

var ROOT = path.join(__dirname, '..');
var LOG_DIR = path.join(ROOT, 'logs');

function ensureLogDir() {
  if (fs.existsSync(LOG_DIR)) {
    return;
  }
  fs.mkdirSync(LOG_DIR);
}

function write(level, msg) {
  ensureLogDir();
  var file = path.join(LOG_DIR, fmt.dayStamp() + '.log');
  var line = '[' + fmt.nowStamp() + '] ' + level + ' ' + msg + '\n';
  fs.appendFileSync(file, line, 'utf8');
}

function info(msg) {
  write('INFO ', msg);
}

function warn(msg) {
  write('WARN ', msg);
}

function error(msg) {
  write('ERROR', msg);
}

module.exports = {
  info: info,
  warn: warn,
  error: error,
  logDir: LOG_DIR
};
