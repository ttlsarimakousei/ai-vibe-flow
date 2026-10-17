'use strict';
/*
 * 测试支架在工作线程里调钩子（harness.js 的 hook() 用，不单独运行）。2026-10-18 起：起一个 node 进程调一次钩子，
 * 每次固定多 0.3—0.6 秒（起进程、载模块，实测见 docs/release-timing.md）；这里每份套件载一次，反复用。
 * 和路由的 HTTP 钩子（kit/lib/hook-worker.js）一样：载 kit/hooks/<名字>.js，经 kit/lib/invocation.js 调 handle()，出错记进问题反馈、当放行。
 * 为了和命令方式（子进程）跑出来一样，补了三处子进程本来就有、工作线程没有的：
 *   - 环境变量不分大小写（Windows 上进程的是这样，工作线程里的是一份分大小写的副本）
 *   - os.homedir() 跟着 USERPROFILE / HOME 走（原生实现读的是测试进程自己的环境，会指到真的用户目录）
 *   - 工作目录：由 harness.js 在调用前后切换测试进程的工作目录（工作线程不能自己切）
 * 和主线程的约定：主线程发 { id, name, input }，这里回 { id, ok, text }（text 是命令方式会打到标准输出的那段），
 * 回完把 flag[0] 置 1、叫醒主线程（主线程在 Atomics.wait 里同步等着，所以 hook() 还是同步的）；线程退出时 flag[1] 置 1。
 */
const { workerData } = require('worker_threads');
const os = require('os');
const path = require('path');

const { kit, port, flag } = workerData;

if (process.platform === 'win32') {
  const raw = Object.assign({}, process.env);
  const real = (k) => (typeof k === 'string' ? Object.keys(raw).find((x) => x.toUpperCase() === k.toUpperCase()) : undefined);
  process.env = new Proxy(raw, {
    get: (t, k) => { if (typeof k !== 'string') return t[k]; const r = real(k); return r === undefined ? undefined : t[r]; },
    set: (t, k, v) => { const r = real(k); t[r === undefined ? k : r] = String(v); return true; },
    has: (t, k) => real(k) !== undefined,
    deleteProperty: (t, k) => { const r = real(k); if (r !== undefined) delete t[r]; return true; },
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, k) => { const r = real(k); return r === undefined ? undefined : { value: t[r], writable: true, enumerable: true, configurable: true }; },
  });
}
const nativeHome = os.homedir;
os.homedir = () => (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || nativeHome();

const mods = new Map();
const load = (name) => { if (!mods.has(name)) mods.set(name, require(path.join(kit, 'hooks', name + '.js'))); return mods.get(name); };
let current = 0;
const reply = (m) => { if (m.id !== current) return; current = 0; port.postMessage(m); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };
// 钩子里没接住的异常、process.exit：命令方式下进程就没了、没有输出。这里也回"没有输出"，线程退掉（flag[1] 置 1），下次换新的
process.on('uncaughtException', () => { if (current) reply({ id: current, ok: false, text: '' }); process.exit(1); });
process.on('exit', () => { Atomics.store(flag, 1, 1); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); });

port.on('message', (m) => {
  const id = m && m.id;
  current = id;
  const name = String(m.name);
  const input = m.input || {};
  Promise.resolve()
    .then(() => require(path.join(kit, 'lib', 'invocation.js')).run(() => load(name).handle(input), { budgetMs: 12000 }))
    .then((out) => reply({ id, ok: true, text: out == null || out === '' ? '' : (typeof out === 'string' ? out : JSON.stringify(out)) }))
    .catch((e) => {
      // 和命令方式一样：判断不了就放行，记进问题反馈
      try { require(path.join(kit, 'lib', 'feedback.js')).recordHookError(name, input, e); } catch (err) { /* 记不了就算了 */ }
      reply({ id, ok: false, text: '', error: String((e && e.stack) || e).slice(0, 2000) });
    });
});
