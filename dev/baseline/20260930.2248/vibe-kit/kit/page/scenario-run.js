'use strict';
/*
 * 第二点五档：场景执行器。模型写场景文件（JSON，几行声明式步骤），脚本执行并回传文本结果。
 * 用法：node scenario-run.js <scenario.json> [--base <url>] [--out <目录>] [--headed] [--max <秒>]
 *   goto 写相对地址时必须给站点地址（--base，或场景里的 "base"），没给就报错退出，不去猜端口；
 *   不写 --out 时结果放在当前目录的 .vibe/out/<场景文件名>/。
 *   时限：整个场景默认最多跑 5 分钟（--max 改），到点把已有的结果写出来退出；wait 写的毫秒数最多等 60 秒，timeout 最多 120 秒。
 *   consoleIgnore / ignore 默认按字面子串匹配，写成 "/…/" 才当正则。
 * 退出码：0 全部通过；1 有步骤失败；2 参数或场景文件有错（不是合法 JSON、没有 steps、相对地址没给 --base、忽略规则里的正则写错）。
 * 步骤格式见 ttls-see-page 技能目录里的 scenario-format.md。选择器既可以是字符串（CSS / text= / role=），也可以是语义对象
 * （{"label":"用户名"}、{"role":"button","name":"登录"}、{"placeholder":"…"}、{"text":"…"}、{"testid":"…"}）。
 * 接口场景：request 调后端接口、waitResponse 等页面发出的请求返回，expectStatus / expectJson 查状态码和返回的 JSON，readJson 读出来给后面的步骤用（{{名字}}）。
 *   和页面共用登录状态；场景里全是接口步骤时不开浏览器。
 * 断言（expect 开头的）可以和动作写在同一步里：先做动作，再查。登录这种"失败了也返回 200"的接口，就在等响应的那一步里直接查返回的字段。
 *   以前同一步里的断言会被悄悄忽略，登录没成功场景照样往下走（问题反馈 F20260929-017）。
 *   同一步里写了两个动作（不是断言）的，只做第一个，结果里记一条提醒。
 * 模型路由自己的地址（配置页、套件的接口）不许打开、调用：退出码 2。
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, newPage, trim } = require('./browser');
const { collectLayout, layoutToText } = require('./layout-tree');
const { diffPng, attribute, toText: pixelText, paintRects } = require('./pixel-diff');

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const USAGE = '用法：node scenario-run.js <scenario.json> [--base 站点地址] [--out 目录] [--headed] [--max 秒数]';
if (!args._[0]) { console.error(USAGE); process.exit(2); }
for (const k of ['base', 'out']) if (args[k] === true) { console.error('--' + k + ' 后面要写' + (k === 'base' ? '站点地址，比如 --base http://127.0.0.1:5173' : '目录') + '。' + USAGE); process.exit(2); }
// 整个场景的时限（秒）。以前没有总时限：页面一直转圈、wait 写成几十万毫秒，模型那条命令就一直挂着
const MAX_SEC = args.max === undefined ? 300 : Number(args.max);
if (args.max === true || !(MAX_SEC > 0)) { console.error('--max 后面写秒数，比如 --max 600。' + USAGE); process.exit(2); }
// 单步最多等多久：写大了按上限算，结果里记一条提醒
const WAIT_CAP = 60000;
const TIMEOUT_CAP = 120000;
const scenarioPath = path.resolve(args._[0]);
let scenario;
// 记事本另存的 UTF-8 带 BOM，JSON.parse 不认
try { scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8').replace(/^﻿/, '')); } catch (e) { console.error('场景文件读取失败：' + e.message); process.exit(2); }
if (!scenario || typeof scenario !== 'object') { console.error('场景文件缺少 steps 数组'); process.exit(2); }
if (!Array.isArray(scenario.steps) || !scenario.steps.length) { console.error('场景文件缺少 steps 数组'); process.exit(2); }

// 站点地址：--base、场景里的 base、环境变量 PROBE_BASE / PROBE_PORT。都没有就不猜：以前默认连 4173，忘了带 --base 只会报"连不上"
const BASE = String(args.base || scenario.base || process.env.PROBE_BASE || (process.env.PROBE_PORT ? 'http://127.0.0.1:' + process.env.PROBE_PORT : ''));
// 带协议的就是完整地址（http:、https:、file:、about:blank、data: …）；协议至少两个字母，免得把 C:/ 这种盘符当成协议
const isAbsUrl = (u) => /^[a-z][a-z0-9+.-]+:/i.test(u);
/** 接口步骤的地址："POST /api/orders" 或 { method, url } */
function requestOf(st) {
  const r = st.request;
  if (r && typeof r === 'object') return { method: String(r.method || 'GET').toUpperCase(), url: String(r.url || '') };
  const m = String(r).trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i);
  return m ? { method: m[1].toUpperCase(), url: m[2] } : { method: 'GET', url: String(r).trim() };
}
const urlSteps = scenario.steps.filter((st) => st && typeof st === 'object').map((st) => (st.goto !== undefined ? String(st.goto) : st.request !== undefined ? requestOf(st).url : null)).filter((u) => u !== null);
const relUrl = urlSteps.find((u) => !isAbsUrl(u));
if (!BASE && relUrl !== undefined) { console.error('场景里的 goto / request 是相对地址（' + JSON.stringify(relUrl) + '），但没给站点地址：命令里加上 --base http://127.0.0.1:<端口>（前端服务或后端接口的地址）。本地的 HTML 文件写成 file:/// 开头的完整地址就不用 --base'); process.exit(2); }

