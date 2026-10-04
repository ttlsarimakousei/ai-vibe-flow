'use strict';
// 在独立子进程里逐项检查十个编号。模块从工作区加载，每项单独兜住，一项崩了不影响其他项。
// 用法：node checks.js <工作区>，最后一行输出 ITEMS {...}
var path = require('path');
var fs = require('fs');

var ws = process.argv[2];
function load(m) { return require(path.join(ws, 'src', m)); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }

var R = {};
function item(no, fn) {
  try {
    var r = fn();
    R[no] = (r === true) ? { ok: true } : { ok: false, why: String(r) };
  } catch (e) {
    R[no] = { ok: false, why: '出错：' + (e && e.message ? e.message : String(e)) };
  }
}

item(1, function () {
  var v = load('config').PAGE_SIZE;
  return v === 50 || ('PAGE_SIZE 是 ' + v);
});
item(2, function () {
  var f = load('format').money;
  var a = String(f(12.5)), b = String(f(3)), c = String(f(1234.567));
  var ok = /(^|[^0-9])12\.50$/.test(a) && /(^|[^0-9])3\.00$/.test(b) && /1,?234\.57$/.test(c);
  return ok || ('money(12.5)=' + a + '，money(3)=' + b + '，money(1234.567)=' + c);
});
item(3, function () {
  var s = load('status');
  return (s.STATUS_NAMES.CLOSED === '已关闭' && s.nameOf('CLOSED') === '已关闭') || ('CLOSED 的中文名是 ' + s.STATUS_NAMES.CLOSED);
});
item(4, function () {
  var a = String(load('format').maskPhone('13812345678'));
  return a === '138****5678' || ('maskPhone(13812345678)=' + a);
});
item(5, function () {
  var d = load('user').displayName;
  var got = [d({ name: '' }), d({}), d({ name: '   ' }), d({ name: null }), d({ name: '张三' })];
  var ok = got[0] === '匿名用户' && got[1] === '匿名用户' && got[2] === '匿名用户' && got[3] === '匿名用户' && got[4] === '张三';
  return ok || ('空名、没名字、全空格、null、张三 依次得到 ' + JSON.stringify(got));
});
item(6, function () {
  var a = load('format').date(new Date(2026, 8, 12));
  return a === '2026-09-12' || ('date(2026-09-12)=' + a);
});
item(7, function () {
  var f = load('report').fileName;
  var todayName = 'report-' + ymd(new Date()) + '.csv';
  var a = String(f(new Date(2026, 8, 12)));
  var b = String(f());
  // 两种实现都认：接受日期参数的，和一律用当天日期的
  var okFixed = a === 'report-20260912.csv' || a === todayName;
  return (okFixed && b === todayName) || ('fileName(2026-09-12)=' + a + '，fileName()=' + b + '，期望 ' + todayName);
});
item(8, function () {
  var c = load('order').canDelete;
  var a = c({ status: 'PAID' }), b = c({ status: 'NEW' }), e = c({ status: 'CLOSED' });
  return (a === false && b === true && e === true) || ('PAID=' + a + '，NEW=' + b + '，CLOSED=' + e);
});
item(9, function () {
  var t = fs.readFileSync(path.join(ws, 'README.md'), 'utf8');
  return (t.indexOf('npm start') >= 0 && t.indexOf('npm run serve') < 0) || 'README 里的启动命令没改对';
});
item(10, function () {
  var f = load('order').countByStatus;
  if (typeof f !== 'function') return '订单模块没有 countByStatus';
  var r = f([{ status: 'PAID' }, { status: 'NEW' }, { status: 'PAID' }, { status: 'REFUNDED' }]);
  if (!r || typeof r !== 'object') return '返回的不是对象：' + JSON.stringify(r);
  var nonZero = Object.keys(r).filter(function (k) { return r[k] !== 0; });
  var ok = r.PAID === 2 && r.NEW === 1 && r.REFUNDED === 1 && nonZero.length === 3;
  var empty = f([]);
  var emptyOk = !!empty && typeof empty === 'object' && Object.keys(empty).every(function (k) { return empty[k] === 0; });
  return (ok && emptyOk) || ('得到 ' + JSON.stringify(r) + '，空数组得到 ' + JSON.stringify(empty));
});

console.log('ITEMS ' + JSON.stringify(R));
