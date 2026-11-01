'use strict';
/*
 * 用量：每个请求记一条（成败、token、换没换模型、等没等），每 20 秒落一次盘（usage.json、usage-daily.json、给状态栏的 usage-today.json）；
 * 网关对单次请求大小的上限：实测到才记（state/gateway.json）。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const C = require('./config-file');
const { diagnostic, secrets, USAGE_PATH, DAILY_PATH, TODAY_PATH, KIT_DIR, log, writeAtomic } = require('./base');

const stats = { total: 0, byProvider: {}, byModel: {}, recentLogs: [] };
let daily = {};
try { Object.assign(stats, JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'))); } catch (e) { /* 第一次 */ }
try { daily = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8')); } catch (e) { /* 第一次 */ }
if (!Array.isArray(stats.recentLogs)) stats.recentLogs = [];
if (!daily || typeof daily !== 'object' || Array.isArray(daily)) daily = {};
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
let usageDirty = false;
/**
 * 记一条用量。r.failed：状态码是 200 但其实没成（流里报错、没收全）；r.cancelled：客户端自己取消的（按了 Esc），
 * 算一次请求（它确实发到网关了），但不算这个模型失败。
 */
function record(r) {
  r = diagnostic.tree(r, secrets());
  const cancelled = !!r.cancelled;
  const ok = !cancelled && !r.failed && r.status > 0 && r.status < 400;
  const bucket = cancelled ? 'cancelled' : ok ? 'success' : 'fail';
  // 和对话无关的请求（数 token 之类，上游多半不支持）不算进模型的成败，免得把统计搞花
  if (r.kind === 'messages') {
    stats.total++;
    const bp = stats.byProvider[r.provider] = stats.byProvider[r.provider] || { success: 0, fail: 0 };
    bp[bucket] = (bp[bucket] || 0) + 1;
    const bm = stats.byModel[r.model || '<empty>'] = stats.byModel[r.model || '<empty>'] || { success: 0, fail: 0 };
    bm[bucket] = (bm[bucket] || 0) + 1;
    const day = daily[today()] = daily[today()] || { requests: 0, byProvider: {} };
    day.requests++;
    const dp = day.byProvider[r.provider] = day.byProvider[r.provider] || { requests: 0, fail: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, failover: 0, waits: 0 };
    dp.requests++;
    if (cancelled) dp.cancelled = (dp.cancelled || 0) + 1;
    else if (!ok) dp.fail++;
    dp.input += r.input || 0; dp.output += r.output || 0; dp.cacheRead += r.cacheRead || 0; dp.cacheWrite += r.cacheWrite || 0;
    if (r.failover) dp.failover = (dp.failover || 0) + 1;
    if (r.waitMs) dp.waits = (dp.waits || 0) + 1;
  }
  stats.recentLogs.push({ timestamp: new Date().toISOString(), model: r.model || '<empty>', provider: r.provider, status: r.status, latencyMs: r.headerMs, totalMs: r.totalMs, failover: !!r.failover, waitMs: r.waitMs || 0, kind: r.kind, input: r.input || 0, output: r.output || 0, cacheRead: r.cacheRead || 0, cacheWrite: r.cacheWrite || 0, error: r.error || '', failed: !ok && !cancelled, cancelled });
  if (stats.recentLogs.length > 1000) stats.recentLogs.splice(0, stats.recentLogs.length - 1000);
  usageDirty = true;
}
function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    const days = Object.keys(daily).sort();
    while (days.length > 60) delete daily[days.shift()];
    writeAtomic(USAGE_PATH, JSON.stringify(stats));
    writeAtomic(DAILY_PATH, JSON.stringify(daily));
    // 给套件的状态栏看的：今天的次数、提醒线、各个模型的次数和 token。状态栏刷新得勤，只读这一个小文件
    const t = today();
    const day = daily[t] || { requests: 0, byProvider: {} };
    writeAtomic(TODAY_PATH, JSON.stringify({ day: t, warnAt: C.config.options.dailyRequestWarn, requests: day.requests, byProvider: day.byProvider, at: Date.now() }));
  } catch (e) { /* 忽略 */ }
}
setInterval(flushUsage, 20000).unref();

// ---------- 网关对单次请求大小的限制：不写死、不猜，实测到才算 ----------
// 内网网关（nginx）对请求体有大小上限，超了直接回 413，根本到不了模型，和模型的上下文长度无关。
// 这里只记两件事，写到套件的 state/gateway.json 里给状态栏用：
//   bytesPerToken  平时顺手统计的"每个 token 大约多少字节"（只拿 2 万 token 以上的大请求算，长会话的成分才有代表性）
//   limitBytes     真的被拒过一次才有：被拒的请求里最小的那个大小。之后要是有更大的请求成功了（管理员把上限调大了），就作废
const GATEWAY_FILE = path.join(KIT_DIR, 'state', 'gateway.json');
const gateway = { bytesPerToken: 0, samples: 0, okBytesMax: 0, limitBytes: 0, limitAt: '' };
try { Object.assign(gateway, JSON.parse(fs.readFileSync(GATEWAY_FILE, 'utf8'))); } catch (e) { /* 还没有 */ }
let gatewayDirty = false;
function saveGateway() {
  if (!gatewayDirty) return;
  gatewayDirty = false;
  try { fs.mkdirSync(path.dirname(GATEWAY_FILE), { recursive: true }); writeAtomic(GATEWAY_FILE, JSON.stringify(gateway)); } catch (e) { /* 写不了不影响转发 */ }
}
function learnRatio(bytes, tokens) {
  if (!(bytes > 0) || !(tokens >= 20000)) return;
  const r = bytes / tokens;
  gateway.bytesPerToken = gateway.bytesPerToken ? gateway.bytesPerToken * 0.8 + r * 0.2 : r;
  gateway.samples++;
  if (bytes > gateway.okBytesMax) gateway.okBytesMax = bytes;
  if (gateway.limitBytes && bytes >= gateway.limitBytes) { log('比上次被拒的还大的请求（' + (bytes / 1048576).toFixed(2) + ' MB）成功了，网关的上限看来调大了：作废之前记的上限'); gateway.limitBytes = 0; gateway.limitAt = ''; }
  gatewayDirty = true;
}
function learnLimit(bytes) {
  if (!(bytes > 0)) return;
  if (!gateway.limitBytes || bytes < gateway.limitBytes) gateway.limitBytes = bytes;
  gateway.limitAt = new Date().toISOString();
  if (!gateway.bytesPerToken) gateway.bytesPerToken = 4.3; // 还没来得及统计时先用之前在内网量到的大致比例，后面有了真实数据会被覆盖
  gatewayDirty = true;
  saveGateway();
}
function forgetLimit() { gateway.limitBytes = 0; gateway.limitAt = ''; gatewayDirty = true; saveGateway(); }
const gatewayPublic = () => ({ limitBytes: gateway.limitBytes, limitAt: gateway.limitAt, bytesPerToken: gateway.bytesPerToken, limitTokens: gateway.limitBytes && gateway.bytesPerToken ? Math.round(gateway.limitBytes / gateway.bytesPerToken) : 0, okBytesMax: gateway.okBytesMax });
setInterval(saveGateway, 20000).unref();

module.exports = { stats, daily, today, record, flushUsage, saveGateway, learnRatio, learnLimit, forgetLimit, gatewayPublic };
