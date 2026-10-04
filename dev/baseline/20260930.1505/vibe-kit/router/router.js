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
 * 只用 Node 自带模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const VERSION = '3.0';
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const CONFIG_PATH = argOf('-c') ? path.resolve(argOf('-c')) : path.join(__dirname, 'config.json');
const DATA_DIR = path.dirname(CONFIG_PATH);
const LAST_GOOD = path.join(DATA_DIR, 'config.last-good.json');
const BACKUP_DIR = path.join(DATA_DIR, 'config-backups');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
const DAILY_PATH = path.join(DATA_DIR, 'usage-daily.json');
const LOG_PATH = path.join(DATA_DIR, 'router.log');
// pid 文件：service.js 停路由时靠它认出"端口上的是不是这个路由"，并带上里面的令牌请它自己保存用量、退出
const PID_PATH = path.join(DATA_DIR, 'router.pid');
const RUN_TOKEN = crypto.randomBytes(24).toString('hex');
const UI_PATH = path.join(__dirname, 'ui.html');
const overridePort = argOf('-p') ? parseInt(argOf('-p'), 10) : null;
// 套件目录按这个文件自己所在的位置定（~/.claude/vibe-kit/router/router.js → ~/.claude/vibe-kit），不看环境变量：
// 路由可能是登录时由"启动"文件夹拉起来的，那时候没有任何自定义的环境变量。VIBE_KIT_DIR 只给测试用。
const KIT_DIR = process.env.VIBE_KIT_DIR || path.dirname(__dirname);

// 首字节超时要小于 Claude Code 自己的超时（默认 600 秒），不然它先放弃了，换模型就来不及
const DEFAULT_OPTIONS = { cooldownSec: 300, outageCooldownSec: 1800, firstByteTimeoutSec: 300, rateLimitWaitSec: 20, bigRequestBytes: 300000, stickySession: true, stickyMinutes: 10, dailyRequestWarn: 4000, testModel: 'claude-sonnet-4-5' };
const CONNECT_COOLDOWN_SEC = 60;      // 连接层面的错误：所有模型走同一个网关，多半不是这一个模型的问题，只短暂避开
const ERROR_BODY_TIMEOUT_MS = 15000;  // 上游回了错误状态码却迟迟不把正文发完
// 客户端自己断开（绝大多数是用户按了 Esc）不算模型的错，不冷却任何模型，只在用量里记一条"客户端取消"

