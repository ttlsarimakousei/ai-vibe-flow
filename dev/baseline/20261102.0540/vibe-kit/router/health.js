'use strict';
/*
 * 每个模型现在能不能用：冷却（限流、熔断、key 失效之后避开一阵）、额度用完（停用到重置时间，跨重启保留）、
 * 粘住（同一个会话换过模型之后一段时间内留在新模型上），以及上游的错误状态码怎么分类、要不要先等一等。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const C = require('./config-file');
const { scrub, DATA_DIR } = require('./base');

const health = new Map();   // 模型名 -> { until, reason, lastOkAt, lastFailAt, fails }
const sticky = new Map();   // 会话|角色首选 -> { provider, at }
const hOf = (name) => { if (!health.has(name)) health.set(name, { until: 0, reason: '', lastOkAt: 0, lastFailAt: 0, fails: 0, quota: false }); return health.get(name); };
const onCooldown = (name) => hOf(name).until > Date.now();
/** 额度用完、停用到重置时间的（到点自动恢复；配置页"手动恢复"也能提前放开） */
const quotaOut = (name) => { const h = hOf(name); return !!h.quota && h.until > Date.now(); };
function markFail(name, reason, sec) { const h = hOf(name); h.until = Date.now() + sec * 1000; h.reason = scrub(reason); h.lastFailAt = Date.now(); h.fails++; if (h.quota) { h.quota = false; saveQuota(); } }
function markOk(name) { const h = hOf(name); const wasQuota = h.quota; h.until = 0; h.reason = ''; h.lastOkAt = Date.now(); h.fails = 0; h.quota = false; if (wasQuota) saveQuota(); }
/** 额度用完：停用到上游说的重置时间 */
function markQuota(name, until, reason) { const h = hOf(name); h.until = until; h.reason = scrub(reason); h.quota = true; h.lastFailAt = Date.now(); h.fails++; saveQuota(); }
// 额度用完的标记要跨重启保留：停用常常是好几个小时，路由重启（装新版、重启电脑）之后不能又去撞一次
const QUOTA_PATH = path.join(DATA_DIR, 'quota.json');
function saveQuota() {
  const out = {};
  for (const [name, h] of health) if (h.quota && h.until > Date.now()) out[name] = { until: h.until, reason: h.reason };
  try { const tmp = QUOTA_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, QUOTA_PATH); } catch (e) { /* 写不了不影响转发 */ }
}
try {
  const q = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8'));
  for (const name of Object.keys(q || {})) { const e = q[name] || {}; if (Number(e.until) > Date.now()) Object.assign(hOf(name), { until: Number(e.until), reason: String(e.reason || '额度用完'), quota: true }); }
} catch (e) { /* 没有记录 */ }

/**
 * 上游的回复是不是"额度用完"（每日 / 每月额度超限、余额不足这类），是的话什么时候重置。返回 null 或 { until, reason }。
 * 这和一般的限流不一样：等几秒没用，要等到重置时间。重置时间按这个顺序找：
 *   回复 JSON 里的 reset_at / resets_at / reset_time / next_reset 这类字段（ISO 时间，或秒 / 毫秒时间戳）；
 *   说明文字里"将于 <时间> 重置""resets at <时间>"；很长的 retry-after 请求头；
 *   都没有：每日额度到本地明天 0 点，别的按"熔断、key 失效后多久再试"。
 * 离现在不到 5 秒的当普通限流（多半是已经重置了）；最多停用 31 天。
 */
