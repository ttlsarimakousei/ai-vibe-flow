'use strict';
/*
 * 配置页（用户 2026-11-03 定的：路由删了，配置页用时才起，敲 /vk-config）。只监听 127.0.0.1，只有 /ui、/api/kit*、/api/ping。
 * 放 lib 不放 tools：不是给模型跑的；不 require 就不起。
 * 访问检查从路由的 access.js 搬来：连接来自本机、Host 是本机、不是别的网站的页面发的、改东西带自定义请求头、Origin 是本机。
 * 端口优先固定，被占换随机，记在 state/config-page.json。页面每 30 秒发一次心跳（/api/ping）：开过页面的 3 分钟没心跳退出，5 分钟没人开也退出。
 * 更新装完（VERSION 变了、更新进程放了锁）用新代码重起一份，端口不变：开着页面点"立即更新"要接得上。
 * 后台进程 windowsHide、detached，不留窗口。只用 Node 自带的模块。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const KIT = path.join(__dirname, '..');
const STATE = path.join(KIT, 'state', 'config-page.json');
const UI = path.join(KIT, 'ui', 'ui.html');
const FIXED_PORT = Number(process.env.VIBE_KIT_CONFIG_PORT) || 15731;
const NO_HEARTBEAT_MS = Number(process.env.VIBE_KIT_CONFIG_IDLE_MS) || 3 * 60000;
const NOBODY_MS = Number(process.env.VIBE_KIT_CONFIG_NOBODY_MS) || 5 * 60000;

function hostIsLocal(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return ['127.0.0.1', 'localhost', '[::1]'].includes(h);
}
function fromLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}
/** 是不是别的网站的页面发来的。子资源的 GET 不带 Origin；浏览器往本机发的请求都带 Sec-Fetch-Site，配置页自己发的是 same-origin，地址栏打开的是 none */
function fromOtherSite(req) {
  const s = req.headers['sec-fetch-site'];
  return s !== undefined && !['same-origin', 'none'].includes(String(s).trim().toLowerCase());
}
function allowed(req) {
  if (!fromLoopback(req) || !hostIsLocal(req) || fromOtherSite(req)) return false;
  if (req.method !== 'GET' && req.headers['x-vibe-router'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('请求太大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serve() {
  let lastBeat = 0; const started = Date.now();
  const version = () => { try { return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; } };
  const born = version();
  const kitApi = require(path.join(KIT, 'ui', 'kit-api.js'));
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (!allowed(req)) return json(res, 403, { error: '配置页只能在本机打开，敲 /vk-config' });
    if (req.method === 'GET' && url === '/') { res.writeHead(302, { Location: '/ui' }); return res.end(); }
    if (req.method === 'GET' && (url === '/ui' || url === '/ui/')) {
      lastBeat = Date.now();
      // 不许别的网页把配置页嵌进去（诱导点按钮）
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }); return res.end(fs.readFileSync(UI)); }
      catch (e) { return res.end('找不到配置页文件 ' + UI); }
    }
    if (url === '/api/ping') { lastBeat = Date.now(); return json(res, 200, { ok: true, app: 'vibe-kit-config', kit: KIT }); }
    if (url.startsWith('/api/kit')) {
      lastBeat = Date.now();
      try {
        const body = req.method === 'POST' ? JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}') : {};
        return json(res, 200, await kitApi.handle(req.method, url, body, KIT));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    return json(res, 404, { error: '没有这个接口' });
  });
  const quit = () => { try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (s.pid === process.pid) fs.unlinkSync(STATE); } catch (e) { /* 没有 */ } process.exit(0); };
  const restart = () => {
    server.close(() => {
      try { fs.unlinkSync(STATE); } catch (e) { /* 没有 */ }
      spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: KIT }).unref();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  setInterval(() => {
    const now = Date.now();
    if (lastBeat ? now - lastBeat > NO_HEARTBEAT_MS : now - started > NOBODY_MS) return quit();
    const v = version();
    if (v && v !== born && !require('./updater').lockHeld()) restart();
  }, Math.min(5000, Math.max(200, Math.floor(NO_HEARTBEAT_MS / 4)))).unref();
  const listen = (port) => server.listen(port, '127.0.0.1');
  server.on('error', (e) => { if (e.code === 'EADDRINUSE' && server.address() === null && listen.tried !== true) { listen.tried = true; listen(0); return; } process.exit(1); });
  server.on('listening', () => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: server.address().port, at: Date.now() }));
  });
  listen(FIXED_PORT);
}

function ping(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.app === 'vibe-kit-config' && path.resolve(j.kit).toLowerCase() === path.resolve(KIT).toLowerCase()); } catch (e) { resolve(false); } });
    });
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.on('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 起着就用，没起就起。返回 { ok, url } 或 { ok: false, reason } */
async function ensure() {
  const readPort = () => { try { return Number(JSON.parse(fs.readFileSync(STATE, 'utf8')).port) || 0; } catch (e) { return 0; } };
  let port = readPort();
  if (port && await ping(port)) return { ok: true, url: 'http://127.0.0.1:' + port + '/ui', already: true };
  try { fs.unlinkSync(STATE); } catch (e) { /* 没有 */ }
  const child = spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: KIT });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    port = readPort();
    if (port && await ping(port)) return { ok: true, url: 'http://127.0.0.1:' + port + '/ui' };
  }
  return { ok: false, reason: '配置页 4 秒内没起来' };
}
/** 用系统默认浏览器打开 */
function openInBrowser(url) {
  if (process.env.VIBE_KIT_NO_BROWSER) return;
  if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}
module.exports = { ensure, openInBrowser, allowed, STATE };
if (require.main === module && process.argv[2] === 'serve') serve();
