'use strict';
/*
 * 模型路由 v3 —— 本机常驻，Claude Code 连它，它按"角色"把请求分给内网的各个模型。
 *   node router.js [-c 配置文件] [-p 端口]
 *   配置页：http://127.0.0.1:<端口>/ui   （加模型、换 key、分配角色、看用量，都不需要 AI）
 *
 * 平时由 service.js 在后台拉起（没有窗口），数据放在 ~/.claude/vibe-kit/router-data/。第一次运行没有配置文件，打开配置页添加模型即可。
 * 设计原则：
 *   1. 任何情况下都不自己退出，任何请求都要有个交代（不能挂着不回）。
 *   2. 配置文件坏了（不是合法 JSON）就继续用上一份好的；某一个模型配得不对（没填 key、地址不合法、key 里混进了看不见的字符）
 *      只跳过那一个，别的照常用，并在配置页上标出来。
 *   3. 只要还有一个模型能用，Claude 就能用：限流(429)、熔断(5xx)、key 失效(401/403)、连不上、半天不回，都换下一个。
 *   4. 同一个会话换过模型之后，一段时间内留在新模型上，不来回横跳；按"会话 + 角色"记，审查代理不受主会话影响。
 *   5. 边收边转，不攒包；顺手从回复里读出 token 用量记下来。回复传到一半上游断了，就把客户端的连接也断开，
 *      让它知道没收全、自己重试，不把半截回复装成正常结束。
 *   6. 数 token 之类和对话无关的请求只问一个模型，它的成败不影响模型的状态。
 *   7. 失败时把上游返回的错误内容记进日志，事后能查是限流还是熔断。
 *   8. 发给上游的请求不带 OpenAI 式的 Authorization: Bearer，key 只放 x-api-key（用户 2026-10-28 定的：不用 openai 方式请求）。
 *      模型名照原样带着（Claude Code 发来的；配了"换成这个模型名"的换成它）：网关要求必须有 model，20261028.1834 去掉过，更新后报
 *      "缺少必须的model参数"（问题反馈表第 18 条），照 0653 改回来了。
 * 文件（2026-11-01 拆开，K1-1）：入口还是这个文件，命令行参数、启动方式都没变——自动更新之后可能是旧版的 service.js 来起它。
 *   router.js       入口：HTTP 服务按路径分派、pid 文件、退出
 *   base.js         命令行参数、数据文件的位置、版本、日志、诊断脱敏、原子写、回 JSON
 *   config-file.js  配置的读、校验、保存、热加载，实际监听的地址
 *   health.js       冷却、额度用完、粘住同一个模型、上游错误怎么分类
 *   usage.js        用量记录和落盘、网关对请求大小的上限
 *   forward.js      选模型、转发、换模型、流式回复、测试一个模型
 *   access.js       谁能用哪些接口：只收本机程序、挡网页
 *   api.js          配置页的 /api 接口（套件那几页在 kit-api.js）
 *   hook-entry.js   套件的 HTTP 钩子入口
 * 只用 Node 自带模块。
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { VERSION, CONFIG_PATH, DATA_DIR, UI_PATH, log, writeAtomic, json } = require('./base');
const C = require('./config-file');
const { LISTEN, LISTEN_IS_LOOPBACK } = C;
const { classify, waitableStatus } = require('./health');
const { stats, flushUsage, saveGateway } = require('./usage');
const { usableProviders, usageTap, sendError, handleProxy } = require('./forward');
const { rejectBrowserRequest, hostIsLocal, fromLoopback, fromOtherSite } = require('./access');
const { handleApi } = require('./api');
const { handleHook, checkHookPort, closeHost } = require('./hook-entry');

// pid 文件：service.js 停路由时靠它认出"端口上的是不是这个路由"，并带上里面的令牌请它自己保存用量、退出
const PID_PATH = path.join(DATA_DIR, 'router.pid');
const RUN_TOKEN = crypto.randomBytes(24).toString('hex');

/** 退出前保存用量和网关记录、删掉自己的 pid 文件。收到 Ctrl+C、SIGTERM，或者 service.js 带令牌请它停时都走这里 */
let exiting = false;
function shutdown(why) {
  if (exiting) return;
  exiting = true;
  try { flushUsage(); } catch (e) { /* 忽略 */ }
  try { saveGateway(); } catch (e) { /* 忽略 */ }
  try { closeHost(); } catch (e) { /* 忽略 */ }
  removePidFile();
  log('路由退出（' + why + '），用量已保存');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown('收到 ' + sig));
