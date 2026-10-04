'use strict';
/*
 * 第二档：Playwright 脚本，固定流程（不需要模型参与）。
 * 流程：登录 → 用户管理数行 → 截图 + 布局树 → 渲染设计稿版本 → 像素比对 + 归因 → 布局树比对 → 订单导出提示 → 设置页错误捕获。
 * 用法：node tools/tier2-run.js [--out <目录>] [--base http://127.0.0.1:4173] [--headed]
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, newPage, trim } = require('./browser');
const { collectLayout, layoutDiff, layoutToText, diffToText } = require('./layout-tree');
const { diffPng, attribute, toText: pixelText } = require('./pixel-diff');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
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
const OUT = path.resolve(args.out || path.join(__dirname, '..', 'results', stamp(), 'tier2'));
const BASE = args.base || process.env.PROBE_BASE || ('http://127.0.0.1:' + (process.env.PROBE_PORT || 4173));
fs.mkdirSync(OUT, { recursive: true });

const report = { tier: 2, name: 'Playwright 脚本（固定流程）', base: BASE, out: OUT, startedAt: new Date().toISOString(), via: null, ok: true, steps: [], eyes: {} };
const t0 = Date.now();

async function step(name, fn) {
  const t = Date.now();
  const s = { name, ok: false, ms: 0 };
  try {
    const info = await fn();
    s.ok = true;
    if (info !== undefined) s.info = info;
  } catch (e) {
    s.error = trim(e && e.message || e, 300);
    report.ok = false;
  }
  s.ms = Date.now() - t;
  report.steps.push(s);
  console.log((s.ok ? '  √ ' : '  × ') + name + ' (' + s.ms + 'ms)' + (s.info ? '  ' + s.info : '') + (s.error ? '  ' + s.error : ''));
  return s;
}

function write(name, text) { fs.writeFileSync(path.join(OUT, name), text); }

(async () => {
  let browser, ctx, page, col;
  let actualTree = null, refTree = null, rows = 0;

  await step('启动浏览器', async () => {
    const r = await launchBrowser({ headed: !!args.headed });
    browser = r.browser; report.via = r.via;
    const np = await newPage(browser);
    ctx = np.ctx; page = np.page; col = np.collectors;
    return r.via;
  });
  if (!browser) return finish();

  await step('登录（填表 + 点击 + 等跳转）', async () => {
    await page.goto(BASE + '/login.html');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'admin123');
    await page.click('button:has-text("登录")');
    await page.waitForURL('**/dashboard.html*');
    const who = await page.locator('#who').textContent();
    return '登录后显示「' + who + '」';
  });

  await step('进入用户管理并数表格行数', async () => {
    await page.click('.nav a[href="#users"]');
    await page.waitForFunction(() => document.querySelectorAll('#userTable tbody tr').length >= 1);
    await page.waitForTimeout(200);
    rows = await page.locator('#userTable tbody tr').count();
    if (rows !== 5) throw new Error('表格行数 = ' + rows + '，期望 5');
    return '表格数据行数 = ' + rows + '（正确）';
  });

  await step('截图 + 布局树（实际页面）', async () => {
    await page.screenshot({ path: path.join(OUT, 'actual-users.png'), animations: 'disabled' });
    actualTree = await page.evaluate(collectLayout, { maxNodes: 200 });
    write('actual-layout.json', JSON.stringify(actualTree, null, 1));
    write('actual-layout.txt', layoutToText(actualTree));
    return '节点数 ' + actualTree.length;
  });

  await step('渲染设计稿版本（?ref=1）截图 + 布局树', async () => {
    const p2 = await ctx.newPage();
    await p2.goto(BASE + '/dashboard.html?ref=1#users');
    await p2.waitForFunction(() => document.querySelectorAll('#userTable tbody tr').length >= 1);
    await p2.waitForTimeout(200);
    await p2.screenshot({ path: path.join(OUT, 'ref-users.png'), animations: 'disabled' });
    refTree = await p2.evaluate(collectLayout, { maxNodes: 200 });
    write('ref-layout.json', JSON.stringify(refTree, null, 1));
    write('ref-layout.txt', layoutToText(refTree));
    await p2.close();
    return '节点数 ' + refTree.length;
  });

  await step('布局树比对（逐节点坐标与样式）', async () => {
    const d = layoutDiff(actualTree || [], refTree || []);
    report.eyes.layout = d;
    write('layout-diff.json', JSON.stringify(d, null, 1));
    write('layout-diff.txt', diffToText(d));
    return '位置尺寸差异 ' + d.summary.rectDiffs + ' 处（归组 ' + d.summary.rectGroups + '），样式差异 ' + d.summary.styleDiffs + ' 处（归组 ' + d.summary.styleGroups + '）';
  });

  await step('像素比对 + 差异归因到节点', async () => {
    const res = await diffPng(path.join(OUT, 'actual-users.png'), path.join(OUT, 'ref-users.png'), { outPath: path.join(OUT, 'diff-users.png') });
    const moved = new Set(((report.eyes.layout || {}).rectDiffs || []).map((r) => r.p));
    res.clusters = attribute(res.clusters, actualTree || [], { moved });
    report.eyes.pixel = res;
    write('diff-users.json', JSON.stringify(res, null, 1));
    write('diff-users.txt', pixelText(res));
    return 'diff ' + (res.ratio * 100).toFixed(2) + '%，差异区域 ' + res.clusters.length + ' 个';
  });

  await step('订单管理：点击导出并读提示文字', async () => {
    await page.click('.nav a[href="#orders"]');
    await page.click('#exportBtn');
    const toast = page.locator('#toast');
    await toast.waitFor({ state: 'visible' });
    const t = await toast.textContent();
    report.eyes.toast = t;
    return '提示文字「' + t + '」';
  });

  await step('系统设置：捕获 console 错误、页面异常、失败请求', async () => {
    await page.click('.nav a[href="#settings"]');
    await page.waitForTimeout(800);
    report.eyes.console = { consoleErrors: col.consoleErrors, pageErrors: col.pageErrors, failedRequests: col.failedRequests };
    write('console.json', JSON.stringify(report.eyes.console, null, 1));
    return 'console 错误 ' + col.consoleErrors.length + ' 条，页面异常 ' + col.pageErrors.length + ' 条，失败请求 ' + col.failedRequests.length + ' 个';
  });

  await step('关闭浏览器', async () => { await browser.close(); });
  finish();
})().catch((e) => {
  console.error('第二档异常终止：' + (e && e.stack || e));
  report.ok = false;
  report.fatal = trim(e && e.message || e, 300);
  finish();
});

