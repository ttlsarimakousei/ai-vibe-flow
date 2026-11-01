'use strict';
/*
 * 转发：按角色排出候选模型、把请求转给上游、失败了等一等或者换下一个、流式回复边收边转并读出 token 用量；配置页"测试"一个模型。
 * 设计原则见 router.js 开头（3、4、5、6、7、8 条都在这里）。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来。只用 Node 自带模块。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const C = require('./config-file');
const { providerProblem, LISTEN } = C;
const { hOf, onCooldown, quotaOut, markFail, markOk, markQuota, quotaInfo, whenText, sticky, stickyAlive, classify, retryAfterMs, waitableStatus, clampSec } = require('./health');
const { record, learnRatio, learnLimit } = require('./usage');
const { KIT_DIR } = require('./base');
// 本机诊断（K1-8，kit 的 lib/diag.js）：上游多久回头部、被限流等了多久。装回老版本的套件没有这个文件，就不记
const diagNote = (cat, key, ms) => { try { require(require('path').join(KIT_DIR, 'lib', 'diag.js')).note(cat, key, ms, { buffer: true }); } catch (e) { /* 不记 */ } };
const { diagnostic, secrets, scrub, log } = require('./base');

const CONNECT_COOLDOWN_SEC = 60;      // 连接层面的错误：所有模型走同一个网关，多半不是这一个模型的问题，只短暂避开
const ERROR_BODY_TIMEOUT_MS = 15000;  // 上游回了错误状态码却迟迟不把正文发完
// 客户端自己断开（绝大多数是用户按了 Esc）不算模型的错，不冷却任何模型，只在用量里记一条"客户端取消"

const bigTimeouts = new Map();   // 模型名 + 会话 -> 大请求连续超时次数（一次不算卡住，两次才换模型）。按会话分开（审核 P23）：以前一个会话成功一次就清掉别的会话的计数
const bigKey = (ctx, name) => name + '|' + (ctx.session || '');
const noCountTokens = new Map(); // 模型名 -> 上次 count_tokens 被回 404 的时间（上游不支持这个接口，就不用每次都把整个会话传过去）