function writePidFile() {
  try { writeAtomic(PID_PATH, JSON.stringify({ pid: process.pid, port: LISTEN.port, host: LISTEN.host, token: RUN_TOKEN, startedAt: new Date().toISOString(), config: CONFIG_PATH }, null, 2) + '\n'); }
  catch (e) { log('写不了 pid 文件 ' + PID_PATH + '：' + e.message); }
}
/** 只删自己写的那份：同一个数据目录里后来又起了一个路由（比如换了端口），它的 pid 文件不能被这边删掉 */
function removePidFile() {
  try { const j = JSON.parse(fs.readFileSync(PID_PATH, 'utf8')); if (j && j.token === RUN_TOKEN) fs.unlinkSync(PID_PATH); } catch (e) { /* 没有，或者不是我的 */ }
}
process.on('exit', removePidFile);
const tokenOk = (t) => { const a = Buffer.from(String(t || '')); const b = Buffer.from(RUN_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ---------- 服务 ----------
let lastRejectLogAt = 0;
// 正在转发的请求数、最近一次有请求（转发的、钩子的）是什么时候
let inflight = 0;
let lastActiveAt = 0;
const STARTED_AT = Date.now();
const busyState = () => ({ inflight, idleMs: Date.now() - (lastActiveAt || STARTED_AT), upMs: Date.now() - STARTED_AT });
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // 只监听本机时，Host 不是本机的请求一律不理：挡住网页用域名解析绕进来、借这个路由和里面的 key 发请求
  if (LISTEN_IS_LOOPBACK && !hostIsLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('只接受发给 127.0.0.1 / localhost 的请求'); }
  if (req.method === 'GET' && (url === '/ui' || url === '/ui/')) {
    if (!fromLoopback(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('配置页只能在本机打开'); }
    // 不许别的网页把配置页嵌进去（诱导点"清空""接上"这类按钮）
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }); return res.end(fs.readFileSync(UI_PATH)); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到配置页文件 ' + UI_PATH); }
  }
  if (req.method === 'GET' && url === '/') { res.writeHead(302, { Location: '/ui' }); return res.end(); }
  if (url.startsWith('/api/')) return void handleApi(req, res);
  // 下面四个只读的也不给别的网站的页面用
  if (req.method === 'GET' && ['/health', '/version', '/busy', '/stats'].includes(url) && fromOtherSite(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('不接受别的网页发来的请求'); }
  if (req.method === 'GET' && url === '/health') return json(res, 200, { status: C.configError ? 'degraded' : 'ok', error: C.configError, warnings: C.configWarnings, routes: C.config.routes, default: C.config.default.provider, providers: usableProviders().map((p) => p.name) });
  if (req.method === 'GET' && url === '/version') return json(res, 200, { version: VERSION });
  // 现在闲不闲：套件自动更新要重启路由，得挑没有请求在跑的时候（lib/updater.js 来问）
  if (req.method === 'GET' && url === '/busy') return json(res, 200, busyState());
  if (req.method === 'GET' && url === '/stats') return json(res, 200, stats);
  // service.js 停路由时先走这里：带着 pid 文件里的令牌请路由自己保存用量、退出。只认令牌，网页拿不到令牌
  if (url === '/internal/shutdown') {
    req.resume();
    if (req.method !== 'POST' || !fromLoopback(req) || rejectBrowserRequest(req) || !tokenOk(req.headers['x-vibe-token'])) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('不认这个请求'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid }), () => shutdown('service.js 请它停止'));
  }
  if (url.startsWith('/vibe-kit/hook/')) { lastActiveAt = Date.now(); return void handleHook(req, res, url.slice('/vibe-kit/hook/'.length)); }
  // 转发路径只给程序用：网页发来的一律不转（不然网页能借这个路由、带着真实的 key 往网关发请求）
  const why = rejectBrowserRequest(req);
  if (why) {
    req.resume();
    if (Date.now() - lastRejectLogAt > 10000) { lastRejectLogAt = Date.now(); log('拒绝了一个像是网页发来的请求：' + req.method + ' ' + url + '（' + why + '）'); } // 十秒内只记一条，免得被刷屏
    return sendError(res, 403, 'permission_error', '路由只接受 Claude Code 这类程序发来的请求，不接受网页发来的（' + why + '）');
  }
  // 数着正在转发的请求：回完了、客户端断了都算结束
  inflight++;
  lastActiveAt = Date.now();
  let counted = true;
  const settled = () => { if (!counted) return; counted = false; inflight = Math.max(0, inflight - 1); lastActiveAt = Date.now(); };
  res.on('finish', settled);
  res.on('close', settled);
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => { try { handleProxy(req, res, Buffer.concat(parts)); } catch (e) { log('处理请求出错：' + (e && e.stack || e)); sendError(res, 500, 'api_error', '路由内部出错：' + e.message); } });
  req.on('error', () => { /* 客户端断了 */ });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log('端口 ' + LISTEN.port + ' 被占用（多半是路由已经在运行了）。要换端口用 -p。'); process.exit(1); }
  log('服务出错：' + e.message);
});
server.listen(LISTEN.port, LISTEN.host, () => {
  // 端口真的拿到了才写 pid 文件：端口被占、起不来的那个不能把正在跑的那个的 pid 文件盖掉
  writePidFile();
  log('模型路由 v' + VERSION + ' 已启动  http://' + LISTEN.host + ':' + LISTEN.port + '   配置页 /ui');
  log('模型：' + (usableProviders().map((p) => p.name).join('、') || '（还没有可用的）') + '；角色：' + C.config.routes.map((r) => r.match.join('/') + '→' + r.provider).join('，') + '；默认→' + C.config.default.provider);
  if (C.configError) log('注意：' + C.configError);
  setTimeout(checkHookPort, 1500).unref();
});

module.exports = { normalize: C.normalize, problemsOf: C.problemsOf, providerProblem: C.providerProblem, classify, usageTap, cleanOptions: C.cleanOptions, rejectBrowserRequest, waitableStatus };