// 配置页和路由的接口不是被测的项目：场景不许打开、调用它们（那里能点"清空""断开"、改套件的开关）
function routerPort() {
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'router-data', 'config.json'), 'utf8').replace(/^\uFEFF/, '')); const p = Number((c.listen || {}).port); return p > 0 && p < 65536 ? Math.round(p) : 15730; } catch (e) { return 15730; }
}
function isRouterUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loop = h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
    return loop && Number(x.port || (x.protocol === 'https:' ? 443 : 80)) === routerPort();
  } catch (e) { return false; }
}
const ROUTER_MSG = '是模型路由自己的地址（配置页、套件的接口），不是被测的项目。场景只能打开、调用你自己起的服务';
const hitRouter = (BASE && isRouterUrl(BASE)) ? BASE : urlSteps.map((u) => (isAbsUrl(u) ? u : BASE + (u.startsWith('/') ? '' : '/') + u)).find(isRouterUrl);
if (hitRouter) { console.error(hitRouter + ' ' + ROUTER_MSG + '。'); process.exit(2); }
// 只调接口、不看页面的场景：不开浏览器
const API_STEPS = ['request', 'expectStatus', 'expectJson', 'readJson', 'wait', 'note'];
const apiOnly = scenario.steps.every((st) => st && typeof st === 'object' && Object.keys(st).filter((k) => !['as', 'note', 'json', 'form', 'headers', 'params', 'method', 'equals', 'contains', 'exists', 'gte', 'lte', 'timeout'].includes(k)).every((k) => API_STEPS.includes(k)) && (st.wait === undefined || typeof st.wait === 'number'));
// 一步里的动作：expect 开头的是断言，可以跟在别的动作后面；别的一步只做一个（waitResponse 可以带一个触发请求的动作）
const ACTIONS = ['request', 'waitResponse', 'expectStatus', 'expectJson', 'readJson', 'goto', 'frame', 'fill', 'type', 'click', 'dblclick', 'hover', 'check', 'uncheck', 'press', 'select', 'upload', 'onFileChooser', 'onDialog', 'wait', 'waitHidden', 'waitText', 'waitUrl', 'waitIdle', 'expectText', 'expectCount', 'expectVisible', 'expectUrl', 'expectNoConsoleErrors', 'read', 'readValue', 'readCount', 'readAttr', 'screenshot', 'layout', 'diff'];
const WITH_WAIT = ['click', 'dblclick', 'press', 'goto', 'fill', 'type', 'select', 'check'];
/** 把一步拆开：main 是要做的动作（去掉了断言），checks 是跟在后面的断言（一条一个对象），extra 是多写的、不会做的动作 */
function splitStep(st) {
  const acts = ACTIONS.filter((k) => st[k] !== undefined);
  const expects = acts.filter((k) => /^expect/.test(k));
  const others = acts.filter((k) => !/^expect/.test(k));
  if (acts.length <= 1) return { main: st, checks: [], extra: [] };
  if (!others.length) {
    // 只有断言、写了好几条：一条一条查
    const m = {};
    for (const k of Object.keys(st)) if (!ACTIONS.includes(k)) m[k] = st[k];
    return { main: Object.assign({}, m, { [expects[0]]: st[expects[0]] }), checks: expects.slice(1).map((k) => Object.assign({}, m, { [k]: st[k] })), extra: [] };
  }
  let keep = [others[0]];
  if (st.waitResponse !== undefined) { keep = ['waitResponse']; const a = WITH_WAIT.find((k) => st[k] !== undefined); if (a) keep.push(a); }
  // readJson 和 request / waitResponse 写在一起：先发请求，再读
  const reads = others.filter((k) => k === 'readJson' && !keep.includes(k) && (st.request !== undefined || st.waitResponse !== undefined));
  const extra = others.filter((k) => !keep.includes(k) && !reads.includes(k));
  const main = {};
  for (const k of Object.keys(st)) if (!ACTIONS.includes(k) || keep.includes(k)) main[k] = st[k];
  const mods = {};
  for (const k of Object.keys(st)) if (!ACTIONS.includes(k) && k !== 'as') mods[k] = st[k];
  const checks = reads.map((k) => Object.assign({}, mods, { [k]: st[k] }, st.as ? { as: st.as } : {})).concat(expects.map((k) => Object.assign({}, mods, { [k]: st[k] })));
  // 读出来的名字留给 readJson：request / waitResponse 自己不再占这个名字
  if (reads.length) delete main.as;
  return { main, checks, extra };
}

/**
 * console 错误的忽略规则。默认按字面子串匹配："[Vue warn]" 就是这几个字（以前当正则，方括号成了字符类，几乎什么错误都被忽略了）；
 * 写成 "/…/" 才当正则。按以前的说明写的转义写法（"\\[Vue warn\\]"）去掉反斜杠后也按字面认
 */
