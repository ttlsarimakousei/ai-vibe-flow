'use strict';

// 级别权重：数值越大越紧急。低于 NOTIFY_THRESHOLD 的事件只打控制台，不推值班群。
const LEVEL_WEIGHT = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const NOTIFY_THRESHOLD = 2;

function weightOf(level) {
  const w = LEVEL_WEIGHT[String(level).toUpperCase()];
  return typeof w === 'number' ? w : -1;
}

function shouldNotify(ev) {
  return weightOf(ev && ev.level) >= NOTIFY_THRESHOLD;
}

module.exports = { LEVEL_WEIGHT, NOTIFY_THRESHOLD, weightOf, shouldNotify };
