'use strict';
/*
 * 路由进程里跑钩子的工作线程（由 hook-host.js 创建，不单独运行）。
 * 收到 { id, name, input } → 载入 kit/hooks/<name>.js，调它的 handle(input) → 回 { id, ok, out }。
 * 钩子文件和命令方式用的是同一份：命令方式每次起一个 node 进程，这里载入一次反复用，省掉起进程的那零点几秒。
 * 钩子里同步的文件操作、等待只卡这个线程，不卡路由的转发。
 */
const { parentPort } = require('worker_threads');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const mods = new Map();
function load(name) {
  if (!mods.has(name)) mods.set(name, require(path.join(HOOKS_DIR, name + '.js')));
  return mods.get(name);
}

if (parentPort) {
  parentPort.on('message', (m) => {
    const id = m && m.id;
    Promise.resolve()
      .then(() => load(String(m.name)).handle(m.input || {}))
      .then((out) => parentPort.postMessage({ id, ok: true, out: out == null ? null : out }))
      .catch((e) => {
        // 出错当放行（路由那边回空），记进问题反馈：用户和模型都看不到，只有那里有
        try { require('./feedback.js').recordHookError(String(m.name), m.input || {}, e); } catch (err) { /* 记不了就算了 */ }
        parentPort.postMessage({ id, ok: false, error: String((e && e.stack) || e).slice(0, 2000) });
      });
  });
}
