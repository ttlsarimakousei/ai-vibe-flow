'use strict';
/*
 * 流式输出检查：发一个会产生较长回复的请求，看回复是陆续到达，还是被攒成一整段同时到达。
 * 可以指定任意地址，用来对比「本机的转发程序」和「它背后的上游」，找出是哪一层攒的。
 *
 * 用法：node stream-check.js [--base 地址] [--token KEY | --apikey KEY] [--model 名称] [--format auto|anthropic|openai]
 *   不给 --base：用 Claude Code 当前配置的端点（环境变量或 ~/.claude/settings.json 的 env 段）。
 *   --format auto：先按 Anthropic 格式请求 /v1/messages；返回 404/405 再按 OpenAI 格式请求 /v1/chat/completions。
 *   上游多半是 OpenAI 格式的模型服务（本机程序负责转格式），所以 auto 是默认值。
 * 结果打印成一行 STREAM {json}，供 PowerShell 那边读取。只用 Node 内置模块。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));

function readSettingsEnv() {
  const f = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(f)) return {};
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).env) || {}; } catch (e) { return {}; }
}
const senv = readSettingsEnv();
const pick = (k) => process.env[k] || senv[k] || '';

// 上游的 key 走环境变量 STREAM_CHECK_TOKEN 传进来，不出现在命令行上
const useConfigured = !args.base;
const BASE = String(args.base || pick('ANTHROPIC_BASE_URL') || '').trim().replace(/\/+$/, '');
const explicitToken = String(args.token || process.env.STREAM_CHECK_TOKEN || '');
const TOKEN = explicitToken || (useConfigured && !args.apikey ? pick('ANTHROPIC_AUTH_TOKEN') : '');
const APIKEY = args.apikey ? String(args.apikey) : (useConfigured && !explicitToken ? pick('ANTHROPIC_API_KEY') : '');
const FORMAT = String(args.format || 'auto');
const MODEL_ARG = args.model ? String(args.model) : '';
const TAG = Date.now().toString(36);

/** 地址本身已经以 /v1 结尾就不再重复拼 /v1 */
function endpoint(suffix) {
  return /\/v1$/i.test(BASE) ? BASE + suffix : BASE + '/v1' + suffix;
}

function send(method, urlStr, headers, bodyObj, onData) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { resolve({ status: 0, error: '地址不合法：' + urlStr }); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    let raw = '';
    let firstByteAt = null;
    let dataEvents = 0;
    const req = lib.request({
      method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, rejectUnauthorized: false, timeout: 120000,
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const now = Date.now();
        dataEvents++;
        if (firstByteAt === null) firstByteAt = now;
        if (raw.length < 300000) raw += chunk;
        if (onData) onData(chunk, now);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw, started, firstByteAt, dataEvents, totalMs: Date.now() - started }));
    });
    req.on('timeout', () => { req.destroy(new Error('120 秒没有响应')); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message || e), started, totalMs: Date.now() - started }));
    req.end(bodyObj ? JSON.stringify(bodyObj) : undefined);
  });
}

// 直连时两种鉴权头都带同一把 key，和用户的路由一样，网关认哪个都行
function authHeaders(anthropic) {
  const h = {};
  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
  if (anthropic) {
    if (APIKEY) h['x-api-key'] = APIKEY;
    else if (explicitToken) h['x-api-key'] = explicitToken;
  } else if (!TOKEN && APIKEY) h['Authorization'] = 'Bearer ' + APIKEY;
  return h;
}

const PROMPT = '请从 1 数到 120，每个数字单独一行，只输出数字，不要任何其他文字。（编号 ' + TAG + '）';

/** 逐行解析 SSE，把每个"模型输出片段"（正文或思考过程）的到达时刻记下来 */
function makeCollector(kind) {
  const st = { buf: '', pieces: 0, text: '', firstPieceAt: null, lastPieceAt: null, firstTextAt: null };
  st.feed = (chunk, now) => {
    st.buf += chunk;
    let idx;
    while ((idx = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, idx).trim();
      st.buf = st.buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (e) { continue; }
      let piece = '', isText = false;
      if (kind === 'anthropic') {
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (typeof ev.delta.text === 'string') { piece = ev.delta.text; isText = true; }
          else if (typeof ev.delta.thinking === 'string') piece = ev.delta.thinking;
        }
      } else {
        const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (d) {
          if (typeof d.content === 'string' && d.content) { piece = d.content; isText = true; }
          else if (typeof d.reasoning_content === 'string' && d.reasoning_content) piece = d.reasoning_content;
          else if (typeof d.reasoning === 'string' && d.reasoning) piece = d.reasoning;
        }
      }
      if (!piece) continue;
      st.pieces++;
      if (st.firstPieceAt === null) st.firstPieceAt = now;
      st.lastPieceAt = now;
      if (isText) { st.text += piece; if (st.firstTextAt === null) st.firstTextAt = now; }
    }
  };
  return st;
}