function finish() {
  report.finishedAt = new Date().toISOString();
  report.totalMs = Date.now() - t0;
  write('report.json', JSON.stringify(report, null, 1));
  write('report.md', renderMd(report));
  console.log('\n第二档' + (report.ok ? '全部通过' : '有失败步骤') + '，总耗时 ' + report.totalMs + 'ms，报告：' + path.join(OUT, 'report.md'));
  process.exit(report.ok ? 0 : 1);
}

function renderMd(r) {
  const L = [];
  L.push('# 第二档：Playwright 脚本（固定流程）');
  L.push('');
  L.push('- 浏览器启动方式：' + (r.via || '未启动'));
  L.push('- 站点：' + r.base);
  L.push('- 总耗时：' + r.totalMs + ' ms');
  L.push('- 结论：' + (r.ok ? '全部通过' : '有失败步骤') + (r.fatal ? '（异常：' + r.fatal + '）' : ''));
  L.push('');
  L.push('## 步骤');
  L.push('');
  L.push('| # | 步骤 | 结果 | 耗时 | 说明 |');
  L.push('|---|---|---|---|---|');
  r.steps.forEach((s, i) => L.push('| ' + (i + 1) + ' | ' + s.name + ' | ' + (s.ok ? '通过' : '失败') + ' | ' + s.ms + ' ms | ' + (s.info || s.error || '') + ' |'));
  L.push('');
  L.push('## 文本化的眼睛（模型不看图，只读下面这些）');
  L.push('');
  if (r.eyes.layout) { L.push('### 布局树比对'); L.push(''); L.push('```'); L.push(diffToText(r.eyes.layout)); L.push('```'); L.push(''); }
  if (r.eyes.pixel) { L.push('### 像素比对'); L.push(''); L.push('```'); L.push(pixelText(r.eyes.pixel)); L.push('```'); L.push(''); }
  if (r.eyes.console) {
    const c = r.eyes.console;
    L.push('### console 与请求');
    L.push('');
    L.push('- console 错误：' + (c.consoleErrors.length ? '' : '无'));
    c.consoleErrors.forEach((x) => L.push('  - ' + x));
    L.push('- 页面未捕获异常：' + (c.pageErrors.length ? '' : '无'));
    c.pageErrors.forEach((x) => L.push('  - ' + x));
    L.push('- 失败请求：' + (c.failedRequests.length ? '' : '无'));
    c.failedRequests.forEach((x) => L.push('  - ' + x.status + ' ' + x.url + (x.reason ? ' ' + x.reason : '')));
    L.push('');
  }
  L.push('## 产物');
  L.push('');
  ['actual-users.png', 'ref-users.png', 'diff-users.png', 'actual-layout.txt', 'ref-layout.txt', 'layout-diff.txt', 'diff-users.txt', 'console.json'].forEach((f) => {
    if (fs.existsSync(path.join(r.out, f))) L.push('- ' + f);
  });
  L.push('');
  L.push('设计稿与实际之间预埋了 6 处偏差（侧栏宽度、主色、标题字号、内容区内边距、单元格内边距、内容区左边距）。上面的比对抓到几处，就说明这双"眼睛"有多灵。');
  return L.join('\n');
}
