'use strict';

const { alertKey, LEVEL_WEIGHT } = require('./normalize');

// 按告警指纹合并，同指纹的算一类
function groupAlerts(alerts) {
  const map = new Map();
  for (const a of alerts) {
    const k = alertKey(a);
    if (!map.has(k)) {
      map.set(k, { key: k, level: a.level, count: 0, sample: a.id, first: a.ts, ids: [] });
    }
    const g = map.get(k);
    g.count += 1;
    g.ids.push(a.id);
  }
  return [...map.values()].sort(
    (x, y) =>
      (LEVEL_WEIGHT[y.level] || 0) - (LEVEL_WEIGHT[x.level] || 0) ||
      y.count - x.count ||
      x.key.localeCompare(y.key)
  );
}

// 日报里每条的标题，直接由指纹拆出来拼
function titleOf(group) {
  return group.key.split('|').join(' / ');
}

function renderText(groups, stat) {
  const lines = [];
  lines.push('=== 告警日报 ===');
  lines.push(`原始 ${stat.total} 条，静默 ${stat.mutedCount} 条，汇总为 ${groups.length} 类`);
  lines.push('');
  for (const g of groups) {
    lines.push(`[${g.level}] ${titleOf(g)}  x${g.count}  (首条 ${g.sample})`);
  }
  return lines.join('\n');
}

module.exports = { groupAlerts, titleOf, renderText };