function ignoreRules(list, where) {
  if (list === undefined || list === null) return [];
  return (Array.isArray(list) ? list : [list]).map((p) => {
    const s = String(p);
    if (!s) return () => false;
    if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
      let re;
      try { re = new RegExp(s.slice(1, -1)); } catch (e) { throw new Error(where + ' 里的正则 ' + s + ' 写错了：' + e.message); }
      return (m) => re.test(m);
    }
    const plain = s.replace(/\\(.)/g, (all, c) => c);
    return (m) => m.includes(s) || m.includes(plain);
  });
}
let consoleIgnore;
const stepIgnore = new Map();
try {
  consoleIgnore = ignoreRules(scenario.consoleIgnore, 'consoleIgnore');
  scenario.steps.forEach((st, i) => { if (st && typeof st === 'object' && st.expectNoConsoleErrors !== undefined) stepIgnore.set(st, ignoreRules(st.ignore, '第 ' + (i + 1) + ' 步的 ignore')); });
} catch (e) { console.error(e.message); process.exit(2); }

// 没写 --out：放到当前目录的 .vibe/out/<场景文件名>，跟着项目走（以前放进套件目录，卸载也不删）
const OUT = path.resolve(args.out || path.join('.vibe', 'out', path.basename(scenarioPath).replace(/\.json$/i, '')));
fs.mkdirSync(OUT, { recursive: true });
// 截图、结果别被提交进仓库：.vibe/ 加进这个仓库的 .gitignore（已经有了就不动）
if (!args.out) { try { require('../lib/session.js').ensureVibeIgnored(OUT); } catch (e) { /* 老版本没有，或者不是 git 仓库 */ } }
const maskRects = {};

const result = { name: scenario.name || path.basename(scenarioPath), scenario: scenarioPath, base: BASE, out: OUT, via: null, ok: true, steps: [], values: {}, warnings: [], consoleErrors: [], ignoredConsoleErrors: [], pageErrors: [], failedRequests: [], artifacts: [] };