// ---------- 日志 ----------
// 由 service.js 在后台拉起时，标准输出接的是数据目录里的 router.out.log（一个文件）：每行都写进去等于把 router.log 再存一份，
// 而且一次运行期间没有上限。所以标准输出是文件时不往控制台写（router.log 里都有，满 5 MB 轮换）；
// 在终端里跑、或者被别的程序用管道读的时候照常输出。
const LOG_TO_CONSOLE = (() => { try { return !fs.fstatSync(1).isFile(); } catch (e) { return true; } })();
function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg;
  if (LOG_TO_CONSOLE) console.log(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) { /* 日志写不了不影响转发 */ }
}
process.on('uncaughtException', (e) => log('未捕获的异常（已忽略，路由继续运行）：' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('未处理的拒绝（已忽略）：' + (e && e.stack || e)));

// ---------- 配置 ----------
/** 数值一律收进合理范围：配置页里把输入框清空、手改成 0 或 null，都不能让路由变成"每个请求立刻超时" */
function cleanOptions(o) {
  const src = o && typeof o === 'object' ? o : {};
  const num = (k, min, max) => { const v = src[k] === undefined || src[k] === null || src[k] === '' ? NaN : Number(src[k]); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : DEFAULT_OPTIONS[k]; };
  return {
    cooldownSec: num('cooldownSec', 10, 86400),
    outageCooldownSec: num('outageCooldownSec', 10, 86400),
    firstByteTimeoutSec: num('firstByteTimeoutSec', 30, 3600),
    rateLimitWaitSec: num('rateLimitWaitSec', 0, 300),
    bigRequestBytes: num('bigRequestBytes', 0, 50000000),
    stickySession: src.stickySession === undefined ? DEFAULT_OPTIONS.stickySession : !!src.stickySession,
    stickyMinutes: num('stickyMinutes', 1, 1440),
    dailyRequestWarn: num('dailyRequestWarn', 0, 100000000),
    testModel: typeof src.testModel === 'string' && src.testModel.trim() ? src.testModel.trim() : DEFAULT_OPTIONS.testModel,
  };
}
function normalize(raw) {
  let c = raw;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('顶层必须是一个对象');
  c.providers = (Array.isArray(c.providers) ? c.providers : []).filter((p) => p && typeof p === 'object');
  c.routes = (Array.isArray(c.routes) ? c.routes : []).filter((r) => r && typeof r === 'object').map((r) => Object.assign({}, r, { match: Array.isArray(r.match) ? r.match.map(String) : [] }));
  c.default = c.default && typeof c.default === 'object' ? c.default : { provider: (c.providers[0] || {}).name || '' };
  const l = c.listen && typeof c.listen === 'object' ? c.listen : {};
  c.listen = { host: typeof l.host === 'string' && l.host ? l.host : '127.0.0.1', port: Number(l.port) > 0 && Number(l.port) < 65536 ? Math.round(Number(l.port)) : 15730 };
  c.failover = (Array.isArray(c.failover) ? c.failover : []).map(String);
  c.options = cleanOptions(c.options);
  return c;
}
const HEADER_SAFE = /^[\x21-\x7e]+$/;
/** 这个模型配得对不对。返回空串表示没问题 */
function providerProblem(p) {
  if (!p.name || typeof p.name !== 'string') return '没有名称';
  try { const u = new URL(p.base_url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch (e) { return '地址不合法：' + p.base_url; }
  if (!p.api_key) return '没有填 key';
  if (!HEADER_SAFE.test(String(p.api_key))) return 'key 里有不能用的字符（空格、中文、全角或看不见的字符，多半是复制时带进来的）';
  return '';
}
/** 整份配置里的问题。从文件加载时只当警告（有问题的模型跳过，别的照常用）；从配置页保存时当错误（人就在旁边，当场改） */
function problemsOf(c) {
  const out = [];
  const names = new Set();
  for (const p of c.providers) {
    if (!p.name) { out.push('有一个模型没有名称'); continue; }
    if (names.has(p.name)) out.push('模型名称重复：' + p.name);
    names.add(p.name);
    const prob = providerProblem(p);
    if (prob && p.enabled !== false) out.push(p.name + '：' + prob);
  }
  for (const r of c.routes) {
    if (!r.match.length) out.push('有一条角色分配没有写匹配词');
    if (!names.has(r.provider)) out.push('角色 ' + r.match.join('/') + ' 指向了不存在的模型：' + r.provider);
  }
  if (c.providers.length && !names.has(c.default.provider)) out.push('默认模型不存在：' + c.default.provider);
  for (const n of c.failover) if (!names.has(n)) out.push('失败切换顺序里有不存在的模型：' + n);
  return out;
}
function parseConfigFile(file) {
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return normalize(JSON.parse(raw));
}

let config = normalize({});
let configError = '';       // 文件读不了、不是合法 JSON：整份不能用
let configWarnings = [];    // 个别地方配得不对：跳过那一处
let configSource = '';
function loadConfig(isReload) {
  try {
    config = parseConfigFile(CONFIG_PATH);
    configError = '';
    configSource = CONFIG_PATH;
    configWarnings = problemsOf(config);
    try { fs.writeFileSync(LAST_GOOD, JSON.stringify(config, null, 2)); } catch (e) { /* 忽略 */ }
    if (isReload) log('配置已重新加载：' + config.providers.map((p) => p.name).join('、'));
    if (configWarnings.length) log('配置里有几处不对（已跳过，其余照常用）：' + configWarnings.join('；'));
    return true;
  } catch (e) {
    configError = (fs.existsSync(CONFIG_PATH) ? '配置文件有问题：' : '还没有配置文件：') + e.message;
    log(configError + (isReload ? '。继续用上一份好的配置' : ''));
    if (!isReload) {
      try { config = parseConfigFile(LAST_GOOD); configSource = LAST_GOOD; log('已改用上一份好的配置 ' + LAST_GOOD); } catch (e2) { config = normalize({}); configSource = ''; }
      configWarnings = problemsOf(config);
    }
    return false;
  }
}
/** 配置文件现在的版本（内容的哈希）。配置页拿到状态时记下，保存时交回来核对：中间有人手改过文件，就不拿页面上的旧内容把它冲掉 */
function configVersion() {
  try { return crypto.createHash('sha1').update(fs.readFileSync(CONFIG_PATH)).digest('hex').slice(0, 16); } catch (e) { return ''; }
}
function saveConfig(next) {
  const c = normalize(JSON.parse(JSON.stringify(next)));
  const probs = problemsOf(c);
  if (probs.length) throw new Error(probs.join('；'));
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    // 文件名带毫秒，同名就加序号：一秒内连着保存两次，后一份备份不能把前一份盖掉
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + String(d.getMilliseconds()).padStart(3, '0');
    let to = path.join(BACKUP_DIR, 'config-' + stamp + '.json');
    for (let n = 2; fs.existsSync(to); n++) to = path.join(BACKUP_DIR, 'config-' + stamp + '-' + n + '.json');
    fs.copyFileSync(CONFIG_PATH, to);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^config-.*\.json$/.test(f)).sort();
    while (old.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
  }
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  loadConfig(true);
}
loadConfig(false);
// 实际监听的地址和配置文件里写的分开：-p 临时指定的端口不能在配置页保存时被写进文件
const LISTEN = { host: config.listen.host, port: overridePort || config.listen.port };
const LISTEN_IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(LISTEN.host);
let lastMtime = 0;
try { lastMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch (e) { /* 还没有 */ }
setInterval(() => {
  try { const m = fs.statSync(CONFIG_PATH).mtimeMs; if (m !== lastMtime) { lastMtime = m; loadConfig(true); } } catch (e) { /* 文件暂时不在 */ }
}, 1500).unref();

// ---------- 运行状态 ----------
const health = new Map();   // 模型名 -> { until, reason, lastOkAt, lastFailAt, fails }
const sticky = new Map();   // 会话|角色首选 -> { provider, at }
const bigTimeouts = new Map();   // 模型名 -> 大请求连续超时次数（一次不算卡住，两次才换模型）
const noCountTokens = new Map(); // 模型名 -> 上次 count_tokens 被回 404 的时间（上游不支持这个接口，就不用每次都把整个会话传过去）
const hOf = (name) => { if (!health.has(name)) health.set(name, { until: 0, reason: '', lastOkAt: 0, lastFailAt: 0, fails: 0, quota: false }); return health.get(name); };
const onCooldown = (name) => hOf(name).until > Date.now();
/** 额度用完、停用到重置时间的（到点自动恢复；配置页"手动恢复"也能提前放开） */
const quotaOut = (name) => { const h = hOf(name); return !!h.quota && h.until > Date.now(); };
function markFail(name, reason, sec) { const h = hOf(name); h.until = Date.now() + sec * 1000; h.reason = reason; h.lastFailAt = Date.now(); h.fails++; if (h.quota) { h.quota = false; saveQuota(); } }
function markOk(name) { const h = hOf(name); const wasQuota = h.quota; h.until = 0; h.reason = ''; h.lastOkAt = Date.now(); h.fails = 0; h.quota = false; if (wasQuota) saveQuota(); }
/** 额度用完：停用到上游说的重置时间 */
function markQuota(name, until, reason) { const h = hOf(name); h.until = until; h.reason = reason; h.quota = true; h.lastFailAt = Date.now(); h.fails++; saveQuota(); }
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
const QUOTA_WORDS = /额度|配额|余额|用量上限|quota|insufficient_(quota|balance)|billing|credit|balance|spend(ing)?[_ ]limit|budget/i;
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
    else until = Date.now() + config.options.outageCooldownSec * 1000;
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
const stickyAlive = (st) => !!st && Date.now() - st.at < config.options.stickyMinutes * 60000;
setInterval(() => { for (const [k, v] of sticky) if (!stickyAlive(v)) sticky.delete(k); }, 300000).unref();

// ---------- 用量 ----------
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
/** 先写临时文件再改名：写到一半断电、被结束，留下的也是上一份完整的文件，不会是半截 */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    const days = Object.keys(daily).sort();
    while (days.length > 60) delete daily[days.shift()];
    writeAtomic(USAGE_PATH, JSON.stringify(stats));
    writeAtomic(DAILY_PATH, JSON.stringify(daily));
  } catch (e) { /* 忽略 */ }
}
setInterval(flushUsage, 20000).unref();
/** 退出前保存用量和网关记录、删掉自己的 pid 文件。收到 Ctrl+C、SIGTERM，或者 service.js 带令牌请它停时都走这里 */
let exiting = false;
function shutdown(why) {
  if (exiting) return;
  exiting = true;
  try { flushUsage(); } catch (e) { /* 忽略 */ }
  try { saveGateway(); } catch (e) { /* 忽略 */ }
  try { if (hookHost) hookHost.close(); } catch (e) { /* 忽略 */ }
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

// ---------- 转发 ----------
function sessionOf(parsed, headers) {
  const id = (headers && headers['x-claude-code-session-id']) || (parsed && parsed.metadata && parsed.metadata.user_id);
  return id ? crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12) : '';
}
const usableProviders = () => config.providers.filter((p) => p.enabled !== false && !providerProblem(p));
function candidatesFor(model, session, isMessages) {
  const byName = new Map();
  for (const p of usableProviders()) if (!byName.has(p.name)) byName.set(p.name, p);
  const order = [];
  const push = (n) => { if (n && byName.has(n) && !order.includes(n)) order.push(n); };
  if (isMessages) {
    const m = String(model || '').toLowerCase();
    const route = config.routes.find((r) => r.match.some((k) => m.includes(String(k).toLowerCase())));
    if (route) push(route.provider);
  }
  push(config.default.provider);
  const primary = order[0] || '';
  const stickyKey = isMessages && session && primary ? session + '|' + primary : '';
  config.failover.forEach(push);
  config.providers.forEach((p) => push(p.name));
  // 这个会话刚换过模型，就继续用换过去的那个，除非它自己也不行了
  const st = config.options.stickySession && stickyKey ? sticky.get(stickyKey) : null;
  if (stickyAlive(st) && byName.has(st.provider) && !onCooldown(st.provider)) { order.splice(order.indexOf(st.provider), 1); order.unshift(st.provider); }
  // 冷却中的排到最后，但不全丢掉：只带最快到期的那一个。都在冷却时一个请求最多多试一次，不把整个上下文轮着发给每一个模型。
  // 额度用完的不在"多试一次"之列（到重置时间之前试了也是被拒），排在最末尾只为了最后报错时说清楚
  const live = order.filter((n) => !onCooldown(n));
  const cold = order.filter((n) => onCooldown(n) && !quotaOut(n)).sort((a, b) => hOf(a).until - hOf(b).until).slice(0, 1);
  const out = order.filter((n) => quotaOut(n));
  return { list: live.concat(cold, out).map((n) => byName.get(n)), stickyKey, primary };
}
/** 上游回了错误状态码：要不要换模型，这个模型要避开多久（sec 为 0 表示只这一次换，不记它的过） */
function classify(status, body, isMessages) {
  const o = config.options;
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
const snippet = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 240);
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
/** 连不上 HTTPS 网关的原因是证书校验没通过时，说清楚怎么办 */
function certProblem(e) {
  const s = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME|certificate/i.test(s)
    ? '证书校验没通过（' + ((e && (e.code || e.message)) || '') + '）：网关用的多半是自签证书，在这个模型的设置里取消"校验证书"就能连' : '';
}
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
function sendError(res, status, type, message, extraHeaders) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { try { res.end(); } catch (e) { /* 已经断了 */ } return; }
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/**
 * 从经过的回复里读 token 用量，不改动、不缓冲数据本身。流式回复顺带看两件事：
 *   error    上游先回了 200，又在流里发了 event: error（比如 overloaded_error）：这次其实没成
 *   stopped  收到了 message_stop。没收到就结束的流是半截的
 */
function usageTap(contentType) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const take = (x) => { if (!x) return; if (x.input_tokens != null) u.input = x.input_tokens; if (x.output_tokens != null) u.output = x.output_tokens; if (x.cache_read_input_tokens != null) u.cacheRead = x.cache_read_input_tokens; if (x.cache_creation_input_tokens != null) u.cacheWrite = x.cache_creation_input_tokens; };
  const sse = /event-stream/i.test(contentType || '');
  const dec = new StringDecoder('utf8');
  let buf = '';
  let eventName = '';
  const tap = { usage: u, sse, error: null, stopped: false };
  const onLine = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') { eventName = ''; return; }
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); if (eventName === 'message_stop') tap.stopped = true; return; }
    if (!line.startsWith('data:')) return;
    // 绝大多数是 content_block_delta，不含这几个词的行不解析，省事
    const maybeErr = eventName === 'error' || line.indexOf('"error"') >= 0;
    if (line.indexOf('"usage"') < 0 && !maybeErr && line.indexOf('message_stop') < 0) return;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch (e) { if (eventName === 'error') tap.error = { type: 'error', message: line.slice(5).trim().slice(0, 200) }; return; }
    if (!ev || typeof ev !== 'object') return;
    take(ev.usage); take(ev.message && ev.message.usage);
    if (ev.type === 'message_stop') tap.stopped = true;
    if (ev.type === 'error' || eventName === 'error') { const e = ev.error && typeof ev.error === 'object' ? ev.error : {}; tap.error = { type: String(e.type || ev.type || 'error'), message: String(e.message || '') }; }
  };
  tap.feed = (chunk) => {
    if (!sse) { if (buf.length <= 2 * 1024 * 1024) buf += dec.write(chunk); return; }
    buf += dec.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
    if (buf.length > 2 * 1024 * 1024) buf = ''; // 一行超过 2 MB 的不是正常的事件，丢掉，别越攒越多
  };
  tap.end = () => {
    buf += dec.end();
    if (sse) { if (buf) onLine(buf); buf = ''; return; }
    try { take(JSON.parse(buf).usage); } catch (e) { /* 不是 JSON */ }
  };
  return tap;
}

