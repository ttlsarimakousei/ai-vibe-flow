'use strict';
/*
 * 收回模型路由（用户 2026-11-03 定的，问题表第 39 条）。只放迁移代码：路由进程、开机自启、router/、router-data/（key、用量、备份）、
 * 路由用的状态文件、旧开关。不留守，不探测 cc-switch：切换由仓库主人提前用 cch 手动做。
 *
 * 什么时候收：新代码确认能跑之后。自动更新：新代码第一次跑 session-start 时收；手动安装：装完当场收。
 *   所以新版自检不过、旧更新器装回旧版时，路由、key、开机自启都还在。
 * 判据只看文件在不在，不靠记号；中途失败下次再试，不算装坏。
 * 端口上是别的安装的路由：不停别人的，只收自己的文件。认人靠这份安装 router.pid 里的令牌。
 * key 不读不打印：router-data 整个删，里面只读 router.pid、claude-link.json、config.json 的端口。
 * 只用 Node 自带的模块。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const KIT = path.join(__dirname, '..');
const CLAUDE = path.dirname(KIT);
const DATA = path.join(KIT, 'router-data');
const ROUTER = path.join(KIT, 'router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const OLD_FIELDS = ['statusUsage', 'hookTransport', 'reviewExecutor', 'reviewMaxFiles', 'requirementsReviewMaxRounds', 'applyReviewMaxRounds', 'reviewMaxRounds', 'reviewLoop'];
const OLD_STATE = ['hook-stats.json', 'hook-miss.json', 'gateway.json', 'idea-mcp.json', 'idea-mcp.lock'];
const PLACEHOLDER_TOKEN = 'vibe-kit-router';

const readJson = (f) => { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } };
const startupVbs = () => { const dir = process.env.VIBE_KIT_STARTUP_DIR || (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : ''); return dir ? path.join(dir, 'vibe-kit-router.vbs') : ''; };
/** 开机自启的 .vbs 是这份安装的才算：同一个"启动"文件夹里可能是别的安装放的 */
function ownVbs() {
  const f = startupVbs();
  try { return f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').toLowerCase().includes(ROUTER.toLowerCase()) ? f : ''; } catch (e) { return ''; }
}
const oldModelRouter = () => {
  const dir = path.join(CLAUDE, 'model-router');
  try { return /const VERSION = '3\./.test(fs.readFileSync(path.join(dir, 'router.js'), 'utf8')) ? dir : ''; } catch (e) { return ''; }
};
/** 还有要收的吗。钩子每次会话开始都问，只看文件在不在 */
function pending() {
  return fs.existsSync(ROUTER) || fs.existsSync(DATA) || !!ownVbs() || !!oldModelRouter();
}
function portOf() {
  const c = readJson(path.join(DATA, 'config.json'));
  const p = Number(c && c.listen && c.listen.port);
  return p > 0 && p < 65536 ? Math.round(p) : 15730;
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(400, () => done(true));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function askShutdown(port, token) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/internal/shutdown', method: 'POST', timeout: 1500, agent: false, headers: { 'content-type': 'application/json', 'content-length': 2, 'x-vibe-token': token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.on('error', () => resolve(false));
    r.end('{}');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 停这份安装的路由：pid 文件的令牌对得上才算自己的。令牌对不上（别的安装占着端口）不停 */
async function stopOwn(notes) {
  const rec = readJson(path.join(DATA, 'router.pid'));
  if (!rec || !(Number(rec.pid) > 0)) return;
  const pid = Number(rec.pid); const port = Number(rec.port) || portOf();
  let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!e && e.code === 'EPERM'; }
  if (!alive) return;
  if (!rec.token || !(await askShutdown(port, String(rec.token)))) { notes.push('端口 ' + port + ' 上的路由没认这份安装的令牌，没有停它（可能是别的安装的）'); return; }
  for (let i = 0; i < 25 && await portOpen(port); i++) await sleep(200);
  notes.push('模型路由停了');
}
/** 配置页"接上"过的恢复原来的地址。没有记录、原地址为空的不动（这种机器已经提前切走），说一句 */
function restoreSettings(notes) {
  const s = readJson(SETTINGS);
  const env = s && s.env && typeof s.env === 'object' ? s.env : null;
  if (!env || !env.ANTHROPIC_BASE_URL) return;
  let local = false;
  try { const u = new URL(String(env.ANTHROPIC_BASE_URL)); local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname.toLowerCase()) && String(u.port || 80) === String(portOf()); } catch (e) { return; }
  if (!local) return;
  const memo = readJson(path.join(DATA, 'claude-link.json'));
  const prev = memo && memo.prevBaseUrl ? String(memo.prevBaseUrl) : '';
  if (!prev) { notes.push('settings.json 的 ANTHROPIC_BASE_URL 还指着本机路由（' + env.ANTHROPIC_BASE_URL + '），没有接上之前的地址，没动它：路由已经删了，请用 cch 切到网关'); return; }
  env.ANTHROPIC_BASE_URL = prev;
  if (env.ANTHROPIC_AUTH_TOKEN === PLACEHOLDER_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  notes.push('Claude Code 连的地址恢复成接上路由之前的 ' + prev);
}
function cleanConfig() {
  const f = path.join(KIT, 'config.json'); const c = readJson(f);
  if (!c || typeof c !== 'object') return;
  const had = OLD_FIELDS.filter((k) => k in c);
  if (!had.length) return;
  for (const k of had) delete c[k];
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
}
function cleanManifest() {
  const f = path.join(KIT, 'installed.json'); const m = readJson(f);
  if (!m || typeof m !== 'object' || m.router === false) return;
  m.router = false; delete m.autostart;
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
}
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
/** 收一次。返回 { done: 都收完了, notes: 给用户看的话, errors: 这次没收完的，下次再试 } */
async function run() {
  const notes = []; const errors = [];
  const step = async (fn) => { try { await fn(); } catch (e) { errors.push(String((e && e.message) || e)); } };
  if (!pending()) return { done: true, notes, errors };
  await step(() => stopOwn(notes));
  await step(() => { const f = ownVbs(); if (f) fs.unlinkSync(f); });
  await step(() => restoreSettings(notes));
  await step(cleanConfig);
  await step(cleanManifest);
  for (const n of OLD_STATE) await step(() => rm(path.join(KIT, 'state', n)));
  await step(() => { const d = oldModelRouter(); if (d) rm(d); });
  await step(() => rm(ROUTER));
  await step(() => rm(DATA));
  const done = !pending();
  if (done) notes.push('模型路由收回了：程序、配置、key、用量都删了');
  return { done, notes, errors };
}
module.exports = { pending, run, ownVbs };
