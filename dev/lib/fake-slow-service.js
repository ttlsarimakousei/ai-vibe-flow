'use strict';
/*
 * 假的慢服务（test-devserver-0929 用）：一起来就占端口，过 READY_MS 才答 HTTP（Tomcat 先占端口、后部署应用）。答的是启动那一刻 <源目录>/v.txt 的内容。
 * 用法：node fake-slow-service.js <端口> <源目录> <READY_MS>
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const [port, src, readyMs] = process.argv.slice(2);
const text = fs.readFileSync(path.join(src, 'v.txt'), 'utf8').trim();
let ready = false;
setTimeout(() => { ready = true; }, Number(readyMs) || 0);
const pending = [];
http.createServer((req, res) => { if (ready) res.end(text); else pending.push(res); }).listen(Number(port), '127.0.0.1');
setInterval(() => { if (ready) while (pending.length) pending.shift().end(text); }, 100);
