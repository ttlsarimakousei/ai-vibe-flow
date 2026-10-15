'use strict';
/*
 * 配置页的"数据库驱动"页签和 0930 加的几个开关：接口，加上用无头浏览器真的点一遍。
 *   看现在用的驱动 → 自动搜索（到 Maven 仓库里找，没有驱动的自动登记）→ 每一行后面的"换驱动"（在弹窗里选 jar、粘贴路径）→ 不用了
 *   后台执行器、自动探索、审查问题自动收这几个开关；工具用量的表
 * 要真的驱动 jar 才测得了"找"和"登记"：这台电脑上用户自己装过 urai-db-crud 的话，从它的 drivers 目录里只读地拷两个来用；没有就只测接口的壳子。
 * 用法：node dev/ui-data-0930.js [端口，默认 18795] [截图目录]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18795;
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : '';
const REAL = path.join(os.homedir(), '.claude', 'skills', 'urai-db-crud', 'drivers');
const jarOf = (n) => (fs.existsSync(path.join(REAL, n)) ? path.join(REAL, n) : '');
const DM = jarOf('dm-jdbc-driver-18.jar');
const MYSQL = jarOf('mysql-connector-j-8.4.0.jar');
const KB = jarOf('kingbase8-8.6.0.jar');
const HAS = !!(DM && MYSQL && KB);

const h = H.makeHome('uidata');
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
fs.writeFileSync(path.join(h.cfg, 'settings.json'), '{}\n');
fs.writeFileSync(path.join(h.kit, 'VERSION'), '20260930.0000\n');
// 一个 Maven 本地仓库：达梦一个版本、MySQL 两个版本；另外一个目录里放着金仓的 jar（自己选的时候用）
const repo = H.tempDir('uidata-m2');
const loose = H.tempDir('uidata-jars');
if (HAS) {
  const put = (src, rel) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.copyFileSync(src, path.join(repo, rel)); };
  put(DM, 'com/dameng/DmJdbcDriver18/8.1.1.134/DmJdbcDriver18-8.1.1.134.jar');
  put(MYSQL, 'com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar');
  put(MYSQL, 'mysql/mysql-connector-java/8.0.33/mysql-connector-java-8.0.33.jar');
  fs.copyFileSync(KB, path.join(loose, 'kingbase8-8.6.0.jar'));
}
fs.writeFileSync(path.join(loose, 'not-a-driver.jar'), 'PK not really');
fs.writeFileSync(path.join(loose, 'readme.txt'), 'x');
fs.writeFileSync(path.join(h.kit, 'local.json'), JSON.stringify({ jdks: [], mavens: [{ name: '内网', repo }] }));
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
  if (!up) { await stopAll(); return H.done('配置页：数据库驱动'); }
  console.log('    这台电脑上' + (HAS ? '有' : '没有') + '可以拿来测的真驱动');

  H.section('接口');
  const s0 = (await call('GET', '/api/kit/drivers')).json;
  H.ok('六种数据库都列着（PostgreSQL 从人大金仓里分出来单列），一开始都没有驱动', s0 && s0.drivers.length === 6 && s0.drivers.every((d) => !d.ok) && s0.drivers.map((d) => d.name).join() === '达梦,神通,MySQL,Oracle,人大金仓,PostgreSQL', s0);
  H.ok('列出了会找哪个仓库', s0.repos.length === 1 && s0.repos[0].dir === repo && /本机环境里的 Maven 内网/.test(s0.repos[0].from), s0.repos);
  const noHeader = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/kit/drivers/auto', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', () => resolve(0)); r.end('{}'); });
  H.ok('不带页面的请求头改不了', noHeader === 403, noHeader);
  const br = (await call('POST', '/api/kit/browse', { dir: loose, file: true, ext: 'jar' })).json;
  H.ok('选文件的弹窗：只列 jar', br && br.entries.every((e) => e.dir || /\.jar$/.test(e.name)) && br.entries.some((e) => e.name === 'not-a-driver.jar') && !br.entries.some((e) => e.name === 'readme.txt'), br);
  const bad = (await call('POST', '/api/kit/drivers/use', { jar: path.join(loose, 'not-a-driver.jar') })).json;
  H.ok('选了个不是驱动的 jar：说清楚', bad && bad.ok === false && /打不开|没有.*驱动类/.test(bad.msg), bad);
  H.ok('没给路径', (await call('POST', '/api/kit/drivers/use', {})).status >= 400);
  if (HAS) {
    const sc = (await call('POST', '/api/kit/drivers/scan', {})).json;
    H.ok('只找：达梦 1 个、MySQL 2 个（新的在前），不登记', sc && sc.found.dm.length === 1 && sc.found.mysql.length === 2 && sc.found.mysql[0].version === '8.4.0' && sc.found.mysql[1].version === '8.0.33' && !fs.existsSync(path.join(h.kit, 'drivers.json')), sc && sc.found);
    const use = (await call('POST', '/api/kit/drivers/use', { jar: sc.found.mysql[1].jar, dialect: 'mysql' })).json;
    H.ok('自己挑了旧的那个 MySQL 驱动', use.ok && use.status.drivers.find((d) => d.dialect === 'mysql').version === '8.0.33' && use.status.drivers.find((d) => d.dialect === 'mysql').from === 'manual', use);
    const wrong = (await call('POST', '/api/kit/drivers/use', { jar: sc.found.dm[0].jar, dialect: 'oracle' })).json;
    H.ok('驱动和数据库对不上：不登记，说清它是谁的', wrong.ok === false && /这是达梦的驱动，不是Oracle的/.test(wrong.msg), wrong);
    const au = (await call('POST', '/api/kit/drivers/auto', {})).json;
    H.ok('自动：没有驱动的登记上，已经登记的不动', au.used.length === 1 && au.used[0].dialect === 'dm' && au.kept.join() === 'mysql' && au.missing.sort().join() === 'kingbase,oracle,oscar,postgresql' && au.status.drivers.find((d) => d.dialect === 'mysql').version === '8.0.33', au);
    H.ok('jar 多版本都拷进了套件的驱动目录', fs.readdirSync(path.join(h.kit, 'drivers')).sort().join() === 'DmJdbcDriver18-8.1.1.134.jar,mysql-connector-j-8.4.0.jar,mysql-connector-java-8.0.33.jar');
    const rm = (await call('POST', '/api/kit/drivers/remove', { dialect: 'mysql' })).json;
    H.ok('不用了：从登记表里去掉，文件留着', rm.ok && !rm.status.drivers.find((d) => d.dialect === 'mysql').ok && fs.existsSync(path.join(h.kit, 'drivers', 'mysql-connector-java-8.0.33.jar')), rm);
  }
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
    H.ok('导航里有"数据库驱动"', (await page.locator('nav > button').allInnerTexts()).join('|') === '模型|用量|本机环境|数据库驱动|套件开关|经验规则|更新和上报', await page.locator('nav > button').allInnerTexts());
    await page.click('nav button[data-tab="data"]');
    await page.waitForSelector('#drvList tr');
    const secs = (await page.locator('#subnav a').allInnerTexts()).map((s) => s.replace(/^\d+\s*/, '').trim());
    H.ok('这一页的三节（"到 Maven 仓库里找""自己选一个 jar"两节去掉了）', secs.join('|') === '现在用的驱动|查库快一点|用得怎么样', secs);
    H.ok('刷新旁边有"自动搜索"；说了会找哪个仓库', (await page.locator('#sec-drv .row.between button').allInnerTexts()).join('|') === '自动搜索|刷新' && (await page.locator('#drvRepos').innerText()).includes(repo), [await page.locator('#sec-drv .row.between button').allInnerTexts(), await page.locator('#drvRepos').innerText()]);
    H.ok('每一行后面都有换驱动的按钮（没有驱动的那几行叫"选驱动"）', (await page.locator('#drvList button[data-drvpick]').count()) === 6, await page.locator('#drvList').innerText());
    await page.waitForSelector('#tuList tr td.mono');
    H.ok('用量的表和"能优化的地方"', /ttls-db-crud\s+peek\s+22/.test((await page.locator('#tuList').innerText()).replace(/\t/g, ' ')) && /后台执行器/.test(await page.locator('#tuHints').innerText()), [await page.locator('#tuList').innerText(), await page.locator('#tuHints').innerText()]);
    if (HAS) {
      H.ok('一开始：达梦登记着（刚才接口那一步登的），别的没有', /DmJdbcDriver18-8\.1\.1\.134\.jar/.test(await page.locator('#drvList').innerText()) && (await page.locator('#drvList .tag.off').count()) === 5, await page.locator('#drvList').innerText());
      await page.click('#drvAuto');
      await page.waitForSelector('#drvFindMsg:has-text("看了")', { timeout: 60000 });
      H.ok('点"自动搜索"：MySQL 登记上了，用的是最新的；说了还有哪几种没有、怎么办', /登记了 1 个：MySQL/.test(await page.locator('#drvFindMsg').innerText()) && /还是没有驱动的：神通、Oracle、人大金仓、PostgreSQL，点那一行的"选驱动"自己选 jar/.test(await page.locator('#drvFindMsg').innerText()) && /mysql-connector-j-8\.4\.0\.jar/.test(await page.locator('#drvList').innerText()) && /自动搜索找到的/.test(await page.locator('#drvList').innerText()), [await page.locator('#drvFindMsg').innerText(), await page.locator('#drvList').innerText()]);
      H.ok('自动搜索的按钮恢复了', (await page.locator('#drvAuto').innerText()) === '自动搜索' && !(await page.locator('#drvAuto').isDisabled()));
      await shot('5-drivers');
      // 换驱动：点 MySQL 那一行的"换驱动"，弹窗从现在那个 jar 所在的目录开始；把旧版本所在的目录粘进去，点那个 jar
      await page.locator('#drvList button[data-drvpick="mysql"]').click();
      await page.waitForSelector('#pkList .pk');
      H.ok('弹窗：标题写着是哪种数据库的，从现在登记的 jar 所在的目录开始', (await page.locator('#pkTitle').innerText()) === '选 MySQL 的驱动 jar' && (await page.locator('#pkPath').innerText()).toLowerCase() === path.join(h.kit, 'drivers').toLowerCase() && /mysql-connector-j-8\.4\.0\.jar/.test(await page.locator('#pkList').innerText()), [await page.locator('#pkTitle').innerText(), await page.locator('#pkPath').innerText()]);
      await page.fill('#pkJump', path.join(repo, 'mysql', 'mysql-connector-java', '8.0.33'));
      await page.press('#pkJump', 'Enter');
      await page.waitForSelector('#pkList .pk:has-text("mysql-connector-java-8.0.33.jar")');
      await page.locator('#pkList .pk', { hasText: 'mysql-connector-java-8.0.33.jar' }).click();
      await page.waitForSelector('#drvMsg.ok');
      H.ok('换成了旧的那个：列表里是它，来源是"自己选的"', /mysql-connector-java-8\.0\.33\.jar/.test(await page.locator('#drvList').innerText()) && /自己选的/.test(await page.locator('#drvList').innerText()) && /MySQL的驱动登记好了/.test(await page.locator('#drvMsg').innerText()), [await page.locator('#drvList').innerText(), await page.locator('#drvMsg').innerText()]);
      // 没有驱动的那一行：点"选驱动"，弹窗从上一次选的目录开始；粘贴放着金仓 jar 的目录
      await page.locator('#drvList button[data-drvpick="kingbase"]').click();
      await page.waitForSelector('#pkList .pk');
      H.ok('没有驱动的那一行：弹窗从上一次选的目录开始', (await page.locator('#pkTitle').innerText()) === '选 人大金仓 的驱动 jar' && (await page.locator('#pkPath').innerText()).toLowerCase() === path.join(repo, 'mysql', 'mysql-connector-java', '8.0.33').toLowerCase(), [await page.locator('#pkTitle').innerText(), await page.locator('#pkPath').innerText()]);
      await page.fill('#pkJump', loose);
      await page.click('#pkJumpGo');
      await page.waitForSelector('#pkList .pk:has-text("kingbase8-8.6.0.jar")');
      H.ok('弹窗里只列 jar', !/readme\.txt/.test(await page.locator('#pkList').innerText()) && /not-a-driver\.jar/.test(await page.locator('#pkList').innerText()), await page.locator('#pkList').innerText());
      await page.locator('#pkList .pk', { hasText: 'kingbase8-8.6.0.jar' }).click();
      await page.waitForSelector('#drvMsg:has-text("人大金仓的驱动登记好了")');
      H.ok('金仓的驱动登记上了', /kingbase8-8\.6\.0\.jar/.test(await page.locator('#drvList').innerText()) && (await page.locator('#drvList .tag.off').count()) === 3);
      // 选错了：给 Oracle 那一行选了金仓的 jar（直接把 jar 的路径粘进去）
      await page.locator('#drvList button[data-drvpick="oracle"]').click();
      await page.waitForSelector('#pkList .pk');
      await page.fill('#pkJump', '"' + path.join(loose, 'kingbase8-8.6.0.jar') + '"');
      await page.press('#pkJump', 'Enter');
      await page.waitForSelector('#drvMsg.bad');
      H.ok('驱动和数据库对不上：不登记，说清它是谁的', /这是人大金仓的驱动，不是Oracle的/.test(await page.locator('#drvMsg').innerText()) && (await page.locator('#drvList .tag.off').count()) === 3 && !(await page.locator('#picker').evaluate((d) => d.open)), await page.locator('#drvMsg').innerText());
      await page.locator('#drvList button[data-drvpick="oracle"]').click();
      await page.waitForSelector('#pkList .pk');
      await page.fill('#pkJump', path.join(loose, 'not-a-driver.jar'));
      await page.press('#pkJump', 'Enter');
      await page.waitForSelector('#drvMsg.bad:has-text("not-a-driver")');
      H.ok('不是驱动的 jar：页面上说清楚', /打不开|没有.*驱动类/.test(await page.locator('#drvMsg').innerText()), await page.locator('#drvMsg').innerText());
      await page.locator('#drvList button[data-drvrm="kingbase"]:not([data-rmjar])').click();
      await page.waitForSelector('#drvMsg:has-text("去掉了")');
      H.ok('不用了：那一行变回"还没有驱动"，说了要用的时候点哪里', (await page.locator('#drvList .tag.off').count()) === 4 && /你去掉过：后台不会自动登记它，要用的时候点"自动搜索"，或者点右边的"选驱动"/.test(await page.locator('#drvList').innerText()), await page.locator('#drvList').innerText());
    }
    // 后台执行器的开关：走底部的保存条
    await page.locator('#k_dbcrudDaemon').setChecked(true, { force: true });
    await page.waitForSelector('#savebar.on');
    H.ok('改了后台执行器：保存条冒出来', /查库的后台执行器/.test(await page.locator('#barWhat').innerText()), await page.locator('#barWhat').innerText());
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('存下了', (await call('GET', '/api/kit')).json.config.dbcrudDaemon === true);
    await shot('6-data-full');
    await page.click('nav button[data-tab="kit"]');
    await page.waitForFunction(() => document.getElementById('k_handoverPercent').value !== '');
    const ksecs = (await page.locator('#subnav a').allInnerTexts()).map((s) => s.replace(/^\d+\s*/, '').trim());
    H.ok('套件开关页有"自动探索"一节；"提示规则""清点技能"两节去掉了', ksecs.join('|') === '上下文和交接|状态栏|自动探索|全局：过程文件|全局：审查与产物|需求自动模式|Apply 自动模式|拉代码和提交|保护', ksecs);
    H.ok('自动探索、审查问题自动收（在经验规则那一页）：默认开着', (await page.locator('#k_autoOnboard').isChecked()) && (await page.locator('#tab-lessons #k_lessonAuto').isChecked()));
    const opts = await page.locator('#tab-kit .opt, #tab-data .opt, #tab-lessons .opt, #tab-remote .opt').evaluateAll((els) => els.map((e) => ({ t: (e.querySelector('.t') || {}).textContent || '', d: (e.querySelector(':scope > div > .d') || {}).textContent || '' })));
    H.ok('新加的开关也是一句话说明，不超过 90 个字', opts.every((o) => o.t.trim() && o.d.trim() && o.d.trim().length <= 90), opts.filter((o) => o.d.trim().length > 90).map((o) => o.t + ' ' + o.d.trim().length));
    await page.locator('#k_autoOnboard').setChecked(false, { force: true });
    await page.waitForSelector('#savebar.on');
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('关掉自动探索：存下了', (await call('GET', '/api/kit')).json.config.autoOnboard === false);
    await page.locator('#sec-onboard').scrollIntoViewIfNeeded();
    await shot('7-kit-onboard', true);
    H.ok('页面上没有报错', errors.length === 0, errors);
  }
  await stopAll();
  await H.sleep(500);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('配置页：数据库驱动');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
