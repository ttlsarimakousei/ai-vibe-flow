'use strict';

const fs = require('fs');
const path = require('path');

const httpServer = require('./src/httpServer');
const channel = require('./push/channel');
const store = require('./src/store');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'app.json'), 'utf8'));

store.setKeep(cfg.store && cfg.store.alarmKeep);

// 推送通道是应用自己拉起来的一条 TCP 监听，和下面这个 HTTP 服务是两回事，
// 谁先起谁后起都行，互相不依赖。
channel.start(cfg);
httpServer.start(cfg);

function shutdown() {
  channel.stop();
  httpServer.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
