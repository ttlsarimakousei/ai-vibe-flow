'use strict';
/*
 * 浏览器启动与事件收集（第二档 / 第二点五档共用）。
 * 启动顺序：环境变量 PROBE_BROWSER_PATH 指定的可执行文件 → 系统 Edge → 系统 Chrome → Playwright 自带 Chromium（内网通常没有）。
 * 不下载任何浏览器：内网机器靠系统自带的 Edge。
 */
const { chromium } = require('playwright');

function trim(s, n) {
  n = n || 200;
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function launchBrowser(opts) {
  opts = opts || {};
  const headless = !opts.headed;
  const attempts = [];
  if (process.env.PROBE_BROWSER_PATH) {
    attempts.push({ label: 'executablePath=' + process.env.PROBE_BROWSER_PATH, options: { executablePath: process.env.PROBE_BROWSER_PATH } });
  }
  attempts.push({ label: '系统 Edge（channel=msedge）', options: { channel: 'msedge' } });
  attempts.push({ label: '系统 Chrome（channel=chrome）', options: { channel: 'chrome' } });
  attempts.push({ label: 'Playwright 自带 Chromium', options: {} });
  const errors = [];
  for (const a of attempts) {
    try {
      const browser = await chromium.launch(Object.assign({ headless }, a.options));
      return { browser, via: a.label };
    } catch (e) {
      errors.push(a.label + ' → ' + trim(String(e && e.message || e).split('\n')[0], 160));
    }
  }
  throw new Error('无法启动任何浏览器：\n  ' + errors.join('\n  ') + '\n  可设置环境变量 PROBE_BROWSER_PATH 指向 msedge.exe 或 chrome.exe');
}

async function newPage(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });
  ctx.setDefaultTimeout(opts.timeout || 10000);
  const page = await ctx.newPage();
  const collectors = attachCollectors(page);
  return { ctx, page, collectors };
}

/** 收集 console 错误、页面异常、失败请求（>=400 或网络失败）——文本模型的"眼睛"之一 */
function attachCollectors(page) {
  const c = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('console', (m) => { if (m.type() === 'error') c.consoleErrors.push(trim(m.text())); });
  page.on('pageerror', (e) => c.pageErrors.push(trim(e && e.message || e)));
  page.on('requestfailed', (r) => c.failedRequests.push({ url: r.url(), status: 0, reason: (r.failure() || {}).errorText || 'failed' }));
  page.on('response', (r) => { if (r.status() >= 400) c.failedRequests.push({ url: r.url(), status: r.status() }); });
  return c;
}

module.exports = { launchBrowser, newPage, attachCollectors, trim };
