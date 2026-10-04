'use strict';

const http = require('http');
const { ping } = require('../src/health');

// 冒烟：先探健康检查，再拉一把 /admin/config 看配置对不对。
// 这里的地址也是写死的，跟 src/health.js 一样。
ping((err, r) => {
  if (err) {
    console.error('healthz 失败:', err.message);
    process.exitCode = 1;
    return;
  }
  console.log('healthz:', r.status, r.body);

  http.get('http://127.0.0.1:8081/admin/config', (res) => {
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
