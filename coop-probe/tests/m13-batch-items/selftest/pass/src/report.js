'use strict';
var path = require('path');
var config = require('./config');
var format = require('./format');

// 导出报表的文件名
function fileName(d) {
  d = d || new Date();
  return 'report-' + d.getFullYear() + format.pad2(d.getMonth() + 1) + format.pad2(d.getDate()) + '.csv';
}

// 导出文件的完整路径
function exportPath() {
  return path.join(config.EXPORT_DIR, fileName());
}

module.exports = { fileName: fileName, exportPath: exportPath };