// 这些请求头是"这一跳"的事，不能原样带给上游；content-length 会按实际发出的正文重算
const HOP_HEADERS = ['host', 'content-length', 'accept-encoding', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'expect', 'te', 'upgrade'];

function forward(ctx, list, idx, tried) {
  const { req, res, body, parsed, model, stickyKey, primary, isMessages } = ctx;
  if (res.destroyed || res.writableEnded) return; // 客户端已经走了
  // 每次尝试前重新看一眼冷却：候选列表是请求进来时排的，这之间别的请求可能刚把某个模型打进冷却（并发时常见），
  // 不能再把整个上下文发给它。冷却中的跳过；剩下的全在冷却时，整个请求只多试一次最快到期的那个（和排候选时的规则一样）
  if (isMessages) {
    while (idx < list.length && onCooldown(list[idx].name)) {
      const rest = list.slice(idx);
      if (!ctx.coldTried && rest.every((p) => onCooldown(p.name))) {
        ctx.coldTried = true;
        const tryable = rest.filter((p) => !quotaOut(p.name));
        if (tryable.length) {
          const pick = tryable.slice().sort((a, b) => hOf(a.name).until - hOf(b.name).until)[0];
          list = list.slice(0, idx).concat([pick], rest.filter((p) => p !== pick));
          break;
        }
      }
      const skip = list[idx];
      const hs = hOf(skip.name);
      tried.push({ name: skip.name, reason: quotaOut(skip.name) ? hs.reason + '，' + whenText(hs.until) + ' 自动恢复' : '冷却中，这次没试（' + (hs.reason || '刚失败过') + '）' });
      log((model || req.url) + ' -> ' + skip.name + ' ' + (quotaOut(skip.name) ? '额度用完，' + whenText(hs.until) + ' 才恢复' : '正在冷却（' + hs.reason + '）') + '，跳过');
      idx++;
    }
  }
  if (idx >= list.length) {
    const ui = 'http://127.0.0.1:' + LISTEN.port + '/ui';
    const anyQuota = tried.some((t) => /额度用完/.test(t.reason));
    const msg = tried.length
      ? '所有模型都不可用：' + tried.map((t) => t.name + '（' + t.reason + '）').join('、') + '。打开 ' + ui + ' 查看状态或换模型。'
        + (anyQuota ? '额度用完的到点自动恢复；额度提前恢复了（比如找管理员加了），在那个页面上点这个模型的"手动恢复"。' : '')
      : '路由里还没有可用的模型。打开 ' + ui + ' 添加。' + (configError ? '（' + configError + '）' : '') + (configWarnings.length ? '（' + configWarnings.join('；') + '）' : '');
    log('全部失败：' + msg);
    // 告诉 Claude Code 过多久再来（最快到期的冷却还剩几秒），它会按这个退避，不会几秒一次地重发整个会话。都是限流就回 429
    const untils = usableProviders().map((p) => hOf(p.name).until).filter((u) => u > Date.now());
    const retryAfter = untils.length ? Math.min(60, Math.max(3, Math.ceil((Math.min.apply(null, untils) - Date.now()) / 1000))) : 5;
    const allRate = tried.length > 0 && tried.every((t) => /限流|额度用完/.test(t.reason));
    return sendError(res, allRate ? 429 : 503, allRate ? 'rate_limit_error' : 'api_error', msg, { 'Retry-After': String(retryAfter) });
  }
  const provider = list[idx];
  const kind = isMessages ? 'messages' : 'other';
  const label = model || req.url;
  const started = Date.now();
  let settled = false; // 这一次尝试已经有结论了（成功开始转发、失败、客户端走了）
  let up = null;
  let timer = null;

  const fail = (reason, sec, status, errText) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // 和对话无关的请求失败，不影响这个模型的状态
    if (isMessages && sec > 0) markFail(provider.name, reason, sec);
    log(label + ' -> ' + provider.name + ' 失败：' + reason + (errText ? '｜' + snippet(errText) : '') + (idx + 1 < list.length ? '，换 ' + list[idx + 1].name : ''));
    record({ kind, model, provider: provider.name, status: status || 502, headerMs: Date.now() - started, totalMs: Date.now() - started, failover: idx > 0, error: reason + (errText ? '｜' + snippet(errText) : '') });
    tried.push({ name: provider.name, reason });
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    forward(ctx, list, idx + 1, tried);
  };
  // 客户端断开时由 handleProxy 里登记的 close 事件调用。绝大多数是用户按了 Esc：不是模型的错，不冷却任何模型，只记一条"客户端取消"
  ctx.abort = () => {
    ctx.clientGone = true;
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      const waited = Date.now() - started;
      log(label + ' -> ' + provider.name + ' 客户端取消了（等了 ' + Math.round(waited / 1000) + ' 秒，上游还没回应）');
      record({ kind, model, provider: provider.name, status: 499, headerMs: waited, totalMs: waited, failover: idx > 0, cancelled: true, error: '客户端取消（等了 ' + Math.round(waited / 1000) + ' 秒，上游还没回应）' });
    }
    if (up) up.destroy();
  };

  const onResponse = (ur) => {
    clearTimeout(timer);
    if (settled) { ur.resume(); return; }
    const headerMs = Date.now() - started;
    const status = ur.statusCode || 0;

    if (status >= 400) {
      // 出错的回复都很小，收齐了再决定是换模型还是原样交回去；迟迟收不齐也要有个了断
      const parts = []; let size = 0; let decided = false;
      const decide = (complete) => {
        if (decided) return;
        decided = true;
        clearTimeout(bodyTimer);
        if (!complete) up.destroy();
        const raw = Buffer.concat(parts);
        const text = raw.toString('utf8');
        if (status === 413) {
          if (settled) return;
          settled = true;
          const mb = (ctx.sentBytes / 1048576).toFixed(1);
          learnLimit(ctx.sentBytes);
          log(label + ' -> ' + provider.name + ' 413：请求体 ' + mb + ' MB 超过网关上限');
          record({ kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0, error: '请求体 ' + mb + ' MB 超过网关上限' });
          return sendError(res, 413, 'request_too_large', '会话太长了：这次请求有 ' + mb + ' MB，超过了内网网关约 1 MB 的上限。这和模型的上下文长度无关，换模型、/compact 都没用（它们同样要把整个会话发出去）。请开新会话继续；以后状态栏到交接线就执行 /ttls-handover。');
        }
        // 额度用完（每日额度超限这类）：等几秒没用，不等，直接换模型；这个模型停用到上游说的重置时间，到点自动恢复，
        // 配置页"手动恢复"可以提前放开（比如找管理员加了额度）
        const quota = isMessages && !settled ? quotaInfo(status, text, ur.headers) : null;
        if (quota) {
          markQuota(provider.name, quota.until, quota.reason);
          return fail(quota.reason + '，' + whenText(quota.until) + ' 自动恢复', 0, status, text);
        }
        // 限流（429）、过载（529）、暂时不可用（带 retry-after 的 503）：先在同一个模型上等一会儿再试，不马上换模型。
        // 换模型意味着另一个模型要把整个上下文从头算一遍（缓存全丢、占着它），而这些多半是几秒钟的事。
        // 等多久听上游的 retry-after；没有就 5、5、10 秒地试，总共不超过 rateLimitWaitSec（也不超过客户端自己的超时减 20 秒）
        const ra = retryAfterMs(ur.headers);
        const waitable = isMessages && waitableStatus(status, ra, text);
        const what = status === 429 ? '限流（429）' : status === 529 ? '过载（529）' : '暂时不可用（' + status + '）';
        if (waitable && config.options.rateLimitWaitSec > 0 && !settled) {
          const budget = Math.min(config.options.rateLimitWaitSec, ctx.clientCapSec) * 1000;
          const step = Math.round(ra > 0 ? ra : Math.min(10000, 5000 * Math.pow(2, Math.max(0, ctx.waits - 1))));
          if (ctx.waitedMs + step <= budget) {
            settled = true;
            ctx.waits++; ctx.waitedMs += step;
            log(label + ' -> ' + provider.name + ' ' + what + '，' + (ra > 0 ? '按它说的等 ' : '等 ') + Math.round(step / 1000) + ' 秒后再试同一个模型（不换模型，免得让另一个模型把整个上下文重新算一遍）');
            record({ kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0, waitMs: step, error: what + '，等 ' + Math.round(step / 1000) + ' 秒后重试同一个模型' });
            ctx.pending = setTimeout(() => { ctx.pending = null; forward(ctx, list, idx, tried); }, step);
            return;
          }
        }
        // 大请求遇到网关先回 502 / 504（多半是网关自己等超时了）：和路由自己的首字节计时器到点一样处理——不换模型，
        // 交回给 Claude Code 让它自己重试；同一个模型连续两次这样才换。换了等于让另一个模型把整个上下文再算一遍
        if (isMessages && ctx.big && (status === 502 || status === 504) && !settled && (bigTimeouts.get(provider.name) || 0) < 1) {
          bigTimeouts.set(provider.name, 1);
          settled = true;
          const mb = (ctx.sentBytes / 1048576).toFixed(2);
          log(label + ' -> ' + provider.name + ' 网关回了 ' + status + '（请求 ' + mb + ' MB，多半是网关自己等超时了）。大请求不换模型，交回给 Claude Code 让它自己重试；再来一次就换' + (text ? '｜' + snippet(text) : ''));
          record({ kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0, error: '大请求网关回 ' + status + '，没换模型' + (text ? '｜' + snippet(text) : '') });
          return sendError(res, status, 'api_error', '模型 ' + provider.name + ' 这次没回应（网关回了 ' + status + '，多半是网关自己等超时了）。这次请求有 ' + mb + ' MB，大请求路由不换模型（换了会让另一个模型把整个上下文再算一遍，拖慢别人）。Claude Code 会自己重试；连续两次这样才会换模型。');
        }
        if (!isMessages && status === 404 && req.url.startsWith('/v1/messages/count_tokens')) noCountTokens.set(provider.name, Date.now());
        // 和对话无关的请求：上游回什么就原样交回什么，不换模型
        const c = isMessages ? classify(status, text, true) : { failover: false };
        if (c.failover && waitable) {
          // 冷却多久听上游的 retry-after（夹在 10 到 300 秒之间）；它没说就用配置里的
          if (ra > 0) c.sec = clampSec(ra / 1000, 10, 300);
          if (ctx.waitedMs) c.reason = status === 429 ? '限流（429），等了 ' + Math.round(ctx.waitedMs / 1000) + ' 秒仍然限流' : what + '，等了 ' + Math.round(ctx.waitedMs / 1000) + ' 秒仍然不行';
        }
        if (c.failover) return fail(c.reason, c.sec, status, text);
        if (!complete) return fail('上游的错误回复没收全（' + status + '）', CONNECT_COOLDOWN_SEC, status, text);
        if (settled) return;
        settled = true;
        record({ kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0, error: snippet(text) });
        const h = Object.assign({}, ur.headers); for (const k of ['transfer-encoding', 'connection', 'keep-alive', 'content-length']) delete h[k];
        h['content-length'] = String(raw.length);
        res.writeHead(status, h); res.end(raw);
      };
      const bodyTimer = setTimeout(() => decide(false), ERROR_BODY_TIMEOUT_MS);
      ur.on('data', (c) => { if (size < 262144) { parts.push(c); size += c.length; } });
      ur.on('end', () => decide(true));
      ur.on('error', () => decide(false));
      ur.on('aborted', () => decide(false));
      return;
    }

    // 正常回复：边收边转
    settled = true;
    if (isMessages) {
      markOk(provider.name);
      bigTimeouts.delete(provider.name);
      // 落在了不是本角色首选的模型上，就记住（第一次记的时间为准，到点回首选）；回到首选了就忘掉
      if (stickyKey && config.options.stickySession) {
        if (provider.name === primary) sticky.delete(stickyKey);
        else { const st = sticky.get(stickyKey); if (!stickyAlive(st) || st.provider !== provider.name) sticky.set(stickyKey, { provider: provider.name, at: Date.now() }); }
      }
    }
    const h = Object.assign({}, ur.headers); for (const k of ['transfer-encoding', 'connection', 'keep-alive']) delete h[k];
    res.writeHead(status, h);
    if (res.flushHeaders) res.flushHeaders();
    const tap = usageTap(ur.headers['content-type']);
    const idleMs = config.options.firstByteTimeoutSec * 1000;
    let finished = false;
    let idle = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(idle);
      tap.end();
      const base = { kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0 };
      // 客户端先走了（按了 Esc）：是它取消的。路由随后主动断开上游，那次断开不能记成"上游中途断开"
      if (ctx.clientGone) {
        log(label + ' -> ' + provider.name + ' 回复传到一半，客户端取消了');
        record(Object.assign(base, { cancelled: true, error: '客户端取消（回复传到一半）' }, tap.usage));
        try { up.destroy(); } catch (e) { /* 已经断了 */ }
        return;
      }
      if (err) {
        // 半截回复不能装成正常结束：把客户端的连接也断开，它才知道没收全、会自己重试
        log(label + ' -> ' + provider.name + ' 回复传到一半断了：' + err);
        record(Object.assign(base, { failed: true, error: '传输中断：' + err }, tap.usage));
        try { res.destroy(); } catch (e) { /* 已经断了 */ }
        try { up.destroy(); } catch (e) { /* 已经断了 */ }
        return;
      }
      if (isMessages && tap.sse && tap.error) {
        // 先回了 200，又在流里报错（比如 overloaded_error）：这次其实没成。已经转给客户端的内容原样不动，它自己会处理这个错误
        const e = tap.error;
        const overloaded = e.type === 'overloaded_error';
        if (overloaded) markFail(provider.name, '过载（流里报 overloaded_error）', config.options.cooldownSec);
        log(label + ' -> ' + provider.name + ' 先回了 200，又在流里报错：' + e.type + (e.message ? '｜' + snippet(e.message) : '') + (overloaded ? '。这个模型冷却 ' + config.options.cooldownSec + ' 秒' : ''));
        record(Object.assign(base, { failed: true, error: '流里报错：' + e.type + (e.message ? '｜' + snippet(e.message) : '') }, tap.usage));
      } else if (isMessages && tap.sse && !tap.stopped) {
        log(label + ' -> ' + provider.name + ' 回复没有 message_stop 就结束了（是半截的）');
        record(Object.assign(base, { failed: true, error: '传输中断：上游没发 message_stop 就结束了（回复是半截的）' }, tap.usage));
      } else {
        if (isMessages) learnRatio(ctx.sentBytes, tap.usage.input + tap.usage.cacheRead + tap.usage.cacheWrite);
        record(Object.assign(base, { error: '' }, tap.usage));
      }
      try { res.end(); } catch (e) { /* 客户端已经断了 */ }
    };
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => finish('上游 ' + Math.round(idleMs / 1000) + ' 秒没有再发数据'), idleMs); };
    armIdle();
    ur.on('data', (c) => { armIdle(); res.write(c); if (isMessages) tap.feed(c); });
    ur.on('end', () => finish(ur.complete === false ? '上游没发完就断了' : ''));
    ur.on('error', (e) => finish((e && e.message) || '上游断了'));
    ur.on('aborted', () => finish('上游中途断开'));
    ur.on('close', () => finish(ur.complete ? '' : '上游中途断开'));
  };

  try {
    const target = new URL(provider.base_url);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, req.headers);
    for (const k of HOP_HEADERS) delete headers[k];
    headers['x-api-key'] = provider.api_key;
    headers['authorization'] = 'Bearer ' + provider.api_key;
    let sendBody = body;
    if (provider.model_override && parsed) sendBody = Buffer.from(JSON.stringify(Object.assign({}, parsed, { model: provider.model_override })), 'utf8');
    if (sendBody.length) headers['content-length'] = String(sendBody.length);
    ctx.sentBytes = sendBody.length;
    // 证书：默认不校验（内网网关常用自签证书，校验了就连不上）；这个模型勾了"校验证书"才校验
    up = lib.request({
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname.replace(/\/$/, '') + req.url, method: req.method, headers, rejectUnauthorized: provider.verify_cert === true,
    }, onResponse);
    // 等第一个字节最多等多久：不超过 Claude Code 自己的超时（请求头 x-stainless-timeout，秒）减 20 秒（至少 30 秒）——
    // 它先放弃了，路由再换模型就来不及了。大请求（上下文很长）慢是正常的，不是卡住：一直等到这个上限，
    // 到点也不换模型——换了等于让另一个模型把整个上下文再算一遍，而这个模型多半还在算前一份。连着两次超时才当它卡住了
    const big = isMessages && config.options.bigRequestBytes > 0 && sendBody.length >= config.options.bigRequestBytes;
    const waitSec = Math.min(big ? Math.max(config.options.firstByteTimeoutSec, Math.min(ctx.clientTimeoutSec - 20, 3600)) : config.options.firstByteTimeoutSec, ctx.clientCapSec);
    ctx.big = big;
    timer = setTimeout(() => { const e = new Error('timeout'); e.code = 'ROUTER_FIRST_BYTE_TIMEOUT'; up.destroy(e); }, waitSec * 1000);
    up.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      const code = (e && e.code) || '';
      if (code === 'ROUTER_FIRST_BYTE_TIMEOUT') {
        if (big && (bigTimeouts.get(provider.name) || 0) < 1) {
          bigTimeouts.set(provider.name, 1);
          settled = true;
          const mb = (sendBody.length / 1048576).toFixed(2);
          log(label + ' -> ' + provider.name + ' 处理了 ' + waitSec + ' 秒还没回应（请求 ' + mb + ' MB）。大请求不换模型，交回给 Claude Code 让它自己重试；再来一次就换');
          record({ kind, model, provider: provider.name, status: 504, headerMs: Date.now() - started, totalMs: Date.now() - started, failover: idx > 0, error: '大请求 ' + waitSec + ' 秒没回应，没换模型' });
          return sendError(res, 504, 'api_error', '模型 ' + provider.name + ' 处理了 ' + waitSec + ' 秒还没回应。这次请求有 ' + mb + ' MB，大请求路由不换模型（换了会让另一个模型把整个上下文再算一遍，拖慢别人）。Claude Code 会自己重试；连续两次这样才会换模型。');
        }
        return fail('等了 ' + waitSec + ' 秒没有回应', config.options.cooldownSec, 0);
      }
      // 复用的长连接正好被对方关掉：请求多半根本没送到。原样再发一次，不算这个模型的错
      if (up.reusedSocket && !ctx.retried.has(provider.name) && /ECONNRESET|EPIPE|socket hang up/i.test(code + ' ' + ((e && e.message) || ''))) {
        ctx.retried.add(provider.name);
        settled = true;
        log(label + ' -> ' + provider.name + ' 长连接被对方关掉了，重发一次');
        return forward(ctx, list, idx, tried);
      }
      fail(code === 'ECONNREFUSED' ? '连不上' : certProblem(e) || '网络错误：' + ((e && e.message) || code), CONNECT_COOLDOWN_SEC, 0);
    });
    if (sendBody.length) up.write(sendBody);
    up.end();
  } catch (e) {
    // 请求根本发不出去（地址、请求头不合法之类）：不能挂着不回，换下一个
    fail('请求发不出去：' + ((e && e.message) || e), config.options.outageCooldownSec, 0);
  }
}

