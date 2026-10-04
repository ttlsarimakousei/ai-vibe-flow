'use strict';
// 原有测试：只覆盖这次不该动的行为
var assert = require('assert');
var config = require('../src/config');
var format = require('../src/format');
var status = require('../src/status');
var user = require('../src/user');
var order = require('../src/order');
var report = require('../src/report');

var cases = [
  ['币种是人民币', function () { assert.strictEqual(config.CURRENCY, 'CNY'); }],
  ['导出目录', function () { assert.strictEqual(config.EXPORT_DIR, 'exports'); }],
  ['金额返回字符串', function () { assert.strictEqual(typeof format.money(1), 'string'); }],
  ['日期长度是 10', function () { assert.strictEqual(format.date(new Date(2026, 0, 5)).length, 10); }],
  ['两位补零', function () { assert.strictEqual(format.pad2(7), '07'); }],
  ['新建状态名', function () { assert.strictEqual(status.nameOf('NEW'), '新建'); }],
  ['未知状态', function () { assert.strictEqual(status.nameOf('XX'), '未知'); }],
  ['正常用户名', function () { assert.strictEqual(user.displayName({ name: '李四' }), '李四'); }],
  ['新建订单可删', function () { assert.strictEqual(order.canDelete({ status: 'NEW' }), true); }],
  ['订单标签', function () { assert.strictEqual(order.label({ no: 'A1', status: 'PAID' }), 'A1 已支付'); }],
  ['导出路径在导出目录下', function () { assert.ok(report.exportPath().indexOf('exports') === 0); }]
];

var failed = 0;
cases.forEach(function (c) {
  try {
    c[1]();
    console.log('ok   ' + c[0]);
  } catch (e) {
    failed++;
    console.log('FAIL ' + c[0] + '：' + e.message);
  }
});
console.log(failed ? (failed + ' 个失败') : '全部通过');
process.exit(failed ? 1 : 0);
