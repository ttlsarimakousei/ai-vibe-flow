'use strict';
/*
 * 首字时延、提示缓存与流式输出探测。回答三个问题：
 *   1. 上下文越长，等第一个字要多久（决定长会话的体感）
 *   2. 同样的前缀连发两次，第二次是不是明显更快（网关有没有做提示缓存复用）
 *   3. 回复是逐字流出来的，还是网关攒成整段一次性给（决定写长内容时是看着它写还是干等）
 *
 * 量法上的两个坑，第一版都踩了，内网第一次的结论因此被夸大：
 *   - 第一个请求要付建连和握手的钱，拿它当"冷启动"，小上下文会被算得偏慢、"缓存效果"会被算得偏大。
 *     所以先发一个不计分的热身请求。
 *   - 不同长度如果共用同一段开头，网关的前缀缓存会让大的那档"半热"，增长倍数被低估。
 *     所以每一档在开头放一个独有编号，档与档之间不共享前缀；同一档的两次请求前缀完全相同，用来测缓存。
 *
 * 只用 Node 内置模块。用法：
 *   node tools/latency-probe.js [--out 目录] [--model 模型名] [--sizes 2000,32000,200000] [--repeat 2]
 * 端点从环境变量或 ~/.claude/settings.json 的 env 段读取。
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
const OUT = path.resolve(args.out || path.join(__dirname, '..', 'results', 'latency'));
fs.mkdirSync(OUT, { recursive: true });

function readSettingsEnv() {
  // 直连某个模型时（模型对比）不能读 settings.json：那里写的是路由地址和占位 key
  if (process.env.PROBE_IGNORE_SETTINGS === '1') return {};
  const f = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(f)) return {};
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).env) || {}; } catch (e) { return {}; }
}
const senv = readSettingsEnv();
const pick = (k) => process.env[k] || senv[k] || '';

const BASE = (pick('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
const TOKEN = pick('ANTHROPIC_AUTH_TOKEN');
const APIKEY = pick('ANTHROPIC_API_KEY');
const MODEL = args.model || pick('ANTHROPIC_DEFAULT_SONNET_MODEL') || pick('ANTHROPIC_MODEL') || 'claude-sonnet-4-5';
const SIZES = String(args.sizes || '2000,32000,200000').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const REPEAT = Math.max(1, parseInt(args.repeat || '2', 10));
const RUN_ID = Date.now().toString(36);

/** 填充文本：开头放本档独有编号，保证档与档之间没有公共前缀 */
function filler(chars, tag) {
  const unit = '这是一段用于测量上下文长度对首字时延影响的填充文本。The quick brown fox jumps over the lazy dog. 段落编号 ';
  let s = '测量编号 ' + tag + '。以下是填充文本，请忽略。\n';
  let i = 0;
  while (s.length < chars) { s += unit + (i++) + '。\n'; }
  return s.slice(0, chars);
}

/** 发一个流式请求，逐个解析 SSE 事件，记下首字节、首个文本片段、最后一个文本片段的时刻 */
function request(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + '/v1/messages');
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'Accept': 'text/event-stream' };
    // 两个都有就两个头都带，和用户的路由一样，网关认哪个都行
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    if (APIKEY) headers['x-api-key'] = APIKEY;

    const started = Date.now();
    let firstByteAt = null, firstTextAt = null, lastTextAt = null;
    let chunks = 0, text = '', outTokens = null, buf = '', raw = '';

    const req = lib.request({
      method: 'POST', hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, rejectUnauthorized: false, timeout: 180000,
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const now = Date.now();
        if (firstByteAt === null) firstByteAt = now;
        raw += chunk;
        if (raw.length > 200000) raw = raw.slice(-100000);
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
            chunks++;
            text += ev.delta.text;
            if (firstTextAt === null) firstTextAt = now;
            lastTextAt = now;
          } else if (ev.type === 'message_delta' && ev.usage && ev.usage.output_tokens != null) {
            outTokens = ev.usage.output_tokens;
          }
        }
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        ttfbMs: firstByteAt ? firstByteAt - started : null,
        ttftMs: firstTextAt ? firstTextAt - started : null,
        totalMs: Date.now() - started,
        chunks, textChars: text.length, outTokens,
        spreadMs: (firstTextAt !== null && lastTextAt !== null) ? lastTextAt - firstTextAt : null,
        error: res.statusCode >= 400 ? raw.slice(0, 400) : '',
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('180 秒无响应')); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function sizedBody(chars, tag) {
  return {
    model: MODEL, max_tokens: 16, stream: true,
    system: '你是一个用于性能测量的回声服务。只回复两个字：收到。',
    messages: [{ role: 'user', content: filler(chars, tag) + '\n\n以上是填充文本，忽略它。只回复两个字：收到。' }],
  };
}
function streamBody() {
  return {
    model: MODEL, max_tokens: 400, stream: true,
    system: '你是一个用于测量输出速度的服务。',
    messages: [{ role: 'user', content: '请从 1 数到 120，每个数字单独一行，只输出数字，不要任何其他文字。（编号 ' + RUN_ID + '-stream）' }],
  };
}
const fmt = (v) => (v === null || v === undefined ? '-' : String(v));

