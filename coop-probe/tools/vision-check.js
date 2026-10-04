'use strict';
/*
 * 看图能力：直接调模型接口，发图片问问题，按标准答案机械判分。三组题，每组 4 分：
 *   basic ：色块个数、颜色顺序、数字、汉字（沿用浏览器体检的那张图）
 *   table ：一张后台列表截图，读行数、第 3 行金额、"已退款"那一行的订单号、右上角按钮的文字
 *   diff  ：设计稿和实现各一张，找差异：按钮颜色、标题错字、少了"记住我"、两个输入框的间距
 * 设计图还原靠的是后两组：读得懂界面，看得出和设计稿哪里不一样。
 *
 * 用法：node vision-check.js [--out 目录] [--model 名称]
 * 端点和 key 从环境变量读（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY），
 * 两种鉴权头都带上，和用户的路由一样。结果打印成一行 VISION {json}。只用 Node 内置模块。
 */
const fs = require('fs');
const path = require('path');
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
const BASE = String(process.env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';
const APIKEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = args.model || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const OUT = args.out ? path.resolve(String(args.out)) : null;
const DIR = path.join(__dirname, 'vision');

function endpoint() { return /\/v1$/i.test(BASE) ? BASE + '/messages' : BASE + '/v1/messages'; }
function image(name) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(path.join(DIR, name)).toString('base64') } };
}

// 网关回的可能是普通 JSON，也可能不管 stream 参数照样回 SSE，两种都认
function extractText(raw) {
  const t = String(raw || '').trim();
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); } catch (e) { return ''; }
  }
  let s = '';
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    try { const ev = JSON.parse(l.slice(5).trim()); if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') s += ev.delta.text; } catch (e) { }
  }
  return s;
}

function ask(images, prompt) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try { url = new URL(endpoint()); } catch (e) { resolve({ status: 0, ms: 0, text: '', error: '地址不合法：' + BASE }); return; }
    const body = JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: images.map(image).concat([{ type: 'text', text: prompt }]) }] });
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    if (APIKEY) headers['x-api-key'] = APIKEY;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, rejectUnauthorized: false, timeout: 300000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const out = { status: res.statusCode, ms: Date.now() - started, text: '', error: '' };
        if (res.statusCode !== 200) out.error = raw.slice(0, 400);
        else out.text = extractText(raw);
        resolve(out);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('300 秒没有响应')); });
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, text: '', error: String(e && e.message || e) }));
    req.end(body);
  });
}

// 从回答里抠出 JSON：允许包在代码块里、前后带说明文字
function pickJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
function num(v) {
  if (v === null || v === undefined) return NaN;
  return parseFloat(String(v).replace(/[,，¥￥元\s]/g, ''));
}
function colorOf(s) {
  s = String(s);
  if (/红|red/i.test(s)) return '红';
  if (/绿|green/i.test(s)) return '绿';
  if (/蓝|blue/i.test(s)) return '蓝';
  return '?';
}

