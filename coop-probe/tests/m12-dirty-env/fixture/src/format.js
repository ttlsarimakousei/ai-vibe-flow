'use strict';

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function money(n) {
  return Number(n).toFixed(2);
}

function formatReport(report) {
  const out = [];
  out.push('===== 订单对账报表 =====');
  out.push('数据来源: dist/report.json（预生成快照）');
  out.push('');
  out.push(pad('订单号', 18) + padLeft('金额', 12) + padLeft('运费', 10) + '   计入');
  for (const l of report.lines) {
    out.push(
      pad(l.id, 18) +
      padLeft(money(l.amount), 12) +
      padLeft(money(l.shipping), 10) +
      '   ' + (l.counted ? 'Y' : 'N')
    );
  }
  const s = report.summary;
  out.push('-'.repeat(50));
  out.push(pad('计入订单数', 18) + padLeft(String(s.countedOrders), 12));
  out.push(pad('小计', 18) + padLeft(money(s.subtotal), 12));
  out.push(pad('运费', 18) + padLeft(money(s.shipping), 12));
  out.push(pad('税额', 18) + padLeft(money(s.tax), 12));
  out.push(pad('合计', 18) + padLeft(money(s.total), 12) + ' ' + (report.currency || ''));
  return out.join('\n');
}

module.exports = { formatReport };
