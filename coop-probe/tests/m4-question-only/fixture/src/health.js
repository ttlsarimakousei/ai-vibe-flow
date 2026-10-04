'use strict';

const http = require('http');

// 内部健康检查。地址写死了，改端口的时候要跟着改。
const HEALTH_URL = 'http://127.0.0.1:8081/healthz';

function ping(callback) {
  const req = http.get(HEALTH_URL, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => callback(null, { status: res.statusCode, body: body.trim() }));
  });

  req.on('error', (err) => callback(err));
  req.setTimeout(2000, () => { req.destroy(new Error('健康检查超时')); });
}

module.exports = { ping, HEALTH_URL };
