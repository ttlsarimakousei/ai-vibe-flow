'use strict';

// 告警级别权重，日报按这个从高到低排
const LEVEL_WEIGHT = { critical: 3, warn: 2, info: 1 };

// 采集端追加的一行：<时间> <事件id> <环境> <主机> <服务> <级别> <描述...>
const LINE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

function parseLine(line) {
  const m = LINE_RE.exec(String(line).trim());
  if (!m) return null;
  return {
    ts: m[1],
    id: m[2],
    env: m[3],
    host: m[4],
    service: m[5],
    level: m[6],
    msg: m[7],
  };
}

function parseLog(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(parseLine)
    .filter(Boolean);
}

// 告警指纹。同一个指纹的告警在日报里会被合并成一条。
function alertKey(a) {
  return [a.host, a.service, a.level].join('|');
}

module.exports = { LEVEL_WEIGHT, parseLine, parseLog, alertKey };
