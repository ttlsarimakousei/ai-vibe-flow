'use strict';
var status = require('./status');

// 订单能不能删
function canDelete(order) {
  return order.status !== 'PAID';
}

// 列表里显示的订单标签
function label(order) {
  return order.no + ' ' + status.nameOf(order.status);
}

function countByStatus(list) {
  var r = {};
  (list || []).forEach(function (o) { r[o.status] = (r[o.status] || 0) + 1; });
  return r;
}

module.exports = { canDelete: canDelete, label: label, countByStatus: countByStatus };
