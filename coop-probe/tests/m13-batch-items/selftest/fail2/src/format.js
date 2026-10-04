'use strict';
// 显示用的格式化函数

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// 金额：传数字，返回显示用的字符串
function money(n) {
  return Number(n).toFixed(2);
}

// 日期：传 Date，返回显示用的字符串
function date(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 手机号：列表里显示用
function maskPhone(phone) {
  var p = String(phone);
  if (p.length !== 11) return p;
  return p.slice(0, 3) + '****' + p.slice(7);
}

module.exports = { money: money, date: date, maskPhone: maskPhone, pad2: pad2 };
