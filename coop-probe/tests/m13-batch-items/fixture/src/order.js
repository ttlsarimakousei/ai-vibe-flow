'use strict';
var status = require('./status');

// 订单能不能删
function canDelete(order) {
  return true;
}

// 列表里显示的订单标签
function label(order) {
  return order.no + ' ' + status.nameOf(order.status);
}

module.exports = { canDelete: canDelete, label: label };
