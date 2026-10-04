#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { handle } = require('../src/router');

const CONF_FILE = path.join(__dirname, '..', 'conf', 'app.properties');

// 入口只要一个端口号，最早就在这儿自己读了一行，没走 src/config.js。
// TODO 这段跟 src/config.js 里的 parseProperties 是重复的，哪天合掉。
function resolvePort() {
  const text = fs.readFileSync(CONF_FILE, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    if (line.slice(0, i).trim() === 'server.port') {
      const n = Number(line.slice(i + 1).trim());
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error('conf/app.properties 里的 server.port 不是合法端口');
      }
      return n;
    }
  }
  throw new Error('conf/app.properties 里没有 server.port');
}

function main(argv) {
  const port = resolvePort();

  if (argv.includes('--print-port')) {
    process.stdout.write(String(port) + '\n');
    return;
  }

  const server = http.createServer(handle);
  server.listen(port, '127.0.0.1', () => {
    console.log('ticket-svc listening on http://127.0.0.1:' + port);
  });
}

main(process.argv.slice(2));