(async () => {
  const report = {
    baseUrl: BASE, model: MODEL,
    auth: TOKEN && APIKEY ? 'Authorization 与 x-api-key 都带' : (TOKEN ? 'Authorization: Bearer' : (APIKEY ? 'x-api-key' : '无凭据')),
    sizes: SIZES, repeat: REPEAT, runId: RUN_ID,
    warmup: null, rows: [], streaming: null, notes: [],
  };
  console.log('端点 ' + BASE + '  模型 ' + MODEL + '  鉴权 ' + report.auth);

  // 1. 热身：吸收建连与握手，不计分
  try {
    const w = await request(sizedBody(200, RUN_ID + '-warm'));
    report.warmup = { status: w.status, totalMs: w.totalMs };
    console.log('热身请求（不计分）：' + w.totalMs + ' ms，状态 ' + w.status);
  } catch (e) {
    report.warmup = { error: String(e && e.message || e).slice(0, 200) };
    console.log('热身请求失败：' + report.warmup.error);
  }

  // 2. 各档上下文：档与档不共享前缀，同档两次前缀相同
  console.log('');
  console.log('  上下文字符 | 第几次 | 首字节 ms | 首个文本 ms | 总耗时 ms | 状态');
  console.log('  ---|---|---|---|---|---');
  for (const size of SIZES) {
    const tag = RUN_ID + '-' + size;
    for (let r = 1; r <= REPEAT; r++) {
      let row;
      try {
        const res = await request(sizedBody(size, tag));
        row = { size, run: r, ttfbMs: res.ttfbMs, ttftMs: res.ttftMs, totalMs: res.totalMs, status: res.status, error: res.error };
      } catch (e) {
        row = { size, run: r, ttfbMs: null, ttftMs: null, totalMs: null, status: 0, error: String(e && e.message || e).slice(0, 200) };
      }
      report.rows.push(row);
      console.log('  ' + String(size).padStart(10) + ' | ' + r + ' | ' + fmt(row.ttfbMs).padStart(9) + ' | ' + fmt(row.ttftMs).padStart(11) +
        ' | ' + fmt(row.totalMs).padStart(9) + ' | ' + (row.status === 200 ? 'OK' : (row.status || 'ERR') + ' ' + (row.error || '').slice(0, 80)));
    }
  }

  // 3. 流式输出：让它输出一段较长的内容，看片段是陆续到达还是同时到达
  try {
    const s = await request(streamBody());
    report.streaming = { status: s.status, ttftMs: s.ttftMs, totalMs: s.totalMs, chunks: s.chunks, spreadMs: s.spreadMs, textChars: s.textChars, outTokens: s.outTokens, error: s.error };
    console.log('');
    console.log('流式测试：首个文本 ' + fmt(s.ttftMs) + ' ms，总耗时 ' + s.totalMs + ' ms，文本片段 ' + s.chunks + ' 个，首末片段间隔 ' + fmt(s.spreadMs) + ' ms，状态 ' + s.status);
  } catch (e) {
    report.streaming = { error: String(e && e.message || e).slice(0, 200) };
  }

  // 4. 判读：只说数据撑得住的话
  const notes = report.notes;
  const ok = report.rows.filter((r) => r.status === 200 && r.ttftMs !== null);
  if (!ok.length) {
    notes.push('全部请求失败，端点或凭据不通。401 换用 x-api-key 头；404 检查 BASE_URL 有没有多带 /v1；模型名报错向网关方要正确的模型名。');
  } else {
    const byS = {};
    ok.forEach((r) => { (byS[r.size] = byS[r.size] || []).push(r); });
    const sizes = Object.keys(byS).map(Number).sort((a, b) => a - b);
    const cold = (s) => (byS[s].find((r) => r.run === 1) || byS[s][0]).ttftMs;
    if (sizes.length >= 2) {
      const lo = cold(sizes[0]), hi = cold(sizes[sizes.length - 1]);
      const ratio = hi / Math.max(1, lo);
      let v;
      if (hi <= 5000) v = '最长那档也在 5 秒内，长上下文不是体验瓶颈。';
      else if (hi <= 15000) v = '长上下文会明显变慢，长会话要注意适时压缩。';
      else v = '长上下文非常慢，这很可能是内网体验不如桌面版的主要原因之一，压上下文长度比什么都值得做。';
      notes.push('冷启动首字：' + sizes[0] + ' 字符 ' + lo + ' ms，' + sizes[sizes.length - 1] + ' 字符 ' + hi + ' ms，约 ' + ratio.toFixed(1) + ' 倍。' + v);
    }
    sizes.forEach((s) => {
      const r1 = byS[s].find((r) => r.run === 1), r2 = byS[s].find((r) => r.run === 2);
      if (!r1 || !r2) return;
      const drop = 1 - r2.ttftMs / Math.max(1, r1.ttftMs);
      if (s < 10000) notes.push(s + ' 字符：太短，两次相差 ' + Math.round(drop * 100) + '% 属于正常波动，看不出有没有缓存。');
      else notes.push(s + ' 字符：同样前缀第二次比第一次快 ' + Math.round(drop * 100) + '%。' + (drop > 0.3 ? '有提示缓存，会话前缀保持稳定就能提速。' : '没看到明显的缓存效果。'));
    });
  }
  const st = report.streaming;
  if (st && st.status === 200) {
    let v;
    if (st.chunks >= 5 && st.spreadMs >= 200) {
      const speed = Math.round(st.textChars / (st.spreadMs / 1000));
      v = '逐字流式输出，写长内容时能边写边看；生成速度约 ' + speed + ' 字符每秒。';
    } else if (st.chunks >= 5 && st.spreadMs < 50) {
      v = '回复是攒成整段一次性返回的（' + st.chunks + ' 个片段在 ' + st.spreadMs + ' ms 内同时到达），写长内容时会先干等再一下子全出来，这是和桌面版体感差距的一个来源，可以找网关方确认是否关了流式转发。';
    } else {
      v = '片段太少或间隔不典型，看不出是否流式（' + st.chunks + ' 个片段，间隔 ' + fmt(st.spreadMs) + ' ms）。';
    }
    notes.push('流式输出：' + v);
  } else if (st) {
    notes.push('流式测试没跑成：' + (st.error || ('状态 ' + st.status)).slice(0, 120));
  }

  fs.writeFileSync(path.join(OUT, 'latency.json'), JSON.stringify(report, null, 1));
  const md = ['# 首字时延、提示缓存与流式输出', '', '- 端点：' + BASE, '- 模型：' + MODEL, '- 鉴权：' + report.auth,
    '- 热身请求：' + (report.warmup && report.warmup.totalMs !== undefined ? report.warmup.totalMs + ' ms（不计分，吸收建连开销）' : '失败'), '',
    '| 上下文字符 | 第几次 | 首字节 ms | 首个文本 ms | 总耗时 ms | 状态 |', '|---|---|---|---|---|---|']
    .concat(report.rows.map((r) => '| ' + r.size + ' | ' + r.run + ' | ' + fmt(r.ttfbMs) + ' | ' + fmt(r.ttftMs) + ' | ' + fmt(r.totalMs) + ' | ' + (r.status === 200 ? 'OK' : (r.status || 'ERR')) + ' |'))
    .concat(['', '## 判读', ''].concat(notes.map((n) => '- ' + n)));
  fs.writeFileSync(path.join(OUT, 'latency.md'), md.join('\n'));
  console.log('');
  notes.forEach((n) => console.log('  ' + n));
  console.log('');
  console.log('报告：' + path.join(OUT, 'latency.md'));
  process.exit(ok.length ? 0 : 1);
})().catch((e) => { console.error('探测失败：' + (e && e.stack || e)); process.exit(1); });
