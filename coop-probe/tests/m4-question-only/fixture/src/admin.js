'use strict';

const { loadConfig } = require('./config');

// /admin/config 只读展示当前配置，带 token 的项打码。
function renderConfig() {
  const cfg = loadConfig();
  const out = {};
  for (const key of Object.keys(cfg)) {
    out[key] = /token|secret|password/i.test(key) ? '***' : cfg[key];
  }
  return out;
}

module.exports = { renderConfig };
