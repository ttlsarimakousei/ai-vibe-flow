'use strict';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// 1.4.0 起：退款订单不再计入对账（财务口径调整，2026-08 之后生效）
function isCounted(order) {
  return order && order.refunded !== true;
}

function summarize(config, orders) {
  const counted = orders.filter(isCounted);
  let subtotal = 0;
  let shipping = 0;
  for (const o of counted) {
    subtotal = round2(subtotal + Number(o.amount || 0));
    if (config.shippingIncluded) {
      shipping = round2(shipping + Number(o.shipping || 0));
    }
  }
  const taxable = round2(subtotal + shipping);
  const tax = round2(taxable * Number(config.taxRate));
  const total = round2(taxable + tax);
  return {
    countedOrders: counted.length,
    excludedOrders: orders.length - counted.length,
    subtotal: subtotal,
    shipping: shipping,
    taxRate: Number(config.taxRate),
    tax: tax,
    total: total
  };
}

module.exports = { round2, isCounted, summarize };
