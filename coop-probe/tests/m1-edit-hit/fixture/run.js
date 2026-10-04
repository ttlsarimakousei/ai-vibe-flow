'use strict';

// 自查入口：node run.js
// 输出每行形如 <TAG>|<内容>，方便 diff 和采集器对拍。

const fs = require('fs');
const path = require('path');
const fmt = require('./src/alert-format');
const { shouldNotify } = require('./src/rules');

const eventsPath = path.join(__dirname, 'data', 'events.json');
const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

const notifyLines = [];

for (const ev of events) {
  console.log('CONSOLE|' + fmt.renderConsole(ev));
}

for (const ev of events) {
  if (!shouldNotify(ev)) continue;
  const line = fmt.renderNotify(ev);
  notifyLines.push(line);
  console.log('NOTIFY|' + line);
}

console.log('RECORD|' + fmt.toRecord(notifyLines));
console.log('SINK|' + fmt.SINK_PATH);
