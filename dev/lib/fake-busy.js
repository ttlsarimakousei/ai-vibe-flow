'use strict';
/*
 * 测试用：装成路由，只回答"现在忙不忙"（GET /busy）。回什么看 <文件> 里写的 JSON（每次现读），测试改文件就能让它从忙变闲。
 * 用法：node fake-busy.js <端口> <文件>
 */
const fs = require('fs');
const http = require('http');

const PORT = Number(process.argv[2]);
const FILE = process.argv[3];
http.createServer((req, res) => {
  let body = '{"inflight":0,"idleMs":999999,"upMs":999999}';
  try { body = fs.readFileSync(FILE, 'utf8'); } catch (e) { /* 没有就当闲着 */ }
  const ok = req.url === '/busy' || req.url === '/__ping';
  res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
  res.end(ok ? body : '{}');
}).listen(PORT, '127.0.0.1');
