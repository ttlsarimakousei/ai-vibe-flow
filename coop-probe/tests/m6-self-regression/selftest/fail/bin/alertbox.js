#!/usr/bin/env node
'use strict';

// 用法：node bin/alertbox.js [--json] [日志文件]
// 不传日志文件就读 data/alerts.log

const fs = require('fs');
const path = require('path');
const { parseLog } = require('../src/normalize');
const { loadRules, splitMuted } = require('../src/mute');
const { groupAlerts, renderText } = require('../src/report');

const ROOT = path.join(__dirname, '..');

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const logFile = rest[0] ? path.resolve(rest[0]) : path.join(ROOT, 'data', 'alerts.log');

  const alerts = parseLog(fs.readFileSync(logFile, 'utf8'));
  const rules = loadRules(path.join(ROOT, 'config', 'mute.json'));
  const { kept, muted } = splitMuted(alerts, rules);
  const groups = groupAlerts(kept);

  if (asJson) {
    const payload = {
      total: alerts.length,
      muted: muted.map((a) => a.id),
      groups: groups.map((g) => ({
        key: g.key,
        level: g.level,
        count: g.count,
        sample: g.sample,
        ids: g.ids,
      })),
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(
      renderText(groups, { total: alerts.length, mutedCount: muted.length }) + '\n'
    );
  }
}

main(process.argv);