function resolveUrl(u) { return /^(https?|file):\/\//i.test(u) ? u : BASE + (u.startsWith('/') ? '' : '/') + u; }
/** 前面读到的值：字符串里的 {{名字}} 换成 values 里的值；整个字符串就是一个 {{名字}} 的，换成原值（数字还是数字） */
function subst(v) {
  if (typeof v === 'string') {
    const whole = v.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (whole && result.values[whole[1]] !== undefined) return result.values[whole[1]];
    return v.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => (result.values[k] === undefined ? all : typeof result.values[k] === 'object' ? JSON.stringify(result.values[k]) : String(result.values[k])));
  }
  if (Array.isArray(v)) return v.map(subst);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = subst(v[k]); return o; }
  return v;
}
/** 返回的 JSON 里按路径取值：data.list[0].name；length 取数组、字符串的长度；空路径是整个返回 */
function jsonAt(obj, p) {
  const parts = String(p == null ? '' : p).trim().replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '');
  let cur = obj;
  for (const k of parts) {
    if (k === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}
/** 值相等：按 JSON 比（对象不管键的顺序） */
function canon(v) { return v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}') : JSON.stringify(v); }
/** 等哪个地址的响应："/…/" 按正则，带 * 按通配（** 跨目录），否则按包含 */
function urlMatcher(want) {
  if (want.length > 2 && want.startsWith('/') && want.endsWith('/')) { const re = new RegExp(want.slice(1, -1)); return (u) => re.test(u); }
  if (want.includes('*')) { const re = new RegExp('^' + want.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'); return (u) => re.test(u); }
  return (u) => u.includes(want);
}
/** 响应记下来给后面的 expectStatus / expectJson / readJson 用 */
async function snapResponse(res, method) {
  let text = '';
  try { text = await res.text(); } catch (e) { /* 没有内容 */ }
  let json;
  try { json = JSON.parse(text); } catch (e) { /* 不是 JSON */ }
  return { status: res.status(), url: res.url(), method, text, json };
}
const oneLine = (s, n) => trim(String(s || '').replace(/\s+/g, ' '), n || 200);
function describe(st) {
  if (!st || typeof st !== 'object') return JSON.stringify(st);
  const k = Object.keys(st).filter((x) => x !== 'note')[0];
  return k + ' ' + JSON.stringify(st[k]) + (st.value !== undefined ? ' = ' + JSON.stringify(st.value) : '') + (st.count !== undefined ? ' (count ' + st.count + ')' : '') + (st.as ? ' → ' + st.as : '');
}
function keyOf(st) { return st.as || ('v' + (Object.keys(result.values).length + 1)); }
/** 读到的值写进一行输出：太长的截断，全文在 result.json 里（一整页的文字、一个大 JSON 不往模型的上下文里灌） */
const BRIEF = 200;
function brief(v) {
  const s = String(JSON.stringify(v));
  return s.length > BRIEF ? s.slice(0, BRIEF) + '…（共 ' + s.length + ' 字，全文见 result.json）' : s;
}
/** 记下读到的值，返回这一步的说明 */
function keep(st, v) { const k = keyOf(st); result.values[k] = v; return k + ' = ' + brief(v); }
const warned = new Set();
function warnOnce(msg) { if (warned.has(msg)) return; warned.add(msg); result.warnings.push(msg); }
/** 场景、步骤里写的 timeout：最多 120 秒 */
function capTimeout(v) {
  const n = Number(v);
  if (!(n > 0)) return undefined;
  if (n > TIMEOUT_CAP) { warnOnce('timeout 写了 ' + n + 'ms，最多等 ' + TIMEOUT_CAP / 1000 + ' 秒，按 ' + TIMEOUT_CAP / 1000 + ' 秒算'); return TIMEOUT_CAP; }
  return n;
}

/** 选择器 → Locator。字符串走 Playwright 原生选择器；对象走语义定位（不依赖 id/类名，适合组件化、函数式渲染的页面） */
function resolveLocator(scope, sel) {
  if (sel && typeof sel === 'object') {
    const exact = !!sel.exact;
    if (sel.label !== undefined) return scope.getByLabel(String(sel.label), { exact });
    if (sel.role !== undefined) return sel.name !== undefined ? scope.getByRole(String(sel.role), { name: String(sel.name), exact }) : scope.getByRole(String(sel.role));
    if (sel.text !== undefined) return scope.getByText(String(sel.text), { exact });
    if (sel.placeholder !== undefined) return scope.getByPlaceholder(String(sel.placeholder), { exact });
    if (sel.testid !== undefined) return scope.getByTestId(String(sel.testid));
    if (sel.title !== undefined) return scope.getByTitle(String(sel.title), { exact });
    if (sel.alt !== undefined) return scope.getByAltText(String(sel.alt), { exact });
    if (sel.css !== undefined) return scope.locator(String(sel.css));
    throw new Error('不认识的选择器对象：' + JSON.stringify(sel) + '（支持 label / role+name / text / placeholder / testid / title / alt / css）');
  }
  return scope.locator(String(sel));
}
function isIgnored(msg) { return consoleIgnore.some((f) => f(String(msg))); }
/** 要上传的文件：相对场景文件所在的目录；不存在的当场说清 */
function filesOf(list) {
  const arr = (Array.isArray(list) ? list : [list]).filter((x) => x !== undefined && x !== null && x !== '').map((x) => path.resolve(path.dirname(scenarioPath), String(subst(String(x)))));
  if (!arr.length) throw new Error('没写要上传哪个文件：加上 "files": ["相对场景文件的路径"]');
  for (const f of arr) if (!fs.existsSync(f)) throw new Error('要上传的文件不存在：' + f + '（路径相对场景文件所在的目录）');
  return arr;
}

async function runStep(ctx, st) {
  const { page, col } = ctx;
  const scope = () => (ctx.frameSel ? page.frameLocator(ctx.frameSel) : page);
  const all = (sel) => resolveLocator(scope(), sel);
  const loc = (sel) => all(sel).first();

  // ---------- 接口 ----------
  if (st.request !== undefined) {
    const { method, url } = requestOf(st);
    const full = resolveUrl(String(subst(url)));
    if (isRouterUrl(full)) throw new Error(full + ' ' + ROUTER_MSG);
    const opts = { method, failOnStatusCode: false, ignoreHTTPSErrors: true, timeout: capTimeout(st.timeout || scenario.timeout) || 10000 };
    if (st.headers) opts.headers = subst(st.headers);
    if (st.params) opts.params = subst(st.params);
    if (st.json !== undefined) { opts.data = subst(st.json); opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}); }
    if (st.form !== undefined) opts.form = subst(st.form);
    const res = await ctx.api.fetch(full, opts);
    ctx.resp = await snapResponse(res, method);
    if (st.as) result.values[st.as] = ctx.resp.status;
    return method + ' ' + full + ' → ' + ctx.resp.status + '  ' + oneLine(ctx.resp.text, 160);
  }
  if (st.waitResponse !== undefined) {
    const match = urlMatcher(String(subst(st.waitResponse)));
    const method = st.method ? String(st.method).toUpperCase() : '';
    const waiting = page.waitForResponse((r) => match(r.url()) && (!method || r.request().method() === method), capTimeout(st.timeout) ? { timeout: capTimeout(st.timeout) } : undefined);
    waiting.catch(() => {});
    // 同一步里写的动作：先开始等，再做它，免得请求在开始等之前就回来了
    const act = ['click', 'dblclick', 'press', 'goto', 'fill', 'type', 'select', 'check'].find((k) => st[k] !== undefined);
    if (act) { const sub = { [act]: st[act] }; if (st.value !== undefined) sub.value = st.value; if (st.selector !== undefined) sub.selector = st.selector; await runStep(ctx, sub); }
    const res = await waiting;
    ctx.resp = await snapResponse(res, res.request().method());
    if (st.as) result.values[st.as] = ctx.resp.status;
    return ctx.resp.method + ' ' + ctx.resp.url + ' → ' + ctx.resp.status + '  ' + oneLine(ctx.resp.text, 160);
  }
  if (st.expectStatus !== undefined || st.expectJson !== undefined || st.readJson !== undefined) {
    const r = ctx.resp;
    if (!r) throw new Error('前面没有 request / waitResponse 步骤，没有可检查的响应');
    if (st.expectStatus !== undefined) {
      const want = (Array.isArray(st.expectStatus) ? st.expectStatus : [st.expectStatus]).map(Number);
      if (!want.includes(r.status)) throw new Error('状态码 ' + r.status + '，期望 ' + want.join(' / ') + '。返回：' + oneLine(r.text));
      return '状态码 ' + r.status;
    }
    if (r.json === undefined) throw new Error('返回的不是 JSON（状态码 ' + r.status + '）：' + oneLine(r.text));
    const p = st.expectJson !== undefined ? st.expectJson : st.readJson;
    const name = String(p) || '整个返回';
    const at = jsonAt(r.json, p);
    const show = (v) => trim(JSON.stringify(v), 120);
    if (st.readJson !== undefined) {
      if (!at.found) throw new Error('返回里没有 ' + name + '：' + oneLine(r.text));
      return keep(st, at.value);
    }
    if (st.exists === false) { if (at.found) throw new Error(name + ' 不该有，实际 = ' + show(at.value)); return name + ' 没有'; }
    if (!at.found) throw new Error('返回里没有 ' + name + '：' + oneLine(r.text));
    const v = at.value;
    if (st.equals !== undefined) { const want = subst(st.equals); if (canon(v) !== canon(want)) throw new Error(name + ' = ' + show(v) + '，期望 ' + show(want)); }
    if (st.contains !== undefined) {
      const want = subst(st.contains);
      const hit = Array.isArray(v) ? v.some((x) => canon(x) === canon(want) || (typeof x === 'string' && x.includes(String(want)))) : String(typeof v === 'object' ? JSON.stringify(v) : v).includes(String(want));
      if (!hit) throw new Error(name + ' = ' + show(v) + '，不包含 ' + show(want));
    }
    if (st.gte !== undefined && !(Number(v) >= Number(st.gte))) throw new Error(name + ' = ' + show(v) + '，期望 ≥ ' + st.gte);
    if (st.lte !== undefined && !(Number(v) <= Number(st.lte))) throw new Error(name + ' = ' + show(v) + '，期望 ≤ ' + st.lte);
    return name + ' = ' + show(v);
  }

  if (st.goto !== undefined) {
    const full = resolveUrl(String(subst(String(st.goto))));
    if (isRouterUrl(full)) throw new Error(full + ' ' + ROUTER_MSG);
    ctx.frameSel = null; await page.goto(full); return '打开 ' + page.url();
  }
  if (st.frame !== undefined) { ctx.frameSel = st.frame ? String(st.frame) : null; return ctx.frameSel ? '后续步骤在 iframe ' + ctx.frameSel + ' 内' : '回到主页面'; }
  if (st.fill !== undefined) { await loc(st.fill).fill(String(st.value == null ? '' : subst(st.value))); return; }
  if (st.type !== undefined) { await loc(st.type).pressSequentially(String(st.value == null ? '' : subst(st.value))); return; }
  // force：控件被别的元素盖住（自己画的上传按钮盖在 input 上这类）、点不到时用，不等它"能点"直接点
  const how = st.force ? { force: true } : undefined;
  if (st.click !== undefined) { await loc(st.click).click(how); return st.force ? '强制点击（没查它是不是被盖住）' : undefined; }
  if (st.dblclick !== undefined) { await loc(st.dblclick).dblclick(how); return; }
  if (st.hover !== undefined) { await loc(st.hover).hover(how); return; }
  if (st.check !== undefined) { await loc(st.check).check(how); return; }
  if (st.uncheck !== undefined) { await loc(st.uncheck).uncheck(how); return; }
  // 上传文件：直接把文件交给 <input type="file">（藏起来的也行），不用点开系统的文件选择框
  if (st.upload !== undefined) {
    const files = filesOf(st.files);
    await loc(st.upload).setInputFiles(files);
    return '选了 ' + files.length + ' 个文件：' + files.map((f) => path.basename(f)).join('、');
  }
  // 页面是点了按钮才弹文件选择框的：放在那一步点击之前，弹出来时自动选上这几个文件
  if (st.onFileChooser !== undefined) {
    const files = filesOf(st.onFileChooser === true ? st.files : st.onFileChooser);
    page.once('filechooser', (fc) => { fc.setFiles(files).catch(() => {}); });
    return '下一个文件选择框将选 ' + files.map((f) => path.basename(f)).join('、');
  }
  if (st.press !== undefined) { if (st.selector) await loc(st.selector).press(st.press); else await page.keyboard.press(st.press); return; }
  if (st.select !== undefined) { await loc(st.select).selectOption(String(st.value)); return; }
  if (st.onDialog !== undefined) {
    const accept = String(st.onDialog) !== 'dismiss';
    page.once('dialog', (d) => { result.values[st.as || 'dialog'] = d.message(); if (accept) d.accept(st.text); else d.dismiss(); });
    return '下一个对话框将' + (accept ? '接受' : '取消');
  }
  if (st.wait !== undefined) {
    // 只调接口的场景没开浏览器，没有 page
    if (typeof st.wait === 'number') {
      const ms = Math.max(0, Math.min(st.wait, WAIT_CAP));
      if (st.wait > WAIT_CAP) warnOnce('wait 写了 ' + st.wait + 'ms，最多等 ' + WAIT_CAP / 1000 + ' 秒。等页面上的东西出现用 {"wait": "选择器"} 或 waitText');
      await (page ? page.waitForTimeout(ms) : new Promise((r) => setTimeout(r, ms)));
      return '等待 ' + ms + 'ms' + (st.wait > WAIT_CAP ? '（写的是 ' + st.wait + 'ms，按上限等）' : '');
    }
    await loc(st.wait).waitFor({ state: 'visible' }); return;
  }
  if (st.waitHidden !== undefined) { await loc(st.waitHidden).waitFor({ state: 'hidden' }); return; }
  if (st.waitText !== undefined) { await scope().getByText(String(st.waitText)).first().waitFor({ state: 'visible' }); return; }
  if (st.waitUrl !== undefined) { await page.waitForURL(st.waitUrl); return page.url(); }
  if (st.waitIdle !== undefined) { await page.waitForLoadState('networkidle'); return '网络空闲'; }
  if (st.expectText !== undefined) {
    const n = await scope().getByText(String(st.expectText)).count();
    if (n === 0) throw new Error('页面上找不到文本「' + st.expectText + '」');
    return '匹配 ' + n + ' 处';
  }
  if (st.expectCount !== undefined) {
    const n = await all(st.expectCount).count();
    if (n !== st.count) throw new Error('「' + JSON.stringify(st.expectCount) + '」数量 = ' + n + '，期望 ' + st.count);
    return '数量 ' + n;
  }
  if (st.expectVisible !== undefined) {
    const v = await loc(st.expectVisible).isVisible();
    if (!v) throw new Error('元素不可见：' + JSON.stringify(st.expectVisible));
    return;
  }
  if (st.expectUrl !== undefined) { await page.waitForURL(st.expectUrl, { timeout: 3000 }); return page.url(); }
  if (st.expectNoConsoleErrors !== undefined) {
    const extra = stepIgnore.get(st) || [];
    const bad = col.consoleErrors.concat(col.pageErrors).filter((m) => !isIgnored(m) && !extra.some((f) => f(String(m))));
    if (bad.length) throw new Error('存在 ' + bad.length + ' 条 console 错误：' + trim(bad.join(' | '), 200));
    return '无 console 错误';
  }
  // 没写 as 的，名字按顺序排 v1、v2…（以前先存值再算名字，说明里的名字比存的多一号）
  if (st.read !== undefined) return keep(st, ((await loc(st.read).textContent()) || '').replace(/\s+/g, ' ').trim());
  if (st.readValue !== undefined) return keep(st, await loc(st.readValue).inputValue());
  if (st.readCount !== undefined) return keep(st, await all(st.readCount).count());
  if (st.readAttr !== undefined) return keep(st, await loc(st.readAttr).getAttribute(String(st.name || 'value')));
  if (st.screenshot !== undefined) {
    const f = path.join(OUT, String(st.screenshot) + '.png');
    const full = !!st.fullPage;
    // 遮罩不用 Playwright 的 mask 选项（它注入的高亮脚本在 Chromium 92 这类老浏览器上会报错），
    // 而是先记下元素坐标，正常截图后自己把这些区域涂掉
    let rects = [];
    if (Array.isArray(st.mask) && st.mask.length) {
      for (const m of st.mask) {
        const rs = await all(m).evaluateAll((els, useScroll) => els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.left + (useScroll ? window.scrollX : 0), y: r.top + (useScroll ? window.scrollY : 0), w: r.width, h: r.height };
        }), full);
        rects = rects.concat(rs.filter((r) => r.w > 0 && r.h > 0));
      }
    }
    await page.screenshot({ path: f, animations: 'disabled', fullPage: full });
    const painted = rects.length ? paintRects(f, rects) : 0;
    // 记下遮罩，后面和设计图比对时把设计图的同一块也涂掉，两边同色才不算差异
    maskRects[String(st.screenshot)] = rects;
    result.artifacts.push(f);
    return f + (painted ? '（遮罩 ' + painted + ' 处）' : '');
  }
  if (st.layout !== undefined) {
    let tree;
    const opts = { root: st.root, maxNodes: st.maxNodes || 200 };
    if (ctx.frameSel) {
      const handle = await page.locator(ctx.frameSel).first().elementHandle();
      const frame = handle && await handle.contentFrame();
      if (!frame) throw new Error('取不到 iframe：' + ctx.frameSel);
      tree = await frame.evaluate(collectLayout, opts);
    } else {
      tree = await page.evaluate(collectLayout, opts);
    }
    const fj = path.join(OUT, String(st.layout) + '-layout.json');
    const ft = path.join(OUT, String(st.layout) + '-layout.txt');
    fs.writeFileSync(fj, JSON.stringify(tree, null, 1));
    fs.writeFileSync(ft, layoutToText(tree));
    result.artifacts.push(fj, ft);
    const withComp = tree.filter((n) => n.comp).length;
    return '节点数 ' + tree.length + (withComp ? '，其中 ' + withComp + ' 个能归因到组件' : '') + '，见 ' + ft;
  }
  if (st.diff !== undefined) {
    const actual = path.join(OUT, String(st.diff) + '.png');
    if (!fs.existsSync(actual)) throw new Error('先执行 {"screenshot": "' + st.diff + '"} 再比对');
    if (!st.ref) throw new Error('diff 步骤缺少 ref（设计稿图片路径）');
    let ref = path.resolve(path.dirname(scenarioPath), st.ref);
    const mrects = maskRects[String(st.diff)] || [];
    if (mrects.length) {
      // 涂的是副本，不能动用户的设计图
      const masked = path.join(OUT, String(st.diff) + '-ref-masked.png');
      fs.copyFileSync(ref, masked);
      paintRects(masked, mrects);
      ref = masked;
    }
    const res = await diffPng(actual, ref, { outPath: path.join(OUT, String(st.diff) + '-diff.png') });
    const treeFile = path.join(OUT, String(st.diff) + '-layout.json');
    if (fs.existsSync(treeFile)) res.clusters = attribute(res.clusters, JSON.parse(fs.readFileSync(treeFile, 'utf8')));
    fs.writeFileSync(path.join(OUT, String(st.diff) + '-diff.txt'), pixelText(res));
    result.artifacts.push(path.join(OUT, String(st.diff) + '-diff.txt'));
    const pct = (res.ratio * 100).toFixed(2);
    result.values[st.as || (st.diff + 'Diff')] = pct + '%';
    if (st.max != null && res.ratio * 100 > st.max) throw new Error('像素差异 ' + pct + '% 超过上限 ' + st.max + '%');
    return '像素差异 ' + pct + '%';
  }
  throw new Error('不认识的步骤：' + JSON.stringify(st));
}

