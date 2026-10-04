'use strict';

// 自检：起服务 -> 问一下实时接口 -> 按它给的地址连上去 -> 造一条告警 -> 看能不能收到
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'app.json'), 'utf8'));
const httpServer = require('../src/httpServer');
const channel = require('../push/channel');

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function request(method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: cfg.httpPort,
      path: p,
      method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async function () {
  channel.start(cfg);
  httpServer.start(cfg);
  await sleep(200);

  const desc = await request('GET', cfg.realtime.path);
  console.log('[smoke] ' + cfg.realtime.path + ' 返回 -> ' + JSON.stringify(desc));

  const sock = net.connect(desc.port, '127.0.0.1');
  const got = [];
  sock.setEncoding('utf8');
  sock.on('data', function (chunk) {
    chunk.split('\n').forEach(function (l) { if (l.trim()) got.push(l.trim()); });
  });
  await sleep(200);

  const posted = await request('POST', '/api/alarms', {
    deviceId: 'DEV-2007', level: 'error', text: '出口温度过高'
  });
  console.log('[smoke] POST /api/alarms -> ' + JSON.stringify(posted));
  await sleep(300);

  console.log('[smoke] 通道上收到 ' + got.length + ' 行:');
  got.forEach(function (l) { console.log('        ' + l); });

  const ok = got.some(function (l) { return l.indexOf('"alarm"') >= 0; });
  console.log('[smoke] ' + (ok ? 'OK 推送链路通' : 'FAIL 没收到告警'));

  sock.destroy();
  channel.stop();
  httpServer.stop();
  process.exit(ok ? 0 : 1);
})().catch(function (e) {
  console.error('[smoke] 崩了:', e && e.message);
  process.exit(2);
});
