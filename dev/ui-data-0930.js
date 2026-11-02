'use strict';
/*
 * 配置页的"查库"页签和 0930 加的几个开关：接口，加上用无头浏览器真的点一遍。
 *   手动管驱动的卡片和接口 2026-11-02 去掉了（问题表第 36 条：项目声明的驱动直接用），这里核对它们不在了
 *   后台执行器、自动探索、审查问题自动收这几个开关；工具用量的表
 * 用法：node dev/ui-data-0930.js [端口，默认 18795] [截图目录]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18795;
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : '';
const h = H.makeHome('uidata');
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
fs.writeFileSync(path.join(h.cfg, 'settings.json'), '{}\n');
fs.writeFileSync(path.join(h.kit, 'VERSION'), '20260930.0000\n');
const line = (o) => JSON.stringify(Object.assign({ at: Date.now() }, o)) + '\n';
fs.writeFileSync(path.join(h.kit, 'state', 'tool-usage.jsonl'), Array.from({ length: 22 }, () => line({ tool: 'ttls-db-crud', cmd: 'peek', exit: 0, ms: 1900, java: 1, errors: [], project: 'p' })).join('') + line({ tool: 'ttls-redis', cmd: 'get', exit: 0, ms: 12, errors: [], project: 'p' }));

const call = (method, url, body) => new Promise((resolve) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, agent: false, headers: Object.assign({ 'content-type': 'application/json', 'x-vibe-router': '1' }, data ? { 'content-length': data.length } : {}) }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', (e) => resolve({ status: 0, json: null, text: String(e) }));
  if (data) req.write(data);
  req.end();
});

(async () => {
  const watch = await H.watchWindows('uidata-win');
  const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  router.stdout.on('data', (d) => { log += d; });
  router.stderr.on('data', (d) => { log += d; });
  let browser = null;
  const stopAll = async () => { try { if (browser) await browser.close(); } catch (e) { /* 已经关了 */ } try { router.kill(); } catch (e) { /* 已经退了 */ } };
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await H.sleep(250); up = (await call('GET', '/ui')).status === 200; }
  H.ok('临时路由起来了，配置页打得开', up, log);
  if (!up) { await stopAll(); return H.done('配置页：查库'); }

  H.section('接口');
  for (const [m, u] of [['GET', '/api/kit/drivers'], ['POST', '/api/kit/drivers/auto'], ['POST', '/api/kit/drivers/use'], ['POST', '/api/kit/drivers/remove'], ['POST', '/api/kit/drivers/scan']]) H.ok('手动管驱动的接口没有了：' + m + ' ' + u, (await call(m, u, {})).status >= 400, u);
  const sv = await call('POST', '/api/kit/config', { dbcrudDaemon: true, dbcrudDaemonIdleMinutes: 10, autoOnboard: false, lessonAuto: false });
  H.ok('新开关存得下', sv.status === 200 && sv.json.config.dbcrudDaemon === true && sv.json.config.dbcrudDaemonIdleMinutes === 10 && sv.json.config.autoOnboard === false && sv.json.config.lessonAuto === false, sv.text);
  const sv2 = await call('POST', '/api/kit/config', { dbcrudDaemonIdleMinutes: 999, autoOnboard: 'yes' });
  H.ok('乱填的不收，保持原样', sv2.json.config.dbcrudDaemonIdleMinutes === 10 && sv2.json.config.autoOnboard === false, sv2.text);
  await call('POST', '/api/kit/config', { dbcrudDaemon: false, dbcrudDaemonIdleMinutes: 5, autoOnboard: true, lessonAuto: true });
  const def = (await call('GET', '/api/kit')).json.config;
  H.ok('默认：自动探索开、审查问题自动收开、后台执行器关', def.autoOnboard === true && def.lessonAuto === true && def.dbcrudDaemon === false && def.dbcrudDaemonIdleMinutes === 5, def);
  const fb = (await call('GET', '/api/kit/feedback')).json;
  H.ok('工具用量跟着问题反馈的接口一起给', fb.tools && fb.tools.stats.some((x) => x.tool === 'ttls-db-crud' && x.cmd === 'peek' && x.n === 22 && x.avg === 1900) && fb.tools.hints.some((x) => /后台执行器/.test(x.detail)), fb.tools);

  H.section('页面');
  let launch = null;
  try { launch = require(path.join(H.SRC, 'kit', 'page', 'browser.js')); } catch (e) { launch = null; }
  let page = null;
  const errors = [];
  try {
    const r = await launch.launchBrowser({});
    browser = r.browser;
    // 关掉切页的动画和平滑滚动：强制点击隐藏的开关时元素还在动，会点空（0930 回归里偶发过一次）
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
    page.on('dialog', (d) => d.accept());
  } catch (e) { console.log('  这台电脑上起不来浏览器，页面那部分没法测：' + String((e && e.message) || e).split('\n')[0]); }
  if (page) {
    const shot = async (name, view) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !view }); } };
    await page.goto('http://127.0.0.1:' + PORT + '/ui');
    await page.waitForSelector('#meta:has-text("今天")');
    H.ok('导航里叫"查库"', (await page.locator('nav > button').allInnerTexts()).includes('查库'), await page.locator('nav > button').allInnerTexts());
    await page.click('nav button[data-tab="data"]');
    const secs = (await page.locator('#subnav a').allInnerTexts()).map((s) => s.replace(/^\d+\s*/, '').trim());
    H.ok('这一页两节："现在用的驱动"去掉了', secs.join('|') === '查库快一点|用得怎么样', secs);
    H.ok('页面上写清驱动不用配', /驱动不用配/.test(await page.locator('#tab-data .pagehead').innerText()));
    H.ok('手动管驱动的表和按钮都不在了', (await page.locator('#drvList, #drvAuto, #drvRefresh').count()) === 0);
    await page.waitForSelector('#tuList tr td.mono');
    H.ok('用量的表和"能优化的地方"', /ttls-db-crud\s+peek\s+22/.test((await page.locator('#tuList').innerText()).replace(/\t/g, ' ')) && /后台执行器/.test(await page.locator('#tuHints').innerText()), [await page.locator('#tuList').innerText(), await page.locator('#tuHints').innerText()]);
    // 后台执行器的开关：走底部的保存条
    await page.locator('#k_dbcrudDaemon').setChecked(true, { force: true });
    await page.waitForSelector('#savebar.on');
    H.ok('改了后台执行器：保存条冒出来', /查库的后台执行器/.test(await page.locator('#barWhat').innerText()), await page.locator('#barWhat').innerText());
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('存下了', (await call('GET', '/api/kit')).json.config.dbcrudDaemon === true);
    await shot('6-data-full');
    await page.click('nav button[data-tab="kit"]');
    await page.waitForFunction(() => document.getElementById('k_contextPercent').value !== '');
    const ksecs = (await page.locator('#subnav a').allInnerTexts()).map((s) => s.replace(/^\d+\s*/, '').trim());
    // 20261102 起（问题表第 29、30 条）自动探索不做开关，自动模式合成一节
    H.ok('套件开关页没有"自动探索""提示规则""清点技能"这几节', ksecs.join('|') === '上下文和交接|状态栏|全局：过程文件|全局：审查与产物|自动模式|提交|保护', ksecs);
    H.ok('审查问题自动收（在经验规则那一页）默认开着；自动探索没有开关', (await page.locator('#k_autoOnboard').count()) === 0 && (await page.locator('#tab-lessons #k_lessonAuto').isChecked()));
    const opts = await page.locator('#tab-kit .opt, #tab-data .opt, #tab-lessons .opt, #tab-remote .opt').evaluateAll((els) => els.map((e) => ({ t: (e.querySelector('.t') || {}).textContent || '', d: (e.querySelector(':scope > div > .d') || {}).textContent || '' })));
    H.ok('新加的开关也是一句话说明，不超过 90 个字', opts.every((o) => o.t.trim() && o.d.trim() && o.d.trim().length <= 90), opts.filter((o) => o.d.trim().length > 90).map((o) => o.t + ' ' + o.d.trim().length));
    H.ok('页面上没有报错', errors.length === 0, errors);
  }
  await stopAll();
  await H.sleep(500);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('配置页：查库');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