function sessionOf(parsed, headers) {
  const id = (headers && headers['x-claude-code-session-id']) || (parsed && parsed.metadata && parsed.metadata.user_id);
  return id ? crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12) : '';
}
const usableProviders = () => C.config.providers.filter((p) => p.enabled !== false && !providerProblem(p));
function candidatesFor(model, session, isMessages) {
  const byName = new Map();
  for (const p of usableProviders()) if (!byName.has(p.name)) byName.set(p.name, p);
  const order = [];
  const push = (n) => { if (n && byName.has(n) && !order.includes(n)) order.push(n); };
  if (isMessages) {
    const m = String(model || '').toLowerCase();
    const route = C.config.routes.find((r) => r.match.some((k) => m.includes(String(k).toLowerCase())));
    if (route) push(route.provider);
  }
  push(C.config.default.provider);
  const primary = order[0] || '';
  const stickyKey = isMessages && session && primary ? session + '|' + primary : '';
  C.config.failover.forEach(push);
  C.config.providers.forEach((p) => push(p.name));
  // 这个会话刚换过模型，就继续用换过去的那个，除非它自己也不行了
  const st = C.config.options.stickySession && stickyKey ? sticky.get(stickyKey) : null;
  if (stickyAlive(st) && byName.has(st.provider) && !onCooldown(st.provider)) { order.splice(order.indexOf(st.provider), 1); order.unshift(st.provider); }
  // 冷却中的排到最后，但不全丢掉：只带最快到期的那一个。都在冷却时一个请求最多多试一次，不把整个上下文轮着发给每一个模型。
  // 额度用完的不在"多试一次"之列（到重置时间之前试了也是被拒），排在最末尾只为了最后报错时说清楚
  const live = order.filter((n) => !onCooldown(n));
  const cold = order.filter((n) => onCooldown(n) && !quotaOut(n)).sort((a, b) => hOf(a).until - hOf(b).until).slice(0, 1);
  const out = order.filter((n) => quotaOut(n));
  return { list: live.concat(cold, out).map((n) => byName.get(n)), stickyKey, primary };
}
const snippet = (s) => diagnostic.clip(String(s || '').replace(/\s+/g, ' '), 240, secrets());
/** 连不上 HTTPS 网关的原因是证书校验没通过时，说清楚怎么办 */
function certProblem(e) {
  const s = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME|certificate/i.test(s)
    ? '证书校验没通过（' + ((e && (e.code || e.message)) || '') + '）：网关用的多半是自签证书，在这个模型的设置里取消"校验证书"就能连' : '';
}
function sendError(res, status, type, message, extraHeaders) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { try { res.end(); } catch (e) { /* 已经断了 */ } return; }
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(JSON.stringify({ type: 'error', error: { type, message: scrub(message) } }));
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
  // 总时间快用完了（剩不到 5 秒）还要换下一个模型：不换了，把试过的告诉 Claude Code（它会自己重试）
  if (idx > 0 && ctx.deadline && ctx.deadline - Date.now() < 5000) {
    log((model || req.url) + ' 总时间用完了（' + ctx.clientCapSec + ' 秒），不再换下一个模型：' + tried.map((t) => t.name + '（' + t.reason + '）').join('；'));
    return sendError(res, 504, 'api_error', '这次请求已经等了 ' + ctx.clientCapSec + ' 秒（Claude Code 的超时减 20 秒），试过 ' + tried.map((t) => t.name).join('、') + ' 都没成，不再换下一个模型。Claude Code 会自己重试。');
  }
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
      : '路由里还没有可用的模型。打开 ' + ui + ' 添加。' + (C.configError ? '（' + C.configError + '）' : '') + (C.configWarnings.length ? '（' + C.configWarnings.join('；') + '）' : '');
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
    const encoding = String(ur.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
      const z = require('zlib'); const decoder = encoding === 'gzip' ? z.createGunzip() : encoding === 'deflate' ? z.createInflate() : encoding === 'br' ? z.createBrotliDecompress() : null;
      if (!decoder) { ur.resume(); return fail('上游压缩格式无法处理，未转发原始诊断', CONNECT_COOLDOWN_SEC, 502, ''); }
      const rawResponse = ur; decoder.headers = Object.assign({}, ur.headers); decoder.statusCode = ur.statusCode; delete decoder.headers['content-encoding']; delete decoder.headers['content-length'];
      rawResponse.on('error', (e) => decoder.destroy(e)); decoder.on('end', () => { decoder.complete = rawResponse.complete; });
      rawResponse.pipe(decoder); ur = decoder;
    }
    clearTimeout(timer);
    if (settled) { ur.resume(); return; }
    const headerMs = Date.now() - started;
    const status = ur.statusCode || 0;
    if (isMessages) diagNote('路由首字节', provider.name, headerMs);

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
        if (waitable && C.config.options.rateLimitWaitSec > 0 && !settled) {
          // 限流等待也从这次请求剩下的时间里扣，留 10 秒给重发（复审 U-R6）
          const budget = Math.min(C.config.options.rateLimitWaitSec * 1000, ctx.clientCapSec * 1000, ctx.deadline ? Math.max(0, ctx.deadline - Date.now() - 10000) + ctx.waitedMs : Infinity);
          const step = Math.round(ra > 0 ? ra : Math.min(10000, 5000 * Math.pow(2, Math.max(0, ctx.waits - 1))));
          if (ctx.waitedMs + step <= budget) {
            settled = true;
            ctx.waits++; ctx.waitedMs += step;
            diagNote('路由等待', provider.name, step);
            log(label + ' -> ' + provider.name + ' ' + what + '，' + (ra > 0 ? '按它说的等 ' : '等 ') + Math.round(step / 1000) + ' 秒后再试同一个模型（不换模型，免得让另一个模型把整个上下文重新算一遍）');
            record({ kind, model, provider: provider.name, status, headerMs, totalMs: Date.now() - started, failover: idx > 0, waitMs: step, error: what + '，等 ' + Math.round(step / 1000) + ' 秒后重试同一个模型' });
            ctx.pending = setTimeout(() => { ctx.pending = null; forward(ctx, list, idx, tried); }, step);
            return;
          }
        }
        // 大请求遇到网关先回 502 / 504（多半是网关自己等超时了）：和路由自己的首字节计时器到点一样处理——不换模型，
        // 交回给 Claude Code 让它自己重试；同一个模型连续两次这样才换。换了等于让另一个模型把整个上下文再算一遍
        if (isMessages && ctx.big && (status === 502 || status === 504) && !settled && (bigTimeouts.get(bigKey(ctx, provider.name)) || 0) < 1) {
          bigTimeouts.set(bigKey(ctx, provider.name), 1);
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
        const safe = Buffer.from(diagnostic.errorBody(text, secrets()));
        h['content-length'] = String(safe.length);
        for (const k of Object.keys(h)) if (typeof h[k] === 'string') h[k] = scrub(h[k]);
        res.writeHead(status, h); res.end(safe);
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
      bigTimeouts.delete(bigKey(ctx, provider.name));
      // 落在了不是本角色首选的模型上，就记住（第一次记的时间为准，到点回首选）；回到首选了就忘掉
      if (stickyKey && C.config.options.stickySession) {
        if (provider.name === primary) sticky.delete(stickyKey);
        else { const st = sticky.get(stickyKey); if (!stickyAlive(st) || st.provider !== provider.name) sticky.set(stickyKey, { provider: provider.name, at: Date.now() }); }
      }
    }
    const h = Object.assign({}, ur.headers); for (const k of ['transfer-encoding', 'connection', 'keep-alive']) delete h[k];
    if (isMessages) delete h['content-length'];
    res.writeHead(status, h);
    if (res.flushHeaders) res.flushHeaders();
    const tap = usageTap(ur.headers['content-type']);
    const idleMs = C.config.options.firstByteTimeoutSec * 1000;
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
      // 流式回复已经收到 message_stop：回复是全的，之后上游再断开（没发 HTTP 的结束块就关了连接、半天不收尾）不要紧，照常结束。
      // 实测（E3，docs/claude-code-facts.md"流式回复断在半截"）：这时候路由也断开的话，2.1.120 报错停下，回复其实是全的
      const whole = isMessages && tap.sse && tap.stopped;
      if (err && whole) {
        log(label + ' -> ' + provider.name + ' 回复已经收全（有 message_stop），上游随后断开（' + err + '），照常结束');
        try { up.destroy(); } catch (e) { /* 已经断了 */ }
      }
      if (err && !whole) {
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
        if (overloaded) markFail(provider.name, '过载（流里报 overloaded_error）', C.config.options.cooldownSec);
        log(label + ' -> ' + provider.name + ' 先回了 200，又在流里报错：' + e.type + (e.message ? '｜' + snippet(e.message) : '') + (overloaded ? '。这个模型冷却 ' + C.config.options.cooldownSec + ' 秒' : ''));
        record(Object.assign(base, { failed: true, error: '流里报错：' + e.type + (e.message ? '｜' + snippet(e.message) : '') }, tap.usage));
      } else if (isMessages && tap.sse && !tap.stopped) {
        // 没有 message_stop 就收了尾（上游没报错）：回复是半截的，和上游中途断开一样把客户端的连接也断开（E3，2026-11-01）。
        // 实测（docs/claude-code-facts.md"流式回复断在半截"）：以前照常结束，一整段文字发完之后断的，2.1.120、2.1.259 把半截当成回完了；
        // 断开连接，断在一段中间的三个版本都重发，一段发完之后断的 2.1.259、2.1.289 留着半截接着写、2.1.120 报错停下。
        // 补一个 event: error 再结束效果一样，只是三个版本都会改成不走流式重发；断开连接，2.1.259 起照样走流式重发
        log(label + ' -> ' + provider.name + ' 回复没有 message_stop 就结束了（是半截的），断开客户端的连接，让它知道没收全');
        record(Object.assign(base, { failed: true, error: '传输中断：上游没发 message_stop 就结束了（回复是半截的）' }, tap.usage));
        try { res.destroy(); } catch (e) { /* 已经断了 */ }
        return;
      } else {
        if (isMessages) learnRatio(ctx.sentBytes, tap.usage.input + tap.usage.cacheRead + tap.usage.cacheWrite);
        record(Object.assign(base, { error: '' }, tap.usage));
      }
      try { res.end(); } catch (e) { /* 客户端已经断了 */ }
    };
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => finish('上游 ' + Math.round(idleMs / 1000) + ' 秒没有再发数据'), idleMs); };
    armIdle();
    const filtered = isMessages && tap.sse ? diagnostic.sse(() => secrets(), (b) => res.write(b)) : null;
    const jsonParts = isMessages && !tap.sse && /json/i.test(String(ur.headers['content-type'] || '')) ? [] : null;
    let jsonBytes = 0;
    ur.on('data', (c) => { armIdle(); if (isMessages) tap.feed(c); try { if (filtered) filtered.feed(c); else if (jsonParts) { jsonBytes += c.length; if (jsonBytes > 16 * 1024 * 1024) throw new Error('模型 JSON 回复超过本机处理上限'); jsonParts.push(c); } else res.write(c); } catch (e) { finish(e.message); } });
    ur.on('end', () => { try { if (filtered) filtered.end(); if (jsonParts) { const body = Buffer.concat(jsonParts); let error = false; try { const x = JSON.parse(body.toString('utf8')); error = x.type === 'error'; } catch (e) { /* 原传输错误由完成检查处理 */ } res.write(error ? diagnostic.errorBody(body.toString('utf8'), secrets()) : body); } } catch (e) { finish(e.message); } });
    ur.on('end', () => finish(ur.complete === false ? '上游没发完就断了' : ''));
    ur.on('error', (e) => finish((e && e.message) || '上游断了'));
    ur.on('aborted', () => finish('上游中途断开'));
    ur.on('close', () => finish(ur.complete ? '' : '上游中途断开'));
  };

  try {
    const target = new URL(provider.base_url);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, req.headers);
    headers['accept-encoding'] = 'identity';
    for (const k of HOP_HEADERS) delete headers[k];
    // 只用 Anthropic 的 x-api-key，不带 OpenAI 式的 Authorization: Bearer（Claude Code 自己发来的那个也去掉，它是给路由的占位令牌）
    delete headers['authorization'];
    headers['x-api-key'] = provider.api_key;
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
    // 模型名照原样带着，配了"换成这个模型名"的换成它（网关要求必须有 model，问题反馈表第 18 条）
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
    const big = isMessages && C.config.options.bigRequestBytes > 0 && sendBody.length >= C.config.options.bigRequestBytes;
    const leftSec = ctx.deadline ? Math.max(1, Math.floor((ctx.deadline - Date.now()) / 1000)) : ctx.clientCapSec;
    const normalWait = Math.min(big ? Math.max(C.config.options.firstByteTimeoutSec, Math.min(ctx.clientTimeoutSec - 20, 3600)) : C.config.options.firstByteTimeoutSec, ctx.clientCapSec);
    const waitSec = Math.min(normalWait, leftSec);
    ctx.big = big;
    timer = setTimeout(() => { const e = new Error('timeout'); e.code = 'ROUTER_FIRST_BYTE_TIMEOUT'; up.destroy(e); }, waitSec * 1000);
    up.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      const code = (e && e.code) || '';
      if (code === 'ROUTER_FIRST_BYTE_TIMEOUT') {
        if (big && (bigTimeouts.get(bigKey(ctx, provider.name)) || 0) < 1) {
          bigTimeouts.set(bigKey(ctx, provider.name), 1);
          settled = true;
          const mb = (sendBody.length / 1048576).toFixed(2);
          log(label + ' -> ' + provider.name + ' 处理了 ' + waitSec + ' 秒还没回应（请求 ' + mb + ' MB）。大请求不换模型，交回给 Claude Code 让它自己重试；再来一次就换');
          record({ kind, model, provider: provider.name, status: 504, headerMs: Date.now() - started, totalMs: Date.now() - started, failover: idx > 0, error: '大请求 ' + waitSec + ' 秒没回应，没换模型' });
          return sendError(res, 504, 'api_error', '模型 ' + provider.name + ' 处理了 ' + waitSec + ' 秒还没回应。这次请求有 ' + mb + ' MB，大请求路由不换模型（换了会让另一个模型把整个上下文再算一遍，拖慢别人）。Claude Code 会自己重试；连续两次这样才会换模型。');
        }
        // 等待被这次请求剩下的时间截短了（没等满平时的首字节时间）：只说这次超时，不冷却这个模型（复审 U-R6：以前照样冷却 5 分钟）
        return fail('等了 ' + waitSec + ' 秒没有回应' + (waitSec < normalWait ? '（这次请求剩下的时间只够等这么久）' : ''), waitSec < normalWait ? 0 : C.config.options.cooldownSec, 0);
      }
      // 复用的长连接正好被对方关掉：请求多半根本没送到。原样再发一次，不算这个模型的错
      if (up.reusedSocket && !ctx.retried.has(provider.name) && (!ctx.deadline || ctx.deadline - Date.now() > 10000) && /ECONNRESET|EPIPE|socket hang up/i.test(code + ' ' + ((e && e.message) || ''))) {
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
    fail('请求发不出去：' + ((e && e.message) || e), C.config.options.outageCooldownSec, 0);
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
    clientTimeoutSec, clientCapSec: Math.max(30, clientTimeoutSec - 20), coldTried: false, clientGone: false, session };
  // 一个请求一个总截止时间（审核 P23、Codex C18）：换模型、重发共用剩下的时间。以前每个候选都等满一遍，Claude Code 那边早就超时了
  ctx.deadline = Date.now() + ctx.clientCapSec * 1000;
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
      // 带模型名（网关要求必须有 model）、不带 Bearer：和转发一样
      const body = Buffer.from(JSON.stringify({ model: p.model_override || C.config.options.testModel, max_tokens: 16, messages: [{ role: 'user', content: '只回复一个字：好' }] }));
      const r = lib.request({ hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname.replace(/\/$/, '') + '/v1/messages', method: 'POST', rejectUnauthorized: p.verify_cert === true, timeout: 45000,
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.api_key, 'content-length': String(body.length) } }, (ur) => {
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

module.exports = { sessionOf, usableProviders, candidatesFor, snippet, certProblem, sendError, usageTap, HOP_HEADERS, forward, handleProxy, testProvider };
