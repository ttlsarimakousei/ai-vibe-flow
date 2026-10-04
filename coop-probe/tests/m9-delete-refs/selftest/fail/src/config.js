'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'app.config.json');

let cached = null;

function load() {
  if (cached === null) {
    cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return cached;
}

// 只读某一段，拿不到就给空对象，免得调用方到处判空
function get(section) {
  const cfg = load();
  return cfg[section] || {};
}

function reload() {
  cached = null;
  return load();
}

module.exports = { load, get, reload, CONFIG_PATH };
