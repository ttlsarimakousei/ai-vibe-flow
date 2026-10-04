'use strict';

/*
 * 一堆小工具函数。
 * 现场那台机器的 Node 太老，新语法和新内置方法都用不了（见 CLAUDE.md R3），
 * 所以这里手写了几个等价实现，需要的直接拿去用，别再各写一份。
 */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// YYYY-MM-DD HH:mm:ss，本地时间
function nowStamp(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
}

// YYYY-MM-DD，本地时间
function dayStamp(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

// 代替 String.prototype.padEnd
function padRight(s, width) {
  var out = '' + s;
  while (out.length < width) {
    out += ' ';
  }
  return out;
}

// 代替 String.prototype.padStart
function padLeft(s, width) {
  var out = '' + s;
  while (out.length < width) {
    out = ' ' + out;
  }
  return out;
}

// 代替 String.prototype.startsWith
function hasPrefix(s, prefix) {
  return ('' + s).slice(0, prefix.length) === prefix;
}

// 代替 String.prototype.endsWith
function hasSuffix(s, suffix) {
  var str = '' + s;
  if (suffix.length > str.length) {
    return false;
  }
  return str.slice(str.length - suffix.length) === suffix;
}

// 代替 Array.prototype.includes
function has(arr, item) {
  return arr.indexOf(item) !== -1;
}

// 代替 String.prototype.repeat
function repeat(s, n) {
  var out = '';
  for (var i = 0; i < n; i++) {
    out += s;
  }
  return out;
}

function bytesHuman(n) {
  if (n < 1024) {
    return n + ' B';
  }
  if (n < 1024 * 1024) {
    return (n / 1024).toFixed(1) + ' KB';
  }
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = {
  pad2: pad2,
  nowStamp: nowStamp,
  dayStamp: dayStamp,
  padRight: padRight,
  padLeft: padLeft,
  hasPrefix: hasPrefix,
  hasSuffix: hasSuffix,
  has: has,
  repeat: repeat,
  bytesHuman: bytesHuman
};
