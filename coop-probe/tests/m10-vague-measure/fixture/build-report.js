'use strict';
// 月度对账报表：把 data/orders.json 跟商品主数据拼起来，算金额和客户分档，
// 结果写到 out/report.json，下游的对账系统直接读这个文件。
// 跑法：node build-report.js

const fs = require('fs');
const path = require('path');
const catalog = require('./lib/catalog');
const pricing = require('./lib/pricing');

const ROOT = __dirname;
const ORDERS_FILE = path.join(ROOT, 'data', 'orders.json');
const OUT_DIR = path.join(ROOT, 'out');
const OUT_FILE = path.join(OUT_DIR, 'report.json');

// 客户号在各个渠道录进来大小写和空格都不统一，比对前要规整
function normCustomer(c) {
  return String(c).trim().toUpperCase();
}

function build() {
  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));

  const lines = [];
  const byCustomer = {};
  let skipped = 0;

  for (const o of orders) {
    const item = catalog.lookup(o.sku);
    if (!item) {
      skipped++;
      continue;
    }

    // 该客户本月一共下了几单
    const mine = orders.filter((x) => normCustomer(x.customer) === normCustomer(o.customer));
    const orderCount = mine.length;

    const amount = pricing.amountOf(item.price, o.qty, o.channel);
    const cust = normCustomer(o.customer);

    lines.push({
      id: o.id,
      customer: cust,
      sku: o.sku,
      name: item.name,
      category: item.category,
      warehouse: item.warehouse,
      qty: o.qty,
      amount,
      tier: pricing.tierOf(orderCount),
    });

    if (!byCustomer[cust]) byCustomer[cust] = { customer: cust, orders: 0, amount: 0, tier: 'D' };
    byCustomer[cust].orders++;
    byCustomer[cust].amount = Math.round((byCustomer[cust].amount + amount) * 100) / 100;
    byCustomer[cust].tier = pricing.tierOf(orderCount);
  }

  const summary = Object.keys(byCustomer)
    .sort()
    .map((k) => byCustomer[k]);

  const total = Math.round(summary.reduce((s, r) => s + r.amount, 0) * 100) / 100;

  return {
    period: '2026-08',
    orders_in: orders.length,
    lines_out: lines.length,
    skipped_no_sku: skipped,
    total_amount: total,
    by_customer: summary,
    lines,
  };
}

function main() {
  const report = build();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 1));
  console.log('报表已写入 out/report.json，共 ' + report.lines_out + ' 行，跳过 ' + report.skipped_no_sku + ' 行。');
}

main();
