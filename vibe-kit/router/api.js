'use strict';
/*
 * 配置页的 /api 接口：状态、用量、备份、保存配置（核对版本、key 留空沿用、地址改了要重填 key）、测试连接、恢复备份、
 * 手动恢复冷却、忘掉网关上限；/api/kit 交给 kit-api.js（套件那几页）。能不能用先过 access.js 的 apiAllowed。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const C = require('./config-file');
const { LISTEN } = C;
const { hOf, quotaOut, whenText, sticky, markOk, saveQuota } = require('./health');
const { stats, daily, today, gatewayPublic, forgetLimit } = require('./usage');
const { usableProviders, testProvider } = require('./forward');
const { apiAllowed } = require('./access');
const { VERSION, CONFIG_PATH, LAST_GOOD, BACKUP_DIR, DATA_DIR, KIT_DIR, log, readBody, json } = require('./base');

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
    version: VERSION, listen: LISTEN, configPath: CONFIG_PATH, configVersion: C.configVersion(), configError: C.configError, warnings: C.configWarnings, usingLastGood: C.configSource === LAST_GOOD,
    options: C.config.options, routes: C.config.routes, default: C.config.default, failover: C.config.failover,
    providers: C.config.providers.map((p) => {
      const h = hOf(p.name);
      return { name: p.name || '', base_url: p.base_url || '', key_masked: mask(p.api_key), model_override: p.model_override || '', enabled: p.enabled !== false, note: p.note || '', verify_cert: p.verify_cert === true, problem: C.providerProblem(p),
        cooldownLeftSec: Math.max(0, Math.round((h.until - Date.now()) / 1000)), reason: h.until > Date.now() ? h.reason : '', lastOkAt: h.lastOkAt, lastFailAt: h.lastFailAt,
        quota: quotaOut(p.name), until: h.until > Date.now() ? h.until : 0, untilText: h.until > Date.now() ? whenText(h.until) : '',
        today: (day.byProvider || {})[p.name] || { requests: 0, fail: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    }),
    todayRequests: day.requests || 0, stickySessions: sticky.size, gateway: gatewayPublic(),
  };
}
/** 配置页交回来的配置里 key 是空的就沿用原来的（页面上从来拿不到完整的 key）。监听地址沿用文件里的，不受 -p 影响 */
function mergeIncoming(inc) {
  const old = new Map(C.config.providers.map((p) => [p.name, p]));
  const providers = (Array.isArray(inc.providers) ? inc.providers : []).filter((p) => p && typeof p === 'object').map((p) => {
    const prev = old.get(p.original_name || p.name);
    // 地址改了又没带新 key：不保存（审核 P20）。以前沿用旧 key，已保存的 key 会跟到新地址去；"测试连接"那边本来就挡着，两边口径要一样
    if (!p.api_key && prev && prev.api_key && cleanUrl(p.base_url) !== cleanUrl(prev.base_url)) throw Object.assign(new Error('模型"' + String(p.name || prev.name) + '"的地址改了，要重新填一次 key 才能保存（已保存的 key 不会发到新地址）。这次什么都没存'), { status: 400 });
    const out = { name: String(p.name || '').trim(), base_url: cleanUrl(p.base_url), api_key: p.api_key ? cleanKey(p.api_key) : (prev ? prev.api_key : '') };
    if (p.model_override) out.model_override = String(p.model_override).trim();
    if (p.enabled === false) out.enabled = false;
    if (p.note) out.note = String(p.note);
    // 校验证书：只存 true（默认不校验）。交回来的没带这一项（旧页面、别的调用方），就沿用原来的
    if (p.verify_cert === undefined ? !!prev && prev.verify_cert === true : p.verify_cert === true) out.verify_cert = true;
    return out;
  });
  return { providers, routes: inc.routes || [], default: inc.default || { provider: '' }, failover: inc.failover || [], listen: C.config.listen, options: Object.assign({}, C.config.options, inc.options || {}) };
}

let kitApi = null;
try { kitApi = require('./kit-api.js'); } catch (e) { /* 没带套件那部分也能单独当路由用 */ }

async function handleApi(req, res) {
  if (!apiAllowed(req)) return json(res, 403, { error: '配置页只能在本机用 http://127.0.0.1:' + LISTEN.port + '/ui 打开' });
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/api/state') return json(res, 200, publicState());
    if (req.method === 'GET' && url === '/api/usage') return json(res, 200, { daily, recent: stats.recentLogs.slice(-200).reverse(), warnAt: C.config.options.dailyRequestWarn, summary: usageSummary(7) });
    if (req.method === 'GET' && url === '/api/backups') return json(res, 200, { files: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => /^config-.*\.json$/.test(f)).sort().reverse() : [] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}') : {};
    if (req.method === 'POST' && url === '/api/config') {
      // 页面是按它打开（或上次保存）时的那份配置改的。这之间文件被改过（手改了 C.config.json、另一个页面保存过），就不能拿页面上的旧内容把它冲掉
      if (body.baseVersion !== undefined && String(body.baseVersion) !== C.configVersion()) return json(res, 409, { error: '配置在别处改过（比如手改了 C.config.json，或者另一个配置页保存过），这次没有保存，免得把那边的改动冲掉。页面已经刷新成最新的，请重做这次修改', conflict: true });
      let merged;
      try { merged = mergeIncoming(body); } catch (e) { if (e && e.status === 400) return json(res, 400, { error: e.message }); throw e; }
      C.saveConfig(merged);
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (req.method === 'POST' && url === '/api/test') {
      const saved = C.config.providers.find((p) => p.name === (body.original_name || body.name));
      // 两边都规范化（复审 U-R7：C.config.json 里手写的地址带尾斜杠、/v1 时，以前列表上的"测试"按钮说地址改过了）
      const addr = body.base_url ? cleanUrl(body.base_url) : (saved ? cleanUrl(saved.base_url) : '');
      // 已保存的 key 只发给已保存的地址。地址改过了，就得重新填 key 才能测
      const sameAddr = !!saved && addr === cleanUrl(saved.base_url);
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
      C.saveConfig(C.parseConfigFile(f));
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

module.exports = { usageSummary, publicState, mergeIncoming, handleApi, kitApi };