const GROUPS = [
  {
    id: 'basic', label: '基础', images: ['basic.png'],
    prompt: '看这张图，回答四个问题：图里有几个色块？从左到右各是什么颜色？图里的数字是多少？图里的汉字是什么？\n只输出 JSON，不要解释：{"blocks": 数字, "colors": ["颜色", "颜色"], "number": "数字", "text": "汉字"}。看不清的写 null，不要猜。',
    score(a) {
      const d = [];
      let s = 0;
      if (num(a.blocks) === 3) s++; else d.push('色块数答成 ' + JSON.stringify(a.blocks));
      const arr = Array.isArray(a.colors) ? a.colors : String(a.colors || '').split(/[、,，\s]+/);
      const cs = arr.filter((x) => String(x).trim()).map(colorOf).join('');
      if (cs === '红绿蓝') s++; else d.push('颜色答成 ' + JSON.stringify(a.colors));
      if (String(a.number == null ? '' : a.number).replace(/\D/g, '') === '42') s++; else d.push('数字答成 ' + JSON.stringify(a.number));
      if (String(a.text || '').replace(/\s/g, '').indexOf('内网体检') >= 0) s++; else d.push('汉字答成 ' + JSON.stringify(a.text));
      return { score: s, detail: d.join('；') || '全对' };
    },
  },
  {
    id: 'table', label: '读界面', images: ['table.png'],
    prompt: '这是一个后台页面的截图。回答：表格里一共几行数据（不算表头）？第 3 行的金额是多少？状态是"已退款"的那一行，订单号是什么？页面右上角那个按钮上写的什么字？\n只输出 JSON，不要解释：{"rows": 数字, "amount3": "金额", "refundedOrder": "订单号", "buttonText": "按钮文字"}。看不清的写 null，不要猜。',
    score(a) {
      const d = [];
      let s = 0;
      if (num(a.rows) === 4) s++; else d.push('行数答成 ' + JSON.stringify(a.rows));
      if (Math.abs(num(a.amount3) - 9999) < 0.001) s++; else d.push('第 3 行金额答成 ' + JSON.stringify(a.amount3));
      if (String(a.refundedOrder || '').toUpperCase().indexOf('DD20260903') >= 0) s++; else d.push('已退款的订单号答成 ' + JSON.stringify(a.refundedOrder));
      if (String(a.buttonText || '').replace(/\s/g, '').indexOf('新建订单') >= 0) s++; else d.push('按钮文字答成 ' + JSON.stringify(a.buttonText));
      return { score: s, detail: d.join('；') || '全对' };
    },
  },
  {
    id: 'diff', label: '找设计稿差异', images: ['diff-design.png', 'diff-impl.png'],
    prompt: '第一张是设计稿，第二张是照着设计稿做出来的页面。找出第二张和设计稿不一样的地方，只写真实存在的差异，不要凑数。\n只输出 JSON，不要解释：{"diffs": [{"element": "哪个元素", "change": "哪里不一样"}]}',
    score(a) {
      const items = Array.isArray(a.diffs)
        ? a.diffs.map((x) => (typeof x === 'string' ? x : String((x && x.element) || '') + ' ' + String((x && x.change) || '')))
        : [];
      const EXPECT = [
        { label: '按钮颜色', test: (t) => /按钮|button/i.test(t) && /颜色|色|绿|蓝|green|blue|colou?r/i.test(t) },
        { label: '标题错字（登录写成登陆）', test: (t) => /登陆/.test(t) || (/标题|title/i.test(t) && /错|字|文案|text|typo/i.test(t)) },
        { label: '少了"记住我"', test: (t) => /记住|复选|勾选|checkbox/i.test(t) },
        { label: '两个输入框的间距', test: (t) => /间距|距离|间隔|空隙|留白|margin|spacing|gap/i.test(t) },
      ];
      const used = items.map(() => false);
      const found = [];
      const miss = [];
      for (const e of EXPECT) {
        let hit = false;
        items.forEach((t, i) => { if (e.test(t)) { hit = true; used[i] = true; } });
        (hit ? found : miss).push(e.label);
      }
      const extra = items.filter((t, i) => !used[i]);
      const detail = (miss.length ? '没找出：' + miss.join('、') : '四处差异都找到了') +
        (extra.length ? '；另外多报了 ' + extra.length + ' 条：' + extra.slice(0, 3).join(' / ') : '');
      return { score: found.length, detail, extra: extra.length };
    },
  },
];

function finish(result) {
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'vision.json'), JSON.stringify(result, null, 1));
  }
  const brief = Object.assign({}, result, { groups: {} });
  for (const k of Object.keys(result.groups || {})) {
    const g = result.groups[k];
    brief.groups[k] = { label: g.label, score: g.score, max: g.max, detail: g.detail };
  }
  console.log('VISION ' + JSON.stringify(brief));
}

(async () => {
  const result = { supported: true, status: 0, score: 0, max: 12, groups: {}, model: MODEL, error: '' };
  if (!BASE) { result.supported = null; result.error = '没有端点地址'; finish(result); return; }
  for (const g of GROUPS) {
    const r = await ask(g.images, g.prompt);
    result.status = r.status;
    if (r.status !== 200) {
      // 因为带了图片被拒：这个模型（或网关）不收图片，后面的题不用再问
      if (r.status === 400 && /image|vision|multimodal|图片|图像/i.test(r.error || '')) {
        result.supported = false;
        result.error = (r.error || '').slice(0, 200);
        break;
      }
      result.groups[g.id] = { label: g.label, score: 0, max: 4, detail: '请求失败（状态 ' + r.status + '）：' + String(r.error || '').slice(0, 160), ms: r.ms };
      continue;
    }
    const a = pickJson(r.text);
    if (!a) {
      result.groups[g.id] = { label: g.label, score: 0, max: 4, detail: '回答里没有能解析的 JSON：' + String(r.text).slice(0, 120), ms: r.ms };
      continue;
    }
    const sc = g.score(a);
    result.groups[g.id] = { label: g.label, score: sc.score, max: 4, detail: sc.detail, ms: r.ms, answer: a };
    result.score += sc.score;
  }
  finish(result);
})().catch((e) => finish({ supported: null, status: 0, score: 0, max: 12, groups: {}, error: String(e && e.stack || e).slice(0, 300) }));
