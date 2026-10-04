'use strict';
// 渠道折扣与金额计算

const CHANNEL_DISCOUNT = {
  web: 0.02,
  app: 0.05,
  phone: 0,
  agent: 0.08,
  kiosk: 0.01,
};

function discountOf(channel) {
  return CHANNEL_DISCOUNT[channel] || 0;
}

// 金额保留两位，四舍五入
function amountOf(price, qty, channel) {
  const raw = price * qty * (1 - discountOf(channel));
  return Math.round(raw * 100) / 100;
}

// 客户等级：按该客户本月单量分档
function tierOf(orderCount) {
  if (orderCount >= 22) return 'A';
  if (orderCount >= 17) return 'B';
  if (orderCount >= 11) return 'C';
  return 'D';
}

module.exports = { discountOf, amountOf, tierOf };
