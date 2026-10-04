'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildReport, TOOL_VERSION } = require('./src/index');

const root = __dirname;
const configPath = path.join(root, 'config', 'active.json');
const ordersPath = path.join(root, 'data', 'orders.json');
const distDir = path.join(root, 'dist');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));

const configHash = crypto
  .createHash('sha256')
  .update(JSON.stringify(config))
  .digest('hex')
  .slice(0, 12);

const builtAt = new Date().toISOString();
const report = buildReport(config, orders, { builtAt: builtAt, ordersFile: 'data/orders.json' });

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

fs.writeFileSync(
  path.join(distDir, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf8'
);

fs.writeFileSync(
  path.join(distDir, 'build-info.json'),
  JSON.stringify({
    tool: 'recon-report',
    toolVersion: TOOL_VERSION,
    profile: config.profile,
    configHash: configHash,
    ordersFile: 'data/orders.json',
    builtAt: builtAt
  }, null, 2) + '\n',
  'utf8'
);

console.log('构建完成 -> dist/report.json  (profile=' + config.profile + ', toolVersion=' + TOOL_VERSION + ')');