function handleProxy(req, res, body) {
  const isMessages = req.url.startsWith('/v1/messages') && !req.url.startsWith('/v1/messages/count_tokens');
  let parsed = null;
  if (body.length && /json/i.test(req.headers['content-type'] || '')) { try { parsed = JSON.parse(body.toString('utf8')); } catch (e) { /* 原样转发 */ } }
  const model = parsed && parsed.model ? String(parsed.model) : '';
  const session = sessionOf(parsed, req.headers);
  const { list, stickyKey, primary } = candidatesFor(model, session, isMessages);
  // Claude Code 自己的超时（x-stainless-timeout，秒）。路由的任何等待都封顶在它减 20 秒（至少 30 秒）
  const clientTimeoutSec = (() => { const n = parseInt(req.headers['x-stainless-timeout'], 10); return n > 0 && n <= 7200 ? n : 600; })();
  const ctx = { req, res, body, parsed, model, stickyKey, primary, isMessages, retried: new Set(), abort: null, sentBytes: body.length, waits: 0, waitedMs: 0, pending: null, big: false,
    clientTimeoutSec, clientCapSec: Math.max(30, clientTimeoutSec - 20), coldTried: false, clientGone: false };
  res.on('close', () => {
    if (res.writableEnded) return;
    // 在等着重试同一个模型的时候客户端走了：这时没有请求在上游，不用再发了
    if (ctx.pending) { clearTimeout(ctx.pending); ctx.pending = null; ctx.clientGone = true; log((model || req.url) + ' 客户端在路由等待重试时取消了'); return; }
    if (ctx.abort) ctx.abort();
  });
  // count_tokens：上游不支持（六小时内回过 404）就不再把整个会话传过去，直接回 404，Claude Code 会自己估算
  if (!isMessages && req.url.startsWith('/v1/messages/count_tokens') && list[0]) {
    const t = noCountTokens.get(list[0].name);
    if (t && Date.now() - t < 6 * 3600000) {
      record({ kind: 'other', model, provider: list[0].name, status: 404, headerMs: 0, totalMs: 0, failover: false, error: 'count_tokens 上游不支持，没有转发（六小时内答过 404）' });
      return sendError(res, 404, 'not_found_error', 'count_tokens 上游不支持（路由六小时内收到过 404，这次没有转发）');
    }
  }
  // 和对话无关的请求只问一个模型，不值得为它轮一圈
  forward(ctx, isMessages ? list : list.slice(0, 1), 0, []);
}

