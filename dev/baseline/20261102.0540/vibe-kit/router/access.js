'use strict';
/*
 * 谁能用路由的哪些接口：转发和钩子入口只收本机程序发来的（网页能往 127.0.0.1 发"简单请求"，不能让它借路由和里面的 key），
 * 配置页的接口只收本机、本机 Host、不是别的网站的页面发的。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
/**
 * 转发路径（/v1/...）只给 Claude Code 这类程序用，不给网页用。网页可以用 no-cors、text/plain 这种"简单请求"不经预检
 * 就往 127.0.0.1 发 POST，路由会照转并换上真实的 key。浏览器发的请求一定带 Origin（POST 都带）或 Sec-Fetch-Site / Sec-Fetch-Dest
 * （发往本机的请求都带），程序发的不带。返回拒绝的原因，空串表示放行。以后新加的、给程序用的接口也用它挡网页。
 * 注意"Sec-Fetch-Mode: cors"单独出现不算：Node 自带的 fetch（undici）每个请求都会加上这一个头，
 * 实测 Node 版的 Claude Code（2.1.81）发的每个请求都带它；浏览器发的请求除了它还一定带 Sec-Fetch-Site。
 */
function rejectBrowserRequest(req) {
  const h = req.headers || {};
  if (h.origin !== undefined) return '请求带了 Origin 头（是网页发的）';
  for (const k of ['sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user']) if (h[k] !== undefined) return '请求带了 ' + k + ' 头（是浏览器发的）';
  const mode = h['sec-fetch-mode'];
  if (mode !== undefined && String(mode).trim().toLowerCase() !== 'cors') return '请求带了 sec-fetch-mode: ' + mode + '（是浏览器发的）';
  if (req.method === 'POST' && String(h['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return 'POST 的 Content-Type 不是 application/json（' + (h['content-type'] || '没有') + '）';
  return '';
}
/** 请求头里的 Host 是不是本机。网页用"域名解析到 127.0.0.1"的办法绕进来时，Host 是它自己的域名 */
function hostIsLocal(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return ['127.0.0.1', 'localhost', '[::1]'].includes(h);
}
function fromLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}
/**
 * 是不是别的网站的页面发来的。<img>、<script> 这类子资源的 GET 不带 Origin，光看 Origin 挡不住；浏览器往本机发的请求都带 Sec-Fetch-Site：
 * 配置页自己发的是 same-origin，地址栏里直接打开的是 none，别的页面发的是 cross-site / same-site。程序发的不带这个头
 */
function fromOtherSite(req) {
  const s = req.headers['sec-fetch-site'];
  return s !== undefined && !['same-origin', 'none'].includes(String(s).trim().toLowerCase());
}
/** 配置页和它的接口：连接必须来自本机、Host 必须是本机、不是别的网站的页面发的、改东西必须带自定义请求头（跨站的网页带不上）、Origin 必须是本机 */
function apiAllowed(req) {
  if (!fromLoopback(req) || !hostIsLocal(req) || fromOtherSite(req)) return false;
  if (req.method !== 'GET' && req.headers['x-vibe-router'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
  return true;
}
/** 钩子请求只收本机程序发来的 POST：带 Origin、Sec-Fetch-Site/Dest/User 的是网页，一律不收（网页能发"简单请求"到 127.0.0.1） */
function hookRequestRejected(req) {
  if (req.method !== 'POST') return '只接受 POST';
  if (!fromLoopback(req)) return '只接受本机发来的请求';
  const h = req.headers || {};
  if (h.origin !== undefined) return '请求带了 Origin 头（是网页发的）';
  for (const k of ['sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user']) if (h[k] !== undefined) return '请求带了 ' + k + ' 头（是浏览器发的）';
  return '';
}

module.exports = { rejectBrowserRequest, hostIsLocal, fromLoopback, fromOtherSite, apiAllowed, hookRequestRejected };
