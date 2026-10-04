'use strict';

const http = require('http');
const { BASE_URL } = require('./constants');

// 内部健康检查。地址改成从 constants 取，不再写死。
const HEALTH_URL = BASE_URL + '/healthz';

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