// ---------- 测试一个模型 ----------
function testProvider(p) {
  return new Promise((resolve) => {
    const started = Date.now();
    try {
      const prob = providerProblem(Object.assign({ name: 'test' }, p));
      if (prob) return resolve({ ok: false, status: 0, ms: 0, reason: prob });
      const target = new URL(p.base_url);
      const lib = target.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify({ model: p.model_override || config.options.testModel, max_tokens: 16, messages: [{ role: 'user', content: '只回复一个字：好' }] }));
      const r = lib.request({ hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname.replace(/\/$/, '') + '/v1/messages', method: 'POST', rejectUnauthorized: p.verify_cert === true, timeout: 45000,
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.api_key, authorization: 'Bearer ' + p.api_key, 'content-length': String(body.length) } }, (ur) => {
        const parts = [];
        ur.on('data', (c) => parts.push(c));
        ur.on('error', (e) => resolve({ ok: false, status: ur.statusCode || 0, ms: Date.now() - started, reason: '回复没收全：' + e.message }));
        ur.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          const status = ur.statusCode || 0;
          if (status >= 200 && status < 300) {
            let said = '';
            try { said = (JSON.parse(text).content || []).map((b) => b.text || '').join('').slice(0, 40); } catch (e) { /* 不是标准格式也算通了 */ }
            return resolve({ ok: true, status, ms: Date.now() - started, reason: '通了' + (said ? '，它回复：' + said : '') });
          }
          const c = classify(status, text, true);
          resolve({ ok: false, status, ms: Date.now() - started, reason: (c.reason || ('返回 ' + status)) + '｜' + snippet(text) });
        });
      });
      r.on('timeout', () => r.destroy(new Error('45 秒没有回应')));
      r.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - started, reason: (e.code === 'ECONNREFUSED' ? '连不上' : certProblem(e) || e.message) }));
      r.end(body);
    } catch (e) { resolve({ ok: false, status: 0, ms: Date.now() - started, reason: (e && e.message) || String(e) }); }
  });
}