function summarize(kind, model, r, col) {
  const o = {
    base: BASE, format: kind, model, status: r.status || 0,
    ttfbMs: r.firstByteAt ? r.firstByteAt - r.started : null,
    ttftMs: col.firstTextAt ? col.firstTextAt - r.started : null,
    totalMs: r.totalMs, pieces: col.pieces, textChars: col.text.length, dataEvents: r.dataEvents || 0,
    spreadMs: (col.firstPieceAt !== null && col.lastPieceAt !== null) ? col.lastPieceAt - col.firstPieceAt : null,
    contentType: r.headers ? String(r.headers['content-type'] || '') : '',
    error: '',
  };
  if (r.error) o.error = r.error;
  else if (o.status >= 400) o.error = String(r.raw || '').slice(0, 300);
  else if (o.status === 200 && !col.pieces) o.error = '返回 200 但没解析出任何片段，可能不是流式响应（Content-Type：' + o.contentType + '）：' + String(r.raw || '').slice(0, 200);
  if (o.status === 200 && col.pieces >= 5) {
    if (o.spreadMs >= 200) { o.verdict = 'streaming'; o.charsPerSec = Math.round(col.text.length / Math.max(0.001, o.spreadMs / 1000)); }
    else if (o.spreadMs < 50) o.verdict = 'buffered';
    else o.verdict = 'unclear';
  } else o.verdict = o.status === 200 ? 'unclear' : 'failed';
  return o;
}

async function tryAnthropic(model) {
  const col = makeCollector('anthropic');
  const headers = Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'Accept': 'text/event-stream' }, authHeaders(true));
  const body = { model, max_tokens: 800, stream: true, messages: [{ role: 'user', content: PROMPT }] };
  const r = await send('POST', endpoint('/messages'), headers, body, col.feed);
  return summarize('anthropic', model, r, col);
}

async function listOpenAIModels() {
  const r = await send('GET', endpoint('/models'), Object.assign({ 'Accept': 'application/json' }, authHeaders(false)), null, null);
  if (r.status !== 200) return [];
  try { const j = JSON.parse(r.raw); return (j.data || []).map((m) => m.id).filter(Boolean); } catch (e) { return []; }
}

async function tryOpenAI(model) {
  const col = makeCollector('openai');
  const headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, authHeaders(false));
  const body = { model, max_tokens: 800, stream: true, messages: [{ role: 'user', content: PROMPT }] };
  const r = await send('POST', endpoint('/chat/completions'), headers, body, col.feed);
  return summarize('openai', model, r, col);
}

(async () => {
  if (!BASE) { console.log('STREAM ' + JSON.stringify({ verdict: 'failed', error: '没有端点地址：Claude Code 没配置 ANTHROPIC_BASE_URL，也没给 --base' })); return; }
  const tried = [];
  let res = null;
  if (FORMAT === 'auto' || FORMAT === 'anthropic') {
    const m = MODEL_ARG || pick('ANTHROPIC_DEFAULT_SONNET_MODEL') || pick('ANTHROPIC_MODEL') || 'claude-sonnet-4-5';
    res = await tryAnthropic(m);
    tried.push({ format: 'anthropic', status: res.status, error: res.error ? res.error.slice(0, 160) : '' });
  }
  const anthropicMissing = res && (res.status === 404 || res.status === 405 || (res.status === 0 && /ECONNRESET|socket hang up/.test(res.error || '')));
  if (FORMAT === 'openai' || (FORMAT === 'auto' && anthropicMissing)) {
    let models = [];
    let m = MODEL_ARG;
    if (!m) { models = await listOpenAIModels(); m = models[0] || pick('ANTHROPIC_MODEL') || 'default'; }
    res = await tryOpenAI(m);
    res.modelList = models.slice(0, 20);
    tried.push({ format: 'openai', status: res.status, error: res.error ? res.error.slice(0, 160) : '' });
  }
  res.tried = tried;
  res.auth = TOKEN ? 'Bearer' : (APIKEY ? 'api-key' : 'none');
  console.log('STREAM ' + JSON.stringify(res));
})().catch((e) => { console.log('STREAM ' + JSON.stringify({ verdict: 'failed', error: String(e && e.stack || e).slice(0, 300) })); });
