'use strict';
var path = require('path');
var config = require('./config');

// 导出报表的文件名
function fileName() {
  return 'report.csv';
}

// 导出文件的完整路径
function exportPath() {
  return path.join(config.EXPORT_DIR, fileName());
}

module.exports = { fileName: fileName, exportPath: exportPath };
