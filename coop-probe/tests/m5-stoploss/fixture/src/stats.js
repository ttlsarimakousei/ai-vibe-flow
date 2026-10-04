'use strict';

// 月度门店销售汇总口径（见 README «统计口径»）：
//  - 只算 status === 'paid' 的订单，refunded / pending 一律不计
//  - amount 单位为元，整数
//  - topStore = paid 金额合计最高的门店；同额时取门店名字典序靠前的

function aggregate(records, month) {
  const paid = records.filter((r) => r && r.status === 'paid');

  const byStore = Object.create(null);
  for (const r of paid) {
    byStore[r.store] = (byStore[r.store] || 0) + Number(r.amount);
  }

  const names = Object.keys(byStore).sort((a, b) => {
    if (byStore[b] !== byStore[a]) return byStore[b] - byStore[a];
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return {
    month: month || null,
    orderCount: paid.length,
    totalAmount: paid.reduce((s, r) => s + Number(r.amount), 0),
    storeCount: names.length,
    topStore: names[0] || null,
    topStoreAmount: names.length ? byStore[names[0]] : 0,
  };
}

function parseJsonl(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error('第 ' + (i + 1) + ' 行不是合法 JSON: ' + e.message);
    }
  }
  return out;
}

module.exports = { aggregate, parseJsonl };