(async () => {
  let browser;
  // resp：最近一次 request / waitResponse 的响应；api：发请求用的，和页面共用登录状态（同一个浏览器上下文的 cookie）
  const ctx = { page: null, col: { consoleErrors: [], pageErrors: [], failedRequests: [] }, frameSel: null, api: null, resp: null };
  // 到了总时限还没跑完：正在做的那一步记成失败，后面的记成跳过，把已有的结果写出来退出。浏览器进程由 Playwright 在退出时收掉
  let running = null;
  setTimeout(() => {
    result.ok = false;
    result.fatal = '整个场景超过 ' + MAX_SEC + ' 秒还没跑完，停了。确实要跑更久的，命令里加 --max 秒数';
    if (running) { running.rec.error = '做到这一步时到了总时限'; running.rec.ms = Date.now() - running.t; result.steps.push(running.rec); }
    for (let j = result.steps.length; j < scenario.steps.length; j++) result.steps.push({ i: j + 1, step: describe(scenario.steps[j]), skipped: true });
    collect(ctx);
    finish();
  }, MAX_SEC * 1000);
  if (apiOnly) {
    try { ctx.api = await require('playwright').request.newContext({ ignoreHTTPSErrors: true }); result.via = '只调接口，没开浏览器'; } catch (e) { result.ok = false; result.fatal = trim(e && e.message || e, 400); return finish(); }
  } else {
    try {
      const r = await launchBrowser({ headed: !!args.headed });
      browser = r.browser; result.via = r.via;
    } catch (e) {
      result.ok = false; result.fatal = trim(e.message, 400);
      return finish();
    }
    const np = await newPage(browser, { viewport: scenario.viewport, timeout: capTimeout(scenario.timeout) });
    if (scenario.disableAnimations) {
      // 关掉 CSS 过渡与动画，让截图和像素比对不受中间帧影响（Element Plus 等组件库的弹窗/下拉都有过渡）
      await np.page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';
          document.head.appendChild(s);
        });
      });
    }
    ctx.page = np.page; ctx.col = np.collectors; ctx.api = np.page.context().request;
  }
  for (let i = 0; i < scenario.steps.length; i++) {
    const st = scenario.steps[i];
    const rec = { i: i + 1, step: describe(st), note: st && st.note, ok: false, ms: 0 };
    const t = Date.now();
    running = { i, rec, t };
    try {
      if (!st || typeof st !== 'object') throw new Error('不认识的步骤：' + JSON.stringify(st));
      const parts = splitStep(st);
      const infos = [];
      const info = await runStep(ctx, parts.main);
      if (info !== undefined) infos.push(info);
      // 同一步里写的断言：动作做完接着查，哪一条没过这一步就算失败
      for (const c of parts.checks) { const x = await runStep(ctx, c); if (x !== undefined) infos.push(x); }
      if (parts.extra.length) { const w = '第 ' + (i + 1) + ' 步里写了几个动作，只做了 ' + Object.keys(parts.main).find((k) => ACTIONS.includes(k)) + '，没做 ' + parts.extra.join('、') + '：一步只放一个动作，拆成几步写'; result.warnings.push(w); infos.push('★ ' + w); }
      rec.ok = true;
      if (infos.length) rec.info = infos.join('；');
    } catch (e) {
      rec.error = trim(e && e.message || e, 300);
      result.ok = false;
    }
    rec.ms = Date.now() - t;
    result.steps.push(rec);
    running = null;
    console.log((rec.ok ? '  √ ' : '  × ') + rec.i + '. ' + rec.step + ' (' + rec.ms + 'ms)' + (rec.info ? '  ' + rec.info : '') + (rec.error ? '  ' + rec.error : ''));
    if (!rec.ok) {
      if (ctx.page) { try { await ctx.page.screenshot({ path: path.join(OUT, 'failed-step-' + rec.i + '.png') }); result.artifacts.push(path.join(OUT, 'failed-step-' + rec.i + '.png')); } catch (e) { } }
      for (let j = i + 1; j < scenario.steps.length; j++) result.steps.push({ i: j + 1, step: describe(scenario.steps[j]), skipped: true });
      break;
    }
  }
  collect(ctx);
  // 关浏览器最多等 5 秒：偶尔（系统 Edge）关闭会一直不返回，执行器就永远不退出，模型那条命令一直挂着。到点直接写结果退出，浏览器进程由 Playwright 在退出时收掉
  if (apiOnly && ctx.api) await Promise.race([ctx.api.dispose().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  finish();
})().catch((e) => { result.ok = false; result.fatal = trim(e && e.stack || e, 500); finish(); });

