'use strict';
/*
 * 路由的配置：读、校验、保存（带备份）、文件改了自动重新加载，实际监听的地址。
 * 配置文件坏了就继续用上一份好的；某一个模型配得不对只跳过那一个（router.js 开头的设计原则 2）。
 * config、configError、configWarnings、configSource 会被重新赋值，别的文件经这个模块的同名属性取当前的。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scrub, refreshSecrets, CONFIG_PATH, LAST_GOOD, BACKUP_DIR, overridePort, log } = require('./base');

// 首字节超时要小于 Claude Code 自己的超时（默认 600 秒），不然它先放弃了，换模型就来不及
const DEFAULT_OPTIONS = { cooldownSec: 300, outageCooldownSec: 1800, firstByteTimeoutSec: 300, rateLimitWaitSec: 20, bigRequestBytes: 300000, stickySession: true, stickyMinutes: 10, dailyRequestWarn: 4000, testModel: 'claude-sonnet-4-5' };

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
    refreshSecrets(config);
    configError = '';
    configSource = CONFIG_PATH;
    configWarnings = problemsOf(config);
    try { fs.writeFileSync(LAST_GOOD, JSON.stringify(config, null, 2)); } catch (e) { /* 忽略 */ }
    if (isReload) log('配置已重新加载：' + config.providers.map((p) => p.name).join('、'));
    if (configWarnings.length) log('配置里有几处不对（已跳过，其余照常用）：' + configWarnings.join('；'));
    return true;
  } catch (e) {
    configError = (fs.existsSync(CONFIG_PATH) ? '配置文件有问题：' : '还没有配置文件：') + scrub(e.message);
    log(configError + (isReload ? '。继续用上一份好的配置' : ''));
    if (!isReload) {
      try { config = parseConfigFile(LAST_GOOD); refreshSecrets(config); configSource = LAST_GOOD; log('已改用上一份好的配置 ' + LAST_GOOD); } catch (e2) { config = normalize({}); configSource = ''; }
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

module.exports = {
  DEFAULT_OPTIONS, cleanOptions, normalize, providerProblem, problemsOf, parseConfigFile, loadConfig, configVersion, saveConfig, LISTEN, LISTEN_IS_LOOPBACK,
  get config() { return config; }, get configError() { return configError; }, get configWarnings() { return configWarnings; }, get configSource() { return configSource; },
};
