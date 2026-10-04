'use strict';

// 订单状态码和中文名
var STATUS_NAMES = {
  NEW: '新建',
  PAID: '已支付',
  CLOSED: '已关闭',
  REFUNDED: '已退款'
};

function nameOf(code) {
  return STATUS_NAMES[code] || '未知';
}

module.exports = { STATUS_NAMES: STATUS_NAMES, nameOf: nameOf };
