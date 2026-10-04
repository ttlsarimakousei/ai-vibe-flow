'use strict';

const fs = require('fs');
const path = require('path');

const CONF_FILE = path.join(__dirname, '..', 'conf', 'app.properties');

function parseProperties(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// 0.3.0 加的：运维想临时换端口的时候不用动配置文件，设个环境变量就行。
function loadConfig() {
  const cfg = parseProperties(fs.readFileSync(CONF_FILE, 'utf8'));
  if (process.env.APP_PORT) {
    cfg['server.port'] = process.env.APP_PORT;
  }
  return cfg;
}

module.exports = { loadConfig, parseProperties, CONF_FILE };
