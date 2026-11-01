'use strict';
/*
 * 装了路由时，改文件、跑命令、提问框、读文件提醒、收工检查这几个钩子登记成 HTTP 钩子，打到 /vibe-kit/hook/<名字>，
 * 由套件的 lib/hook-host.js 在工作线程里跑（和命令方式同一份代码），不用每次起一个 node 进程。
 * 这里出任何问题都回 {}（放行），和命令方式钩子出错时一样；有没有生效由用户开口时的自检（hook-health.js）盯着。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const path = require('path');
const { LISTEN } = require('./config-file');
const { KIT_DIR, overridePort, log, readBody, json } = require('./base');
const { hookRequestRejected } = require('./access');
const api = require('./api');

let hookHost = null;
let hookHostTriedAt = 0;
function getHookHost() {
  if (hookHost || Date.now() - hookHostTriedAt < 30000) return hookHost;
  hookHostTriedAt = Date.now();
  try { hookHost = require(path.join(KIT_DIR, 'lib', 'hook-host.js')).createHost({ kitDir: KIT_DIR, log }); }
  catch (e) { log('载入钩子宿主失败，HTTP 钩子这段时间一律放行：' + e.message); }
  return hookHost;
}
/**
 * 钩子宿主载不进来、出错时回什么：别的检查当放行；跑命令的检查（guard-commit）里像推送的不放行——push 只留钩子这一道确认
 * （用户 2026-10-30 定的，复审 S4）。人工要确认、全自动拦下（套件的 pushFailOut）；套件的库也载不进来时直接问
 */
function hookFailOut(name, input, why) {
  if (name !== 'guard-commit') return {};
  const cmd = String((input && input.tool_input && input.tool_input.command) || '');
  if (!/push|publish|发布到/i.test(cmd)) return {};
  try { const out = require(path.join(KIT_DIR, 'lib', 'session.js')).pushFailOut(input, why); if (out) return out; } catch (e) { /* 套件的库也坏了 */ }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '[vibe-kit] 推送的检查这次没跑成（' + String(why || '').slice(0, 120) + '），推到远端要你确认。' } };
}
async function handleHook(req, res, name) {
  const why = hookRequestRejected(req);
  if (why) { req.resume(); return json(res, 403, { error: why }); }
  let input;
  try { input = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}'); } catch (e) { return json(res, 200, {}); }
  const host = getHookHost();
  if (!host) return json(res, 200, hookFailOut(name, input, '路由里的检查载不进来'));
  try {
    const r = await host.run(name, input && typeof input === 'object' ? input : {});
    if (r.status === 404) return json(res, 404, { error: '没有这个钩子：' + name });
    return json(res, 200, r.out == null ? {} : r.out);
  } catch (e) { log('钩子 ' + name + ' 出错（这次当放行）：' + e.message); return json(res, 200, hookFailOut(name, input, e.message)); }
}
/**
 * settings.json 里登记的 HTTP 钩子打的端口和路由现在的端口对不上（手改了配置里的端口）：重新登记一次，不然钩子全打空、一律放行。
 * 用 -p 临时换端口跑的不管（那是测试或临时用）
 */
function checkHookPort() {
  if (overridePort || !api.kitApi || typeof api.kitApi.sync !== 'function') return;
  try {
    const ports = require(path.join(KIT_DIR, 'lib', 'hook-health.js')).registeredHookPorts(path.dirname(KIT_DIR));
    if (!ports.length || ports.every((p) => p === LISTEN.port)) return;
    log('settings.json 里的 HTTP 钩子打的是端口 ' + ports.join('、') + '，路由现在在 ' + LISTEN.port + '：重新登记钩子');
    api.kitApi.sync(KIT_DIR).then((r) => log('重新登记钩子' + (r.ok ? '完成' : '没成功：' + String(r.output || '').slice(0, 300))));
  } catch (e) { /* 没装套件、或者老版本没有 hook-health.js */ }
}

function closeHost() { if (hookHost) hookHost.close(); }

module.exports = { getHookHost, hookFailOut, handleHook, checkHookPort, closeHost };
