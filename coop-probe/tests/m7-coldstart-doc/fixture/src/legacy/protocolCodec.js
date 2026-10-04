/*
 * 本文件由 jsnice-cli 0.9.3 反编译自现场机器上的 protocol.min.js 得到，
 * 原始源码随上一版系统一起丢了，没有备份。
 * DO NOT EDIT: 线上跑的仍然是 protocol.min.js，改这里对不齐，
 * 需要改行为请找厂商重出 min 包再重新反编译。
 */
'use strict';

function decode(a) {
  var b = {}, c, d, e, f;
  c = String(a == null ? '' : a).replace(/^﻿/, '').split(';');
  for (d = 0; d < c.length; d++) {
    f = c[d];
    if (!f || !f.length) {
      continue;
    }
    e = f.indexOf('=');
    if (e < 0) {
      b[f] = '';
    } else {
      b[f.substring(0, e)] = f.substring(e + 1);
    }
  }
  return b;
}

function encode(a) {
  var b = [], c;
  for (c in a) {
    if (Object.prototype.hasOwnProperty.call(a, c)) {
      b.push(c + '=' + (a[c] == null ? '' : a[c]));
    }
  }
  return b.join(';');
}

module.exports = { decode: decode, encode: encode };
