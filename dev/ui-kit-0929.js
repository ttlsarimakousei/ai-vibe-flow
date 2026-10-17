'use strict';
/*
 * 配置页重排之后（0929）：用无头浏览器真的打开页面点一遍。
 *   页面打得开、没有报错；左边的导航、当前页各节的目录；开关一项一行，细节折着
 *   改了开关 → 底部冒出保存条 → 保存（只存改过的）→ 保存条收起；放弃 → 恢复原样
 *   问题反馈里只列套件的问题，另有放行记录、拦得最多的规矩；保护那一节有最近的开关改动
 *   2026-10-01：经验规则单开一页；问题列表挪到"更新和上报"（每条标上报了没有，没有导出、清空）；多了状态栏、自动压缩线、开工前拉代码
 * 在假的用户目录里起一个临时路由（换一个端口）。第二个参数给目录就把截图存进去。
 * 用法：node dev/ui-kit-0929.js [端口，默认 18791] [截图目录]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18791;
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : '';
const h = H.makeHome('uikit');
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
fs.writeFileSync(path.join(h.cfg, 'settings.json'), '{}\n');
fs.writeFileSync(path.join(h.kit, 'VERSION'), '20260929.0000\n');
const F = require(path.join(h.kit, 'lib', 'feedback.js'));
// 几条记录：一条真的问题、两条不算问题的（老版本留下的）、一条放行、几次拦截、一次开关改动
F.record({ kind: '误拦', hook: 'guard-spec', source: '模型反馈', title: '验法跑过了打勾还是被拦', what: 'x', why: 'y', sig: 'ui-real' });
F.record({ kind: '卡住', hook: 'guard-spec', source: '钩子自动记录', title: '同一个会话里被"x"拿同一条理由拦了 3 次', what: '旧记录', sig: 'ui-stuck' });
F.record({ kind: '开关变更', hook: '配置页', source: '钩子自动记录', title: '配置页打开了Apply 自动模式', what: '旧记录', sig: '' });
fs.writeFileSync(path.join(h.kit, 'state', 'bypass.json'), JSON.stringify({ passes: [{ id: 'AB12', hook: 'guard-spec', sig: 's', target: 'file:x', sid: 's1', fid: '', why: '对照场景要先改库，留给用户；javac 已通过', auto: true, multi: true, at: Date.now() - 60000, expires: Date.now() + 1000000, used: true, uses: 2, action: 'Edit：D:/p/openspec/changes/a/tasks.md' }] }));
fs.writeFileSync(path.join(h.kit, 'state', 'block-stats.json'), JSON.stringify({ 'guard-spec|abc': { hook: 'guard-spec', rule: 'r', count: 7, sessions: ['a', 'b'], at: Date.now() - 5000, example: '[vibe-kit 提案检查] tasks.md（变更 x）现在还不能改：' } }));

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
  const watch = await H.watchWindows('uikit-win');
  const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  router.stdout.on('data', (d) => { log += d; });
  router.stderr.on('data', (d) => { log += d; });
  let browser = null;
  const stopAll = async () => { try { if (browser) await browser.close(); } catch (e) { /* 已经关了 */ } try { router.kill(); } catch (e) { /* 已经退了 */ } };
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await H.sleep(250); up = (await call('GET', '/ui')).status === 200; }
  H.ok('临时路由起来了，配置页打得开', up, log);
  if (!up) { await stopAll(); return H.done('配置页 0929'); }

  H.section('接口');
  // 配置页上改放松保护的开关：记在开关改动里，不记成问题
  const n0 = fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /^F\d{8}/.test(n)).length;
  const sv = await call('POST', '/api/kit/config', { kitBypass: 'auto' });
  H.ok('保存开关', sv.status === 200 && sv.json.config.kitBypass === 'auto', sv.text);
  H.ok('改开关不再记成问题', fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /^F\d{8}/.test(n)).length === n0);
  await call('POST', '/api/kit/config', { autoApply: true });
  const seal = JSON.parse(fs.readFileSync(path.join(h.kit, 'state', 'config-seal.json'), 'utf8'));
  H.ok('封条里记了Apply 自动模式', seal.autoApply === true && seal.kitBypass === 'auto', seal);
  const fb = (await call('GET', '/api/kit/feedback')).json;
  H.ok('问题列表里只有套件的问题', fb && fb.records.length === 1 && /验法跑过了/.test(fb.records[0].title), fb && fb.records);
  H.ok('每条标着上报了没有（上报关着）；不再给清空用的全部记录', fb.records[0].upload === 'off' && fb.all === undefined, fb.records);
  H.ok('带上了放行记录、拦得最多的规矩、开关改动', fb.passes.length === 1 && fb.passes[0].uses === 2 && fb.stats.length === 1 && fb.stats[0].count === 7 && fb.stats[0].sessions === 2 && fb.audit.length === 2 && /Apply 自动模式/.test(fb.audit[0].title), fb);
  await call('POST', '/api/kit/config', { autoApply: false, kitBypass: 'ask' });

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
    // 页面自己发的请求不该有失败的（填错了故意让它报错的那一次除外）
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/api/kit/config')) errors.push(r.status() + ' ' + r.url()); });
  } catch (e) { console.log('  这台电脑上起不来浏览器，页面那部分没法测：' + String((e && e.message) || e).split('\n')[0]); }
  if (page) {
    const shot = async (name, view) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !view }); } };
    await page.goto('http://127.0.0.1:' + PORT + '/ui');
    await page.waitForSelector('#meta:has-text("今天")');
    H.ok('页头：路由的版本、地址，绿灯亮着', (await page.locator('#lamp').getAttribute('class')) === 'on' && /127\.0\.0\.1:/.test(await page.locator('#meta').innerText()));
    H.ok('页头显示套件的版本', /套件 20260929\.0000/.test(await page.locator('#kitVer').innerText()));
    H.ok('模型页：各节列在导航下面', (await page.locator('#subnav a').allInnerTexts()).join('|').replace(/\s+/g, '') === '01接上ClaudeCode|02模型|03角色分配|04换模型的规矩|05配置备份', await page.locator('#subnav a').allInnerTexts());
    await shot('1-models');
    await page.click('nav button[data-tab="kit"]');
    await page.waitForFunction(() => document.getElementById('k_handoverPercent').value !== '');
    const secs = (await page.locator('#subnav a').allInnerTexts()).map((s) => s.replace(/^\d+\s*/, '').trim());
    H.ok('套件开关页：九节（经验规则单开一页，问题反馈挪到了"更新和上报"；2026-10-17 起拉代码去掉了，只剩提交）', secs.join('|') === '上下文和交接|状态栏|自动探索|全局：过程文件|全局：审查与产物|需求自动模式|Apply 自动模式|提交|保护', secs);
    H.ok('新的几项：自动压缩线、状态栏的用量、提交方式（默认询问，没有开工前拉代码）', (await page.inputValue('#k_autoCompactPercent')) === '90' && (await page.locator('#k_statusUsage').isChecked()) && (await page.inputValue('#k_commitMode')) === 'ask' && (await page.locator('#k_pullBeforeWork').count()) === 0 && /用到 900k 时 Claude Code 自己压缩（开着的会话敲 \/autocompact 933000 马上生效）/.test(await page.locator('#ctxPreview').innerText()), await page.locator('#ctxPreview').innerText());
    H.ok('页面上没有提示规则、清点技能的东西了', (await page.locator('#sec-hints, #sec-skills, #hints, #skillsReport, #addHint, #checkSkills').count()) === 0);
    H.ok('保存条一开始不出来', !(await page.locator('#savebar').getAttribute('class')).includes(' on'));
    // 每一项开关：一个名字、一句话
    const opts = await page.locator('#tab-kit .opt').evaluateAll((els) => els.map((e) => ({ t: (e.querySelector('.t') || {}).textContent || '', d: (e.querySelector(':scope > div > .d') || {}).textContent || '', ctl: !!e.querySelector('.ctl input, .ctl select') })));
    H.ok('每一项都有名字、一句话说明和控件', opts.length >= 25 && opts.every((o) => o.t.trim() && o.d.trim() && o.ctl), opts.filter((o) => !(o.t.trim() && o.d.trim() && o.ctl)));
    const longest = opts.reduce((a, o) => Math.max(a, o.d.trim().length), 0);
    H.ok('一句话说明都不超过 90 个字（以前最长的六百多字）', longest <= 90, opts.filter((o) => o.d.trim().length > 90).map((o) => o.t + ' ' + o.d.trim().length));
    H.ok('细节默认折着', (await page.locator('#tab-kit details.more[open]').count()) === 0 && (await page.locator('#tab-kit details.more').count()) >= 12);
    await page.locator('#sec-auto details.more summary').first().click();
    const autoMore = await page.locator('#sec-auto details.more').first().innerText();
    H.ok('自测细节说明无法执行时如实报告', !/1\.x/.test(autoMore) && /验不了/.test(autoMore), autoMore);
    H.ok('两阶段各有独立开关和上限', (await page.locator('#k_autoRequirements, #k_requirementsReviewMaxRounds, #k_autoApply, #k_applyReviewMaxRounds').count()) === 4);
    await shot('2-kit');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('2b-kit-view', true);
    // 改两个开关：保存条冒出来，写着改了哪两项
    const before = (await call('GET', '/api/kit')).json.config;
    await page.locator('#k_autoApply').setChecked(true, { force: true });
    await page.fill('#k_applyReviewMaxRounds', '4');
    await page.waitForSelector('#savebar.on');
    const what = await page.locator('#barWhat').innerText();
    H.ok('改了两项：保存条冒出来，写着是哪两项', /^2 项改动还没保存/.test(what) && /Apply 自动模式/.test(what) && /Apply 每组审查上限/.test(what), what);
    await shot('3-savebar');
    await page.locator('#sec-auto').scrollIntoViewIfNeeded();
    await shot('3b-savebar-view', true);
    await page.click('#barDrop');
    await page.waitForFunction(() => !document.getElementById('savebar').className.includes(' on'));
    H.ok('放弃：两项都恢复原样', (await page.locator('#k_autoApply').isChecked()) === !!before.autoApply && (await page.inputValue('#k_applyReviewMaxRounds')) === String(before.applyReviewMaxRounds));
    await page.locator('#k_autoApply').setChecked(true, { force: true });
    await page.waitForSelector('#savebar.on');
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    const after = (await call('GET', '/api/kit')).json.config;
    H.ok('保存：Apply 自动模式存下了，别的开关没动', after.autoApply === true && Object.keys(before).filter((k) => !['autoApply', 'autoMode'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])).length === 0, [before, after]);
    H.ok('保存条说存了哪一项', /已保存，立即生效：Apply 自动模式/.test(await page.locator('#barMsg').innerText()), await page.locator('#barMsg').innerText());
    // 填错了不保存
    await page.fill('#k_applyReviewMaxRounds', '21');
    await page.waitForSelector('#barSave:not(.hide)');
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.bad');
    H.ok('填错了：说清哪一项、什么都没存', /Apply 每组审查上限：要在 1 到 20 之间/.test(await page.locator('#barMsg').innerText()) && (await call('GET', '/api/kit')).json.config.applyReviewMaxRounds === before.applyReviewMaxRounds, await page.locator('#barMsg').innerText());
    await page.click('#barDrop');
    // 上下文那一节 2026-10-17 起不自动保存（用户定的）：改完出保存条，点了保存才存
    await page.fill('#k_handoverPercent', '65');
    await page.locator('#k_handoverPercent').blur();
    await page.waitForSelector('#savebar.on');
    await page.waitForTimeout(800);
    H.ok('交接线改完不自动保存，等点保存', (await call('GET', '/api/kit')).json.config.handoverPercent !== 65);
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('点了保存：交接线存下了', (await call('GET', '/api/kit')).json.config.handoverPercent === 65);
    // 自动压缩线：预览马上跟着变，保存了说开着的会话怎么马上生效
    await page.fill('#k_autoCompactPercent', '80');
    await page.locator('#k_autoCompactPercent').blur();
    H.ok('预览跟着算：到多少压缩、开着的会话敲哪条命令', /用到 800k 时 Claude Code 自己压缩（开着的会话敲 \/autocompact 833000 马上生效）/.test(await page.locator('#ctxPreview').innerText()), await page.locator('#ctxPreview').innerText());
    await page.waitForSelector('#savebar.on');
    await page.click('#barSave');
    await page.waitForFunction(() => /\/autocompact/.test(document.getElementById('barMsg').textContent));
    H.ok('自动压缩线保存了，说了开着的会话怎么马上生效', (await call('GET', '/api/kit')).json.config.autoCompactPercent === 80 && /\/autocompact/.test(await page.locator('#barMsg').innerText()), await page.locator('#barMsg').innerText());
    // 保护那一节：最近的开关改动
    const audit = await page.locator('#auditList').innerText();
    H.ok('保护那一节列着最近的开关改动', /打开了Apply 自动模式/.test(audit) && /让它自己放行/.test(audit), audit);
    await shot('4-kit-bottom');
    // 经验规则单开一页
    await page.click('nav button[data-tab="lessons"]');
    await page.waitForSelector('#tab-lessons:not(.hide) #sec-lessons');
    H.ok('经验规则单开一页：开关和规则都在这一页', (await page.locator('#tab-lessons #k_lessons').count()) === 1 && (await page.locator('#tab-kit #k_lessons, #tab-kit #sec-lessons').count()) === 0 && (await page.locator('#tab-lessons .opt').count()) === 7);
    await page.fill('#k_lessonThreshold', '3');
    await page.waitForSelector('#savebar.on');
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('经验规则那一页的开关也走保存条', (await call('GET', '/api/kit')).json.config.lessonThreshold === 3);
    await shot('4b-lessons');
    // 更新和上报：问题列表挪到了这里
    await page.click('nav button[data-tab="remote"]');
    await page.waitForFunction(() => document.getElementById('k_updateCheckHours').value !== '' && /验法跑过了/.test(document.getElementById('fbList').innerText));
    H.ok('问题列表在"更新和上报"这一页：只有一条，标着上报关着', (await page.locator('#tab-remote #fbList tr').count()) === 1 && /问题上报关着/.test(await page.locator('#fbList').innerText()), await page.locator('#fbList').innerText());
    H.ok('没有导出汇总、清空的按钮，也没有"维护套件的电脑"那一栏', (await page.locator('#fbExport, #fbClear, #k_maintainerHosts').count()) === 0);
    H.ok('放行记录、拦得最多的规矩折着，标了条数', /1 条/.test(await page.locator('#fbPassCount').innerText()) && /1 条/.test(await page.locator('#fbStatCount').innerText()));
    await page.locator('#sec-issues details.plain summary').first().click();
    H.ok('放行记录里有理由和用了几次', /对照场景要先改库/.test(await page.locator('#fbPasses').innerText()) && /2/.test(await page.locator('#fbPasses td.num').first().innerText()));
    H.ok('使用情况上报那一节：开关、看看要传的内容', (await page.locator('#sec-usage-report #k_usageReport').count()) === 1 && (await page.inputValue('#k_usageReport')) === 'on' && (await page.locator('#usPreview').count()) === 1);
    await page.click('#usPreview');
    await page.waitForSelector('#usPreviewOut pre');
    H.ok('点"看看要传的内容"：今天的样子，不带路径', /的使用情况/.test(await page.locator('#usPreviewOut pre').innerText()) && !(await page.locator('#usPreviewOut pre').innerText()).includes(h.root), await page.locator('#usPreviewOut').innerText());
    // 更新和上报那一页的开关也走保存条
    await page.fill('#k_updateCheckHours', '6');
    await page.waitForSelector('#savebar.on');
    await page.click('#barSave');
    await page.waitForSelector('#barMsg.ok');
    H.ok('更新和上报页的开关：保存条存下了', (await call('GET', '/api/kit')).json.config.updateCheckHours === 6);
    await shot('5-remote');
    await page.click('nav button[data-tab="local"]');
    await shot('6-local');
    await page.click('nav button[data-tab="usage"]');
    await shot('7-usage');
    // 窄屏：导航挪到上面，页面不横向滚
    await page.setViewportSize({ width: 760, height: 900 });
    await page.click('nav button[data-tab="kit"]');
    await page.waitForTimeout(200);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    H.ok('窄屏不横向滚动', wide <= 1, wide);
    await shot('8-narrow');
    // 深色
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(100);
    await shot('9-dark');
    H.ok('整个过程页面没有报错', errors.length === 0, errors);
  }
  await call('POST', '/api/kit/config', { autoApply: false });
  await stopAll();
  await H.sleep(600);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('配置页 0929');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