function collect(ctx) {
  result.consoleErrors = ctx.col.consoleErrors.filter((m) => !isIgnored(m));
  result.ignoredConsoleErrors = ctx.col.consoleErrors.filter((m) => isIgnored(m));
  result.pageErrors = ctx.col.pageErrors;
  result.failedRequests = ctx.col.failedRequests;
}

function finish() {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(OUT, 'result.md'), renderMd(result));
  // RESULT 这一行进模型的上下文：读到的值太长的截断（全文在 result.json）
  const values = {};
  for (const k of Object.keys(result.values)) { const v = result.values[k]; const s = typeof v === 'string' ? v : String(JSON.stringify(v)); values[k] = s.length > BRIEF ? s.slice(0, BRIEF) + '…（共 ' + s.length + ' 字，全文见 result.json）' : v; }
  const compact = {
    ok: result.ok,
    fatal: result.fatal,
    failed: result.steps.filter((s) => !s.ok && !s.skipped).map((s) => s.i + '. ' + s.step + ' → ' + s.error),
    warnings: result.warnings.length ? result.warnings : undefined,
    values,
    consoleErrors: result.consoleErrors.slice(0, 5),
    pageErrors: result.pageErrors.slice(0, 5),
    failedRequests: result.failedRequests.slice(0, 5).map((x) => Object.assign({}, x, { url: trim(x.url, 300) })),
    artifacts: result.artifacts,
    out: OUT,
  };
  console.log('RESULT ' + JSON.stringify(compact));
  process.exit(result.ok ? 0 : 1);
}

