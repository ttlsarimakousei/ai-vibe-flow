'use strict';

const fs = require('fs');
const { alertKey } = require('./normalize');

// 静默名单：config/mute.json 里的 rules 是一串告警指纹，
// 值班同学手工维护，命中的告警不进日报（噪音太大的那几类）。
function loadRules(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw.rules) ? raw.rules : [];
}

// 规则以 * 结尾表示前缀匹配，否则全等
function matchRule(key, rule) {
  return rule.endsWith('*') ? key.startsWith(rule.slice(0, -1)) : key === rule;
}

function isMuted(alert, rules) {
  const k = alertKey(alert);
  return rules.some((r) => matchRule(k, r));
}

function splitMuted(alerts, rules) {
  const kept = [];
  const muted = [];
  for (const a of alerts) {
    if (isMuted(a, rules)) muted.push(a);
    else kept.push(a);
  }
  return { kept, muted };
}

module.exports = { loadRules, matchRule, isMuted, splitMuted };