// 只认明确说额度、余额、账单的（审核 P23）：以前 balance、budget、credit 单词出现就算，正文里提到 "load balancer""thinking budget" 也停用 30 分钟，还跨重启保留
// 复审 U-R5：quota、billing 两边可以是下划线（quota_exceeded、billing_hard_limit_reached 这类错误码）；中文补"余额为 0""余额耗尽""欠费""调用次数已达上限"
const QUOTA_WORDS = /额度|配额|余额不足|余额已用完|余额(?:为\s*0|耗尽|用尽)|欠费|用量上限|调用次数已(?:达|到)上限|(?<![a-z])quota(?![a-z])|insufficient[_ ](?:user[_ ])?(?:quota|balance|credits?|funds)|(?<![a-z])billing(?![a-z])|out of credits|credits? (?:exhausted|depleted|exceeded)|(?:credit[_ ])?balance[_ ](?:is[_ ])?too[_ ]low|spend(?:ing)?[_ ]limit|(?:token|usage|monthly|daily|account) budget (?:exceeded|exhausted)|budget[_ ]exceeded|out of budget/i;
const RESET_KEYS = ['reset_at', 'resets_at', 'reset_time', 'resetAt', 'resetsAt', 'reset', 'next_reset', 'next_reset_at', 'quota_reset_at', 'limit_reset_at', 'retry_at', 'available_at'];
function parseWhen(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0; }
  const t = Date.parse(String(v).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'));
  return Number.isFinite(t) ? t : 0;
}
function quotaInfo(status, text, headers) {
  if (![429, 402, 403].includes(status)) return null;
  const body = String(text || '');
  if (!QUOTA_WORDS.test(body)) return null;
  let j = null; try { j = JSON.parse(body); } catch (e) { /* 不是 JSON */ }
  const err = j && typeof j === 'object' ? (j.error && typeof j.error === 'object' ? j.error : j) : {};
  const msg = String(err.message || err.msg || (j && j.message) || body).replace(/\s*\(cch_session_id:[^)]*\)/i, '').replace(/\s+/g, ' ').trim();
  let until = 0;
  for (const src of [err, j || {}]) { for (const k of RESET_KEYS) { if (!until && src && src[k] !== undefined) until = parseWhen(src[k]); } }
  if (!until) {
    const iso = '(\\d{4}-\\d{2}-\\d{2}[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)';
    const m = body.match(new RegExp('(?:将于|将在|于|在)\\s*' + iso + '\\s*(?:重置|恢复|解除|刷新)')) || body.match(new RegExp('reset(?:s|ting)?\\s*(?:at|on|time)?\\s*[:：]?\\s*' + iso, 'i')) || body.match(new RegExp(iso + '\\s*(?:重置|恢复|解除|刷新)'));
    if (m) until = parseWhen(m[1]);
  }
  if (!until) {
    const ra = retryAfterMs(headers || {});
    if (ra > 300000) until = Date.now() + ra;
    // 上游说几分钟内就能再试、或者说的是每分钟 / 每秒的额度：那是一般的限流，照限流处理
    else if (ra > 0 || /每分钟|每秒|per[_ ]?(minute|second)|\b[rt]pm\b|\b[rt]ps\b/i.test(body)) return null;
  }
  if (!until) {
    if (/每日|今日|日额度|daily|per[_ ]day/i.test(body)) { const d = new Date(); d.setHours(24, 0, 0, 0); until = d.getTime(); }
    else until = Date.now() + C.config.options.outageCooldownSec * 1000;
  }
  if (until < Date.now() + 5000) return null;
  until = Math.min(until, Date.now() + 31 * 86400000);
  return { until, reason: '额度用完（' + (msg.length > 80 ? msg.slice(0, 80) + '…' : msg) + '）' };
}
/** 停用到的时间，给人看：今天的只写几点，别的带日期 */
function whenText(t) {
  const d = new Date(t); const now = new Date(); const p = (n) => String(n).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  return d.toDateString() === now.toDateString() ? '今天 ' + hm : (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm;
}
const stickyAlive = (st) => !!st && Date.now() - st.at < C.config.options.stickyMinutes * 60000;
setInterval(() => { for (const [k, v] of sticky) if (!stickyAlive(v)) sticky.delete(k); }, 300000).unref();
/** 上游回了错误状态码：要不要换模型，这个模型要避开多久（sec 为 0 表示只这一次换，不记它的过） */
function classify(status, body, isMessages) {
  const o = C.config.options;
  const text = String(body || '');
  if (status === 429) return { failover: true, sec: o.cooldownSec, reason: '限流（429）' };
  if (status >= 500) {
    if (/no_available_providers|No available providers/i.test(text)) return { failover: true, sec: o.outageCooldownSec, reason: '熔断：上游没有可用通道（' + status + '）' };
    if (status === 529) return { failover: true, sec: o.cooldownSec, reason: '过载（529）' };
    return { failover: true, sec: o.cooldownSec, reason: '上游出错（' + status + '）' };
  }
  if (status === 401 || status === 403) return { failover: true, sec: o.outageCooldownSec, reason: 'key 无效、没有权限或额度用完（' + status + '）' };
  // 404 可能是地址不对，也可能只是它不认识这个模型名。换一个试，但不冷却：不能因为一个角色的模型名不认识，就让别的角色也用不了它
  if (status === 404 && isMessages) return { failover: true, sec: 0, reason: '地址不对或不认识这个模型名（404）' };
  return { failover: false };
}
/** 上游的 retry-after / retry-after-ms 请求头：秒数、毫秒数或 HTTP 日期，换算成毫秒；没有就 0 */
function retryAfterMs(h) {
  const ms = Number(h['retry-after-ms']);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const v = h['retry-after'];
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}
/** 429、529、带 retry-after 的 503：多半过几秒就好，先在同一个模型上等（不熔断的那种 503 才算） */
function waitableStatus(status, raMs, text) {
  if (status === 429 || status === 529) return true;
  return status === 503 && raMs > 0 && !/no_available_providers|No available providers/i.test(String(text || ''));
}
const clampSec = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

module.exports = { health, sticky, hOf, onCooldown, quotaOut, markFail, markOk, markQuota, saveQuota, QUOTA_WORDS, parseWhen, quotaInfo, whenText, stickyAlive, classify, retryAfterMs, waitableStatus, clampSec };
