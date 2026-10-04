'use strict';
/*
 * 配置页的后台线程：选目录、自动探测、清点技能这些同步的文件操作在这里做。
 * 碰到断开的网络盘、很慢的磁盘时卡住的只是这个线程，路由的转发照常；kit-api.js 等 8 秒没结果就结束这个线程、下次重新建一个。
 * 由 kit-api.js 按需创建，不单独运行。
 */
const { parentPort } = require('worker_threads');
const api = require('./kit-api.js');

if (parentPort) {
  parentPort.on('message', (m) => {
    let out;
    try { out = { id: m.id, ok: true, result: api.runOp(m.op, m.args || {}) }; } catch (e) { out = { id: m.id, ok: false, error: (e && e.message) || String(e) }; }
    parentPort.postMessage(out);
  });
}
