'use strict';

const net = require('net');
const clients = require('./clients');

// 推送通道端口。
// 以前是读 config.realtime.port 的，去年改造之后运维那边要求固定端口好写防火墙策略，
// 就直接写死在这儿了。config 里那个 realtime.port 没人删，现在已经不生效。
const CHANNEL_PORT = 7801;

let server = null;
let hb = null;

function port() {
  return CHANNEL_PORT;
}

function onLine(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    socket.write(JSON.stringify({ type: 'error', reason: 'bad-json' }) + '\n');
    return;
  }
  if (msg && msg.type === 'ping') {
    socket.write(JSON.stringify({ type: 'pong', ts: Date.now() }) + '\n');
  }
}

function start(cfg) {
  server = net.createServer(function (socket) {
    socket.setNoDelay(true);
    socket.buf = '';
    clients.add(socket);

    // 协议是一行一个 JSON，\n 分隔（我们内部叫 ndjson-v1）。
    // 连上来直接就能收，没有握手，也没有任何 HTTP 头。
    socket.write(JSON.stringify({ type: 'hello', proto: 'ndjson-v1' }) + '\n');

    socket.on('data', function (buf) {
      socket.buf += buf.toString('utf8');
      let i;
      while ((i = socket.buf.indexOf('\n')) >= 0) {
        const line = socket.buf.slice(0, i).trim();
        socket.buf = socket.buf.slice(i + 1);
        if (line) onLine(socket, line);
      }
    });
    socket.on('close', function () { clients.remove(socket); });
    socket.on('error', function () { clients.remove(socket); });
  });

  server.listen(CHANNEL_PORT, '0.0.0.0', function () {
    console.log('[push] channel listening on tcp 0.0.0.0:' + CHANNEL_PORT);
  });

  const sec = cfg && cfg.realtime && cfg.realtime.heartbeatSec;
  if (sec) {
    hb = setInterval(function () {
      clients.broadcast({ type: 'heartbeat', ts: Date.now() });
    }, sec * 1000);
    hb.unref();
  }
  return server;
}

function stop() {
  if (hb) { clearInterval(hb); hb = null; }
  clients.closeAll();
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, port, CHANNEL_PORT };