function renderMd(r) {
  const L = [];
  L.push('# 场景：' + r.name);
  L.push('');
  L.push('- 场景文件：' + r.scenario);
  L.push('- 浏览器：' + (r.via || '未启动'));
  L.push('- 结论：' + (r.ok ? '全部通过' : '有失败') + (r.fatal ? '（异常：' + r.fatal + '）' : ''));
  L.push('');
  L.push('| # | 步骤 | 结果 | 耗时 | 说明 |');
  L.push('|---|---|---|---|---|');
  r.steps.forEach((s) => L.push('| ' + s.i + ' | ' + s.step.replace(/\|/g, '\\|') + ' | ' + (s.skipped ? '跳过' : (s.ok ? '通过' : '失败')) + ' | ' + (s.ms || '') + ' | ' + ((s.info || s.error || '') + '').replace(/\|/g, '\\|') + ' |'));
  L.push('');
  const keys = Object.keys(r.values);
  if ((r.warnings || []).length) { L.push('- 提醒：'); r.warnings.forEach((x) => L.push('  - ' + x)); }
  L.push('- 读取到的值：' + (keys.length ? '' : '无'));
  keys.forEach((k) => L.push('  - ' + k + ' = ' + JSON.stringify(r.values[k])));
  L.push('- console 错误：' + (r.consoleErrors.length ? '' : '无'));
  r.consoleErrors.forEach((x) => L.push('  - ' + x));
  if (r.ignoredConsoleErrors.length) { L.push('- 按规则忽略的 console 错误：'); r.ignoredConsoleErrors.forEach((x) => L.push('  - ' + x)); }
  L.push('- 页面未捕获异常：' + (r.pageErrors.length ? '' : '无'));
  r.pageErrors.forEach((x) => L.push('  - ' + x));
  L.push('- 失败请求：' + (r.failedRequests.length ? '' : '无'));
  r.failedRequests.forEach((x) => L.push('  - ' + x.status + ' ' + x.url + (x.reason ? ' ' + x.reason : '')));
  if (r.artifacts.length) { L.push('- 产物：'); r.artifacts.forEach((x) => L.push('  - ' + x)); }
  return L.join('\n');
}
