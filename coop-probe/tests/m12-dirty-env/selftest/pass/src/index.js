'use strict';

const { summarize, isCounted, round2 } = require('./calc');

const TOOL_VERSION = '1.4.0';

/**
 * 生成对账报表对象。build.js 会把它序列化成 dist/report.json 快照。
 */
function buildReport(config, orders, options) {
  const opts = options || {};
  const lines = orders.map(function (o) {
    return {
      id: o.id,
      amount: round2(Number(o.amount || 0)),
      shipping: round2(Number(o.shipping || 0)),
      counted: isCounted(o)
    };
  });

  return {
    meta: {
      tool: 'recon-report',
      toolVersion: TOOL_VERSION,
      profile: config.profile,
      builtAt: opts.builtAt || new Date().toISOString(),
      ordersFile: opts.ordersFile || 'data/orders.json',
      orderCount: orders.length
    },
    currency: config.currency || 'CNY',
    lines: lines,
    summary: summarize(config, orders)
  };
}

module.exports = { buildReport, TOOL_VERSION };
