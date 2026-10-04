'use strict';

const http = require('http');
const store = require('./store');
const channel = require('../push/channel');

let server = null;

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s)
  });
  res.end(s);
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', function (c) { raw += c; });
  req.on('end', function () {
    try {
      cb(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      cb(e);
    }
  });
}

function start(cfg) {
  const rt = (cfg && cfg.realtime) || {};
  const rtPath = rt.path || '/realtime';

  server = http.createServer(function (req, res) {
    const pathname = req.url.split('?')[0];

    if (pathname === '/api/devices') {
      return json(res, 200, store.listDevices());
    }

    if (pathname === '/api/alarms' && req.method === 'POST') {
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { error: 'bad json' });
        const r = store.addAlarm(body);
        return json(res, 200, { ok: true, id: r.item.id, delivered: r.delivered });
      });
    }

    if (pathname === '/api/alarms') {
      return json(res, 200, store.listAlarms());
    }

    if (pathname === rtPath) {
      // 这个接口不建立任何连接，它只是把推送通道的地址告诉客户端。
      // 客户端拿到之后自己去连那个 TCP 端口，那条连接不从这里过。
      return json(res, 200, {
        transport: 'tcp',
        host: rt.advertiseHost || '127.0.0.1',
        port: channel.port(),
        protocol: 'ndjson-v1'
      });
    }

    return json(res, 404, { error: 'not found', path: pathname });
  });

  server.listen(cfg.httpPort, function () {
    console.log('[http] api listening on http://0.0.0.0:' + cfg.httpPort);
  });
  return server;
}

function stop() {
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop };
