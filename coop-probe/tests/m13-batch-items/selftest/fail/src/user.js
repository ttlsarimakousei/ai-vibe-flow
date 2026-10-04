'use strict';

// 用户在列表里的显示名
function displayName(user) {
  var n = user && user.name;
  if (n === undefined || n === null || String(n).trim() === '') return '匿名用户';
  return n;
}

module.exports = { displayName: displayName };