// ---------- 配置页的接口 ----------
/** 最近 n 天按模型汇总：缓存命中率（按 token 算）、换模型次数、限流等待次数。给用户拿去和网关那边对数用 */
function usageSummary(days) {
  const keys = Object.keys(daily).sort().slice(-days);
  const by = {};
  const tot = { requests: 0, fail: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, failover: 0, waits: 0 };
  for (const k of keys) {
    const day = daily[k] || {};
    for (const [name, x] of Object.entries(day.byProvider || {})) {
      const t = by[name] = by[name] || { requests: 0, fail: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, failover: 0, waits: 0 };
      for (const f of Object.keys(tot)) { t[f] += x[f] || 0; tot[f] += x[f] || 0; }
    }
  }
  const rate = (t) => { const all = t.input + t.cacheRead + t.cacheWrite; return all ? Math.round(t.cacheRead * 100 / all) : null; };
  for (const t of Object.values(by)) t.hitRate = rate(t);
  tot.hitRate = rate(tot);
  return { days: keys.length, total: tot, byProvider: by };
}
const mask = (k) => { const s = String(k || ''); return s.length <= 10 ? (s ? '****' : '') : s.slice(0, 5) + '…' + s.slice(-4); };
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
// key 里不会有空白；从网页、聊天软件里复制常常带进零宽字符，trim 去不掉
const cleanKey = (k) => String(k || '').replace(/[\s​-‍⁠﻿]/g, '');
function publicState() {
  const day = daily[today()] || { requests: 0, byProvider: {} };
  return {
    version: VERSION, listen: LISTEN, configPath: CONFIG_PATH, configVersion: configVersion(), configError, warnings: configWarnings, usingLastGood: configSource === LAST_GOOD,
    options: config.options, routes: config.routes, default: config.default, failover: config.failover,
    providers: config.providers.map((p) => {
      const h = hOf(p.name);
      return { name: p.name || '', base_url: p.base_url || '', key_masked: mask(p.api_key), model_override: p.model_override || '', enabled: p.enabled !== false, note: p.note || '', verify_cert: p.verify_cert === true, problem: providerProblem(p),
        cooldownLeftSec: Math.max(0, Math.round((h.until - Date.now()) / 1000)), reason: h.until > Date.now() ? h.reason : '', lastOkAt: h.lastOkAt, lastFailAt: h.lastFailAt,
        quota: quotaOut(p.name), until: h.until > Date.now() ? h.until : 0, untilText: h.until > Date.now() ? whenText(h.until) : '',
        today: (day.byProvider || {})[p.name] || { requests: 0, fail: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    }),
    todayRequests: day.requests || 0, stickySessions: sticky.size, gateway: gatewayPublic(),
  };
}
/** 配置页交回来的配置里 key 是空的就沿用原来的（页面上从来拿不到完整的 key）。监听地址沿用文件里的，不受 -p 影响 */
function mergeIncoming(inc) {
  const old = new Map(config.providers.map((p) => [p.name, p]));
  const providers = (Array.isArray(inc.providers) ? inc.providers : []).filter((p) => p && typeof p === 'object').map((p) => {
    const prev = old.get(p.original_name || p.name);
    const out = { name: String(p.name || '').trim(), base_url: cleanUrl(p.base_url), api_key: p.api_key ? cleanKey(p.api_key) : (prev ? prev.api_key : '') };
    if (p.model_override) out.model_override = String(p.model_override).trim();
    if (p.enabled === false) out.enabled = false;
    if (p.note) out.note = String(p.note);
    // 校验证书：只存 true（默认不校验）。交回来的没带这一项（旧页面、别的调用方），就沿用原来的
    if (p.verify_cert === undefined ? !!prev && prev.verify_cert === true : p.verify_cert === true) out.verify_cert = true;
    return out;
  });
  return { providers, routes: inc.routes || [], default: inc.default || { provider: '' }, failover: inc.failover || [], listen: config.listen, options: Object.assign({}, config.options, inc.options || {}) };
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => { const parts = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('请求太大')); req.destroy(); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
/** 请求头里的 Host 是不是本机。网页用"域名解析到 127.0.0.1"的办法绕进来时，Host 是它自己的域名 */
function hostIsLocal(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return ['127.0.0.1', 'localhost', '[::1]'].includes(h);
}
function fromLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}
/** 配置页和它的接口：连接必须来自本机、Host 必须是本机、改东西必须带自定义请求头（跨站的网页带不上）、Origin 必须是本机 */
function apiAllowed(req) {
  if (!fromLoopback(req) || !hostIsLocal(req)) return false;
  if (req.method !== 'GET' && req.headers['x-vibe-router'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
  return true;
}

let kitApi = null;
try { kitApi = require('./kit-api.js'); } catch (e) { /* 没带套件那部分也能单独当路由用 */ }

// ---------- 套件的钩子（HTTP 方式） ----------
/*
 * 装了路由时，改文件、跑命令、提问框、读文件提醒、收工检查这几个钩子登记成 HTTP 钩子，打到 /vibe-kit/hook/<名字>，
 * 由套件的 lib/hook-host.js 在工作线程里跑（和命令方式同一份代码），不用每次起一个 node 进程。
 * 这里出任何问题都回 {}（放行），和命令方式钩子出错时一样；有没有生效由用户开口时的自检（hook-health.js）盯着。
 */
let hookHost = null;
let hookHostTriedAt = 0;
function getHookHost() {
  if (hookHost || Date.now() - hookHostTriedAt < 30000) return hookHost;
  hookHostTriedAt = Date.now();
  try { hookHost = require(path.join(KIT_DIR, 'lib', 'hook-host.js')).createHost({ kitDir: KIT_DIR, log }); }
  catch (e) { log('载入钩子宿主失败，HTTP 钩子这段时间一律放行：' + e.message); }
  return hookHost;
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
async function handleHook(req, res, name) {
  const why = hookRequestRejected(req);
  if (why) { req.resume(); return json(res, 403, { error: why }); }
  let input;
  try { input = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}'); } catch (e) { return json(res, 200, {}); }
  const host = getHookHost();
  if (!host) return json(res, 200, {});
  try {
    const r = await host.run(name, input && typeof input === 'object' ? input : {});
    if (r.status === 404) return json(res, 404, { error: '没有这个钩子：' + name });
    return json(res, 200, r.out == null ? {} : r.out);
  } catch (e) { log('钩子 ' + name + ' 出错（这次当放行）：' + e.message); return json(res, 200, {}); }
}
/**
 * settings.json 里登记的 HTTP 钩子打的端口和路由现在的端口对不上（手改了配置里的端口）：重新登记一次，不然钩子全打空、一律放行。
 * 用 -p 临时换端口跑的不管（那是测试或临时用）
 */
function checkHookPort() {
  if (overridePort || !kitApi || typeof kitApi.sync !== 'function') return;
  try {
    const ports = require(path.join(KIT_DIR, 'lib', 'hook-health.js')).registeredHookPorts(path.dirname(KIT_DIR));
    if (!ports.length || ports.every((p) => p === LISTEN.port)) return;
    log('settings.json 里的 HTTP 钩子打的是端口 ' + ports.join('、') + '，路由现在在 ' + LISTEN.port + '：重新登记钩子');
    kitApi.sync(KIT_DIR).then((r) => log('重新登记钩子' + (r.ok ? '完成' : '没成功：' + String(r.output || '').slice(0, 300))));
  } catch (e) { /* 没装套件、或者老版本没有 hook-health.js */ }
}

async function handleApi(req, res) {
  if (!apiAllowed(req)) return json(res, 403, { error: '配置页只能在本机用 http://127.0.0.1:' + LISTEN.port + '/ui 打开' });
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/api/state') return json(res, 200, publicState());
    if (req.method === 'GET' && url === '/api/usage') return json(res, 200, { daily, recent: stats.recentLogs.slice(-200).reverse(), warnAt: config.options.dailyRequestWarn, summary: usageSummary(7) });
    if (req.method === 'GET' && url === '/api/backups') return json(res, 200, { files: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => /^config-.*\.json$/.test(f)).sort().reverse() : [] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}') : {};
    if (req.method === 'POST' && url === '/api/config') {
      // 页面是按它打开（或上次保存）时的那份配置改的。这之间文件被改过（手改了 config.json、另一个页面保存过），就不能拿页面上的旧内容把它冲掉
      if (body.baseVersion !== undefined && String(body.baseVersion) !== configVersion()) return json(res, 409, { error: '配置在别处改过（比如手改了 config.json，或者另一个配置页保存过），这次没有保存，免得把那边的改动冲掉。页面已经刷新成最新的，请重做这次修改', conflict: true });
      saveConfig(mergeIncoming(body));
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (req.method === 'POST' && url === '/api/test') {
      const saved = config.providers.find((p) => p.name === (body.original_name || body.name));
      const addr = body.base_url ? cleanUrl(body.base_url) : (saved ? saved.base_url : '');
      // 已保存的 key 只发给已保存的地址。地址改过了，就得重新填 key 才能测
      const sameAddr = !!saved && addr === saved.base_url;
      const key = body.api_key ? cleanKey(body.api_key) : (sameAddr ? saved.api_key : '');
      if (!key) return json(res, 200, { ok: false, reason: saved && !sameAddr ? '地址改过了，要重新填一次 key 才能测（已保存的 key 不会发到新地址）' : '没有填 key' });
      const verifyCert = body.verify_cert === undefined ? !!saved && saved.verify_cert === true : body.verify_cert === true;
      const r = await testProvider({ base_url: addr, api_key: key, model_override: body.model_override || (saved && saved.model_override) || '', verify_cert: verifyCert });
      if (r.ok && saved && sameAddr && !body.api_key) markOk(saved.name);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && url === '/api/restore') {
      const f = path.join(BACKUP_DIR, path.basename(String(body.file || '')));
      if (!/^config-.*\.json$/.test(path.basename(f)) || !fs.existsSync(f)) return json(res, 400, { error: '没有这份备份' });
      saveConfig(parseConfigFile(f));
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (req.method === 'POST' && url === '/api/clear-cooldown') {
      const name = String(body.name);
      const h = hOf(name);
      const wasQuota = quotaOut(name);
      h.until = 0; h.reason = ''; h.quota = false;
      // 额度用完的停用是存在文件里的（跨重启），手动恢复要一起抹掉
      if (wasQuota) { saveQuota(); log(name + ' 额度停用被手动解除（配置页"手动恢复"）'); }
      // "现在就试"：以它为首选的会话也不再留在备用模型上
      for (const k of [...sticky.keys()]) if (k.endsWith('|' + name)) sticky.delete(k);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/gateway-forget') { forgetLimit(); return json(res, 200, { ok: true, gateway: gatewayPublic() }); }
    if (url.startsWith('/api/kit')) {
      if (!kitApi) return json(res, 200, { installed: false, reason: '路由目录里没有 kit-api.js' });
      return json(res, 200, await kitApi.handle(req.method, url, body, KIT_DIR, { port: LISTEN.port, dataDir: DATA_DIR, usable: usableProviders().length }));
    }
    return json(res, 404, { error: '没有这个接口' });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

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
  if (req.method === 'GET' && url === '/health') return json(res, 200, { status: configError ? 'degraded' : 'ok', error: configError, warnings: configWarnings, routes: config.routes, default: config.default.provider, providers: usableProviders().map((p) => p.name) });
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
  log('模型：' + (usableProviders().map((p) => p.name).join('、') || '（还没有可用的）') + '；角色：' + config.routes.map((r) => r.match.join('/') + '→' + r.provider).join('，') + '；默认→' + config.default.provider);
  if (configError) log('注意：' + configError);
  setTimeout(checkHookPort, 1500).unref();
});

module.exports = { normalize, problemsOf, providerProblem, classify, usageTap, cleanOptions, rejectBrowserRequest, waitableStatus };
