'use strict';

const http = require('http');
const { ping } = require('../src/health');
const { BASE_URL } = require('../src/constants');

// 冒烟：先探健康检查，再拉一把 /admin/config 看配置对不对。
ping((err, r) => {
  if (err) {
    console.error('healthz 失败:', err.message);
    process.exitCode = 1;
    return;
  }
  console.log('healthz:', r.status, r.body);

  http.get(BASE_URL + '/admin/config', (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.log('admin/config:', res.statusCode, body.replace(/\s+/g, ' '));
    });
  }).on('error', (e) => {
    console.error('admin/config 失败:', e.message);
    process.exitCode = 1;
  });
});
