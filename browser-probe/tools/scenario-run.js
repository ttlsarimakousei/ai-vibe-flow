'use strict';
/*
 * 第二点五档：场景执行器。模型写场景文件（JSON，几行声明式步骤），脚本执行并回传文本结果。
 * 用法：node tools/scenario-run.js <scenario.json> [--out <目录>] [--base <url>] [--headed]
 * 退出码：0 全部通过；1 有步骤失败；2 参数错误。
 * 步骤格式见 scenarios/README.md。选择器既可以是字符串（CSS / text= / role=），也可以是语义对象
 * （{"label":"用户名"}、{"role":"button","name":"登录"}、{"placeholder":"…"}、{"text":"…"}、{"testid":"…"}）。
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
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const args = parseArgs(process.argv.slice(2));
if (!args._[0]) { console.error('用法：node tools/scenario-run.js <scenario.json> [--out 目录] [--base url] [--headed]'); process.exit(2); }
const scenarioPath = path.resolve(args._[0]);
let scenario;
try { scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (e) { console.error('场景文件读取失败：' + e.message); process.exit(2); }
if (!Array.isArray(scenario.steps) || !scenario.steps.length) { console.error('场景文件缺少 steps 数组'); process.exit(2); }

const BASE = args.base || scenario.base || process.env.PROBE_BASE || ('http://127.0.0.1:' + (process.env.PROBE_PORT || 4173));
const OUT = path.resolve(args.out || path.join(__dirname, '..', 'results', stamp(), 'scenario', path.basename(scenarioPath, '.json')));
fs.mkdirSync(OUT, { recursive: true });
const consoleIgnore = (scenario.consoleIgnore || []).map((s) => new RegExp(s));

const result = { name: scenario.name || path.basename(scenarioPath), scenario: scenarioPath, base: BASE, out: OUT, via: null, ok: true, steps: [], values: {}, consoleErrors: [], ignoredConsoleErrors: [], pageErrors: [], failedRequests: [], artifacts: [] };

function resolveUrl(u) { return /^https?:\/\//i.test(u) ? u : BASE + (u.startsWith('/') ? '' : '/') + u; }
function describe(st) {
  const k = Object.keys(st).filter((x) => x !== 'note')[0];
  return k + ' ' + JSON.stringify(st[k]) + (st.value !== undefined ? ' = ' + JSON.stringify(st.value) : '') + (st.count !== undefined ? ' (count ' + st.count + ')' : '') + (st.as ? ' → ' + st.as : '');
}
function keyOf(st) { return st.as || ('v' + (Object.keys(result.values).length + 1)); }

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
function isIgnored(msg) { return consoleIgnore.some((re) => re.test(msg)); }

async function runStep(ctx, st) {
  const { page, col } = ctx;
  const scope = () => (ctx.frameSel ? page.frameLocator(ctx.frameSel) : page);
  const all = (sel) => resolveLocator(scope(), sel);
  const loc = (sel) => all(sel).first();

  if (st.goto !== undefined) { ctx.frameSel = null; await page.goto(resolveUrl(String(st.goto))); return '打开 ' + page.url(); }
  if (st.frame !== undefined) { ctx.frameSel = st.frame ? String(st.frame) : null; return ctx.frameSel ? '后续步骤在 iframe ' + ctx.frameSel + ' 内' : '回到主页面'; }
  if (st.fill !== undefined) { await loc(st.fill).fill(String(st.value == null ? '' : st.value)); return; }
  if (st.type !== undefined) { await loc(st.type).pressSequentially(String(st.value == null ? '' : st.value)); return; }
  if (st.click !== undefined) { await loc(st.click).click(); return; }
  if (st.dblclick !== undefined) { await loc(st.dblclick).dblclick(); return; }
  if (st.hover !== undefined) { await loc(st.hover).hover(); return; }
  if (st.check !== undefined) { await loc(st.check).check(); return; }
  if (st.uncheck !== undefined) { await loc(st.uncheck).uncheck(); return; }
  if (st.press !== undefined) { if (st.selector) await loc(st.selector).press(st.press); else await page.keyboard.press(st.press); return; }
  if (st.select !== undefined) { await loc(st.select).selectOption(String(st.value)); return; }
  if (st.onDialog !== undefined) {
    const accept = String(st.onDialog) !== 'dismiss';
    page.once('dialog', (d) => { result.values[st.as || 'dialog'] = d.message(); if (accept) d.accept(st.text); else d.dismiss(); });
    return '下一个对话框将' + (accept ? '接受' : '取消');
  }
  if (st.wait !== undefined) {
    if (typeof st.wait === 'number') { await page.waitForTimeout(st.wait); return '等待 ' + st.wait + 'ms'; }
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
    const extra = (st.ignore || []).map((s) => new RegExp(s));
    const bad = col.consoleErrors.concat(col.pageErrors).filter((m) => !isIgnored(m) && !extra.some((re) => re.test(m)));
    if (bad.length) throw new Error('存在 ' + bad.length + ' 条 console 错误：' + trim(bad.join(' | '), 200));
    return '无 console 错误';
  }
  if (st.read !== undefined) {
    const t = ((await loc(st.read).textContent()) || '').replace(/\s+/g, ' ').trim();
    result.values[keyOf(st)] = t;
    return keyOf(st) + ' = ' + JSON.stringify(t);
  }
  if (st.readValue !== undefined) {
    const t = await loc(st.readValue).inputValue();
    result.values[keyOf(st)] = t;
    return keyOf(st) + ' = ' + JSON.stringify(t);
  }
  if (st.readCount !== undefined) {
    const n = await all(st.readCount).count();
    result.values[keyOf(st)] = n;
    return keyOf(st) + ' = ' + n;
  }
  if (st.readAttr !== undefined) {
    const t = await loc(st.readAttr).getAttribute(String(st.name || 'value'));
    result.values[keyOf(st)] = t;
    return keyOf(st) + ' = ' + JSON.stringify(t);
  }
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
    const ref = path.resolve(path.dirname(scenarioPath), st.ref);
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
  try {
    const r = await launchBrowser({ headed: !!args.headed });
    browser = r.browser; result.via = r.via;
  } catch (e) {
    result.ok = false; result.fatal = trim(e.message, 400);
    return finish();
  }
  const np = await newPage(browser, { viewport: scenario.viewport, timeout: scenario.timeout });
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
  const ctx = { page: np.page, col: np.collectors, frameSel: null };
  for (let i = 0; i < scenario.steps.length; i++) {
    const st = scenario.steps[i];
    const rec = { i: i + 1, step: describe(st), note: st.note, ok: false, ms: 0 };
    const t = Date.now();
    try {
      const info = await runStep(ctx, st);
      rec.ok = true;
      if (info !== undefined) rec.info = info;
    } catch (e) {
      rec.error = trim(e && e.message || e, 300);
      result.ok = false;
    }
    rec.ms = Date.now() - t;
    result.steps.push(rec);
    console.log((rec.ok ? '  √ ' : '  × ') + rec.i + '. ' + rec.step + ' (' + rec.ms + 'ms)' + (rec.info ? '  ' + rec.info : '') + (rec.error ? '  ' + rec.error : ''));
    if (!rec.ok) {
      try { await ctx.page.screenshot({ path: path.join(OUT, 'failed-step-' + rec.i + '.png') }); result.artifacts.push(path.join(OUT, 'failed-step-' + rec.i + '.png')); } catch (e) { }
      for (let j = i + 1; j < scenario.steps.length; j++) result.steps.push({ i: j + 1, step: describe(scenario.steps[j]), skipped: true });
      break;
    }
  }
  result.consoleErrors = ctx.col.consoleErrors.filter((m) => !isIgnored(m));
  result.ignoredConsoleErrors = ctx.col.consoleErrors.filter((m) => isIgnored(m));
  result.pageErrors = ctx.col.pageErrors;
  result.failedRequests = ctx.col.failedRequests;
  await browser.close();
  finish();
})().catch((e) => { result.ok = false; result.fatal = trim(e && e.stack || e, 500); finish(); });

function finish() {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(OUT, 'result.md'), renderMd(result));
  const compact = {
    ok: result.ok,
    fatal: result.fatal,
    failed: result.steps.filter((s) => !s.ok && !s.skipped).map((s) => s.i + '. ' + s.step + ' → ' + s.error),
    values: result.values,
    consoleErrors: result.consoleErrors.slice(0, 5),
    pageErrors: result.pageErrors.slice(0, 5),
    failedRequests: result.failedRequests.slice(0, 5),
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
