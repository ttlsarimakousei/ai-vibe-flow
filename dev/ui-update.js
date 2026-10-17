'use strict';
/*
 * 配置页"更新和上报"那一页的接口，加上"保存开关"的新规矩（只存改过的项）。
 * 在假的用户目录里用真的安装器装一份（带路由，端口换掉），假 GitLab 当仓库。走一遍：
 *   填仓库地址和令牌 → 测试连接 → 立即检查 → 立即更新（安装器会把路由重启）→ 上报 → 导出（交给页面下载）→ 关掉这一批 → 使用情况
 * 维护套件的电脑 2026-10-01 起写死在代码里：测导出时用环境变量 VIBE_KIT_MAINTAINER_HOSTS 把路由装成那台电脑
 * 第二个参数给秒数就留着让人（或浏览器工具）看页面。看完在临时目录里建一个叫 stop 的文件，或者等到时间。
 * 用法：node dev/ui-update.js [路由端口，默认 18745] [留多少秒，默认 0] [假 GitLab 的端口，默认 18746]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18745;
const STAY = Number(process.argv[3]) || 0;
const GL_PORT = Number(process.argv[4]) || 18746;
const A = '20260915.0900';
const B = '20260916.0900';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };

const call = (method, url, body, noHeader) => new Promise((resolve) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const headers = Object.assign({ 'content-type': 'application/json' }, noHeader ? {} : { 'x-vibe-router': '1' }, data ? { 'content-length': data.length } : {});
  const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers, agent: false, timeout: 700000 }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', (e) => resolve({ status: 0, json: null, text: String(e) }));
  if (data) req.write(data);
  req.end();
});

(async () => {
  const watch = await H.watchWindows('uiu-win');
  const gl = await H.fakeGitlab('uiu-gl', GL_PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  const live = Object.assign({}, gl.env, { VIBE_KIT_NO_UPDATE: undefined });

  // 维护的人：发布 A、B 两版（令牌）
  const MT = 'glpat-maintainer-token-02';
  gl.addToken(MT, 'maintainer');
  const m = H.freshHome('uiu-m');
  fs.mkdirSync(m.kit, { recursive: true });
  fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  const pkgA = H.makePackage('uiu-a', A);
  const pkgB = H.makePackage('uiu-b', B);
  const pubA = H.node(m, path.join(pkgA, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkgA, timeout: 600000, env: { VIBE_KIT_NO_UPDATE: undefined } });
  H.ok('（维护的人发布了 A）', pubA.code === 0, pubA.out + pubA.err);

  // 同事的电脑：装 A，带路由（端口换成测试用的）
  const h = H.freshHome('uiu-u');
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
  const inst = H.node(h, path.join(pkgA, 'install.js'), ['--no-open'], { cwd: h.root, timeout: 300000, env: Object.assign({}, live, { VIBE_KIT_NO_UPDATE: '1' }) });
  H.ok('同事的电脑装上了 A，路由在测试端口上跑着', inst.code === 0 && /模型路由 v.*已在后台运行/.test(inst.out) && new RegExp(':' + PORT + '/ui').test(inst.out), inst.out + inst.err);
  H.ok('登录后自动启动写进了假的"启动"文件夹', fs.existsSync(path.join(h.home, 'Startup', 'vibe-kit-router.vbs')), inst.out);
  const svc = path.join(h.kit, 'router', 'service.js');
  const stopRouter = () => H.node(h, svc, ['stop'], { cwd: h.root, timeout: 60000 });
  // 路由是安装器甩出去的，环境变量里没有假 ssh：停掉，带着假 ssh 的环境重新起（真实的电脑上路由继承的就是用户的环境）
  stopRouter();
  const restart = H.node(h, svc, ['start'], { cwd: h.root, timeout: 60000, env: Object.assign({}, live) });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await H.sleep(250); up = (await call('GET', '/ui')).status === 200; }
  H.ok('配置页打得开', up, restart.out + restart.err);
  for (const t of ['第一条', '第二条']) H.node(h, '-e', ['require(' + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '出错', hook: 'verify-gate', title: '同事电脑上记的' + t, what: 'x', sig: 'sig-ui-' + t }) + ')'], { cwd: h.root });

  if (up) {
    H.section('页面和开关');
    const page = await call('GET', '/ui');
    H.ok('页面上有"更新和上报"这一页', /data-tab="remote"/.test(page.text) && /id="tab-remote"/.test(page.text) && /id="r_token"/.test(page.text) && /id="riExport"/.test(page.text));
    H.ok('页面上没有"维护套件的电脑"那一栏，也看不到那台电脑的地址', !/k_maintainerHosts|维护套件的电脑<\/div>/.test(page.text) && !/32\.1\.4\.4/.test(page.text));
    const remoteTab = page.text.slice(page.text.indexOf('id="tab-remote"'));
    H.ok('问题列表、使用情况在"更新和上报"这一页；经验规则单开一页', /id="fbList"/.test(remoteTab) && /id="sec-usage-report"/.test(remoteTab) && /data-tab="lessons"/.test(page.text) && /id="tab-lessons"[\s\S]*id="sec-lessons"/.test(page.text) && !/id="sec-feedback"/.test(page.text));
    const kitInfo = await call('GET', '/api/kit');
    const c0 = kitInfo.json && kitInfo.json.config;
    H.ok('开关里有新的几项，没有"维护套件的电脑"', c0 && c0.autoUpdate === 'auto' && c0.updateCheckHours === 2 && c0.issueUpload === 'on' && c0.sshToken === 'auto' && c0.maintainerHosts === undefined && c0.autoCompactPercent === 70 && c0.statusUsage === true && c0.commitMode === 'off' && c0.pullBeforeWork === undefined && c0.autoCommit === undefined && c0.usageReport === 'on', c0);
    const busy = await call('GET', '/busy');
    H.ok('路由答得出"现在忙不忙"', busy.status === 200 && busy.json && busy.json.inflight === 0 && busy.json.idleMs >= 0, busy.text);

    H.section('保存开关：只存改过的项');
    // 页面甲把审查轮数改成 4；页面乙（打开得早，还显示 3）只改了提交方式（2026-10-17 起是 commitMode）——只传改过的那一项，轮数不会被带回 3
    const s1 = await call('POST', '/api/kit/config', { reviewMaxRounds: 4 });
    const s2 = await call('POST', '/api/kit/config', { commitMode: 'off' });
    H.ok('别的页面只改了别的项：审查轮数不变', s1.json.config.reviewMaxRounds === 4 && s2.json.config.reviewMaxRounds === 4 && s2.json.config.commitMode === 'off' && readJson(path.join(h.kit, 'config.json')).reviewMaxRounds === 4, s2.text);
    const s3 = await call('POST', '/api/kit/config', { reviewMaxRounds: 9, updateCheckHours: 99, autoUpdate: 'sometimes', issueUpload: 'maybe', maintainerHosts: ['10.9.8.7'], autoCompactPercent: 30, usageReport: 'maybe', commitMode: 'sometimes' });
    H.ok('乱填的不收，保持原值；"维护套件的电脑"传了也不存', s3.json.config.reviewMaxRounds === 4 && s3.json.config.updateCheckHours === 2 && s3.json.config.autoUpdate === 'auto' && s3.json.config.issueUpload === 'on' && s3.json.config.maintainerHosts === undefined && s3.json.config.autoCompactPercent === 70 && s3.json.config.usageReport === 'on' && s3.json.config.commitMode === 'off' && !/maintainerHosts/.test(H.read(path.join(h.kit, 'config.json'))), s3.text);
    const s4 = await call('POST', '/api/kit/config', { autoUpdate: 'notify', updateCheckHours: 6, sshToken: 'off', autoCompactPercent: 80, usageReport: 'off', commitMode: 'auto', statusUsage: false });
    H.ok('新的几项存得进去', s4.json.config.autoUpdate === 'notify' && s4.json.config.updateCheckHours === 6 && s4.json.config.sshToken === 'off' && s4.json.config.autoCompactPercent === 80 && s4.json.config.usageReport === 'off' && s4.json.config.commitMode === 'auto' && s4.json.config.statusUsage === false, s4.text);
    H.ok('自动压缩线改了：settings.json 的窗口跟着改', readJson(path.join(h.cfg, 'settings.json')).autoCompactWindow === 833000 && s4.json.synced !== false, [readJson(path.join(h.cfg, 'settings.json')).autoCompactWindow, s4.json.output]);
    const s5 = await call('POST', '/api/kit/config', { autoCompactPercent: 0 });
    H.ok('填 0：窗口去掉，照 Claude Code 自己的', s5.json.config.autoCompactPercent === 0 && readJson(path.join(h.cfg, 'settings.json')).autoCompactWindow === undefined, s5.text);
    await call('POST', '/api/kit/config', { sshToken: 'auto', commitMode: 'ask', reviewMaxRounds: 3, autoCompactPercent: 90, usageReport: 'on', statusUsage: true });

    H.section('仓库地址和令牌');
    let d = (await call('GET', '/api/kit/remote')).json;
    H.ok('没填过：默认的仓库地址，没有令牌', d && d.settings && d.settings.isDefault && /scm\.skytech\.io/.test(d.settings.repo) && !d.settings.tokenSet && d.version === A && d.update.installed === A, d);
    H.ok('这台电脑不是维护套件的那台', d.maintainer === false);
    const bad = await call('POST', '/api/kit/remote/settings', { repo: 'ftp://nowhere/x/y' });
    H.ok('乱写的仓库地址：报错，不存', bad.status >= 400 && /http/.test(bad.json.error) && !fs.existsSync(path.join(h.kit, 'gitlab.json')), bad.text);
    const UT = 'glpat-user-token-0000000001';
    gl.addToken(UT, 'xiaowang');
    const sv = await call('POST', '/api/kit/remote/settings', { repo: gl.url, sshRepo: '', branch: '', token: UT, verifyCert: false });
    H.ok('保存：回来的东西里没有完整的令牌', sv.status === 200 && !sv.text.includes(UT) && sv.json.settings.tokenSet && sv.json.settings.tokenSource === 'manual' && sv.json.settings.repo === gl.url && !sv.json.settings.isDefault, sv.text);
    H.ok('令牌存在 secrets.json 里', readJson(path.join(h.kit, 'secrets.json')).gitlabToken === UT && !H.read(path.join(h.kit, 'gitlab.json')).includes(UT));
    const again = (await call('GET', '/api/kit/remote'));
    H.ok('再读：还是只给遮过的', !again.text.includes(UT) && /^glpat-…/.test(again.json.settings.tokenMasked.slice(0, 7)), again.json.settings);
    const keep = await call('POST', '/api/kit/remote/settings', { branch: 'main' });
    H.ok('没传令牌那一项：原来的令牌不动', keep.json.settings.tokenSet && keep.json.settings.branch === 'main' && readJson(path.join(h.kit, 'secrets.json')).gitlabToken === UT, keep.text);
    const nh = await call('POST', '/api/kit/remote/settings', { token: '' }, true);
    H.ok('不带页面的请求头：改不了', nh.status === 403 && readJson(path.join(h.kit, 'secrets.json')).gitlabToken === UT, nh.text);

    H.section('测试连接、检查、更新');
    const t = await call('POST', '/api/kit/remote/test', {});
    const tt = t.json && t.json.test;
    H.ok('测试连接：拉仓库通（令牌），SSH 通，接口通', tt && tt.hasGit && tt.git.ok && tt.git.route === 'token' && tt.ssh.ok && tt.ssh.user === 'tester' && tt.api.ok && tt.api.levelName === 'Reporter' && !t.text.includes(UT), t.text);
    const pubB = H.node(m, path.join(pkgB, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkgB, timeout: 600000, env: { VIBE_KIT_NO_UPDATE: undefined } });
    H.ok('（维护的人发布了 B）', pubB.code === 0, pubB.out + pubB.err);
    const ck = await call('POST', '/api/kit/remote/check', {});
    H.ok('立即检查：仓库里是 B，这台电脑装着 A', ck.status === 200 && ck.json.update.remote === B && ck.json.update.installed === A && ck.json.update.differs && ck.json.update.lastCheckOk && ck.json.update.routeLabel === '令牌', ck.text);
    const st1 = await call('GET', '/api/kit/remote/status');
    H.ok('问进度的接口不带问题反馈那一块', st1.json && st1.json.update && st1.json.issues === undefined, st1.text);
    const ap = await call('POST', '/api/kit/remote/apply', {});
    H.ok('立即更新：在后台开始了', ap.status === 200 && ap.json.started === true, ap.text);
    // 安装器会把路由停掉换新的：页面这时连不上是正常的，隔一会儿再问
    let done = false;
    let last = null;
    for (let i = 0; i < 240 && !done; i++) { await H.sleep(1000); last = await call('GET', '/api/kit/remote/status'); done = !!(last.json && last.json.version === B && !last.json.update.running); }
    H.ok('装上了 B，路由换成了新的，页面又连得上', done && (H.read(path.join(h.kit, 'VERSION')) || '').trim() === B, last && last.text);
    H.ok('更新之后：仓库地址、令牌、开关都还在', readJson(path.join(h.kit, 'gitlab.json')).repo === gl.url && readJson(path.join(h.kit, 'secrets.json')).gitlabToken === UT && readJson(path.join(h.kit, 'config.json')).autoUpdate === 'notify');
    const ap2 = await call('POST', '/api/kit/remote/apply', {});
    await H.sleep(1500);
    for (let i = 0; i < 60; i++) { const x = await call('GET', '/api/kit/remote/status'); if (x.json && !x.json.update.running) break; await H.sleep(1000); }
    H.ok('已经是最新的再点更新：不重装', ap2.status === 200 && (readJson(path.join(h.kit, 'state', 'update.json')).history || []).length === 1, ap2.text);

    H.section('上报、导出');
    const sy = await call('POST', '/api/kit/remote/issues/sync', {});
    H.ok('立即上报：两条都建成了 issue，署名是填令牌的那个人', sy.status === 200 && sy.json.sync.created === 2 && sy.json.issues.uploaded === 2 && gl.issues().length === 2 && gl.issues()[0].author.username === 'xiaowang', sy.text);
    const fl = await call('GET', '/api/kit/feedback');
    H.ok('问题列表：每条标着上报成了哪一条议题', fl.status === 200 && fl.json.records.length === 2 && fl.json.records.every((r) => r.upload && r.upload.iid > 0 && /\/-\/issues\/\d+$/.test(r.upload.url)) && fl.json.all === undefined, fl.text.slice(0, 800));
    const gone1 = await call('GET', '/api/kit/feedback/export');
    const gone2 = await call('POST', '/api/kit/feedback/clear', { items: [] });
    H.ok('本机的导出汇总、清空都没有了', gone1.status >= 400 && gone2.status >= 400, [gone1.text, gone2.text]);
    const ex0 = await call('POST', '/api/kit/remote/issues/export', {});
    const cl0 = await call('POST', '/api/kit/remote/issues/close', { iids: [1, 2], name: 'x.md' });
    H.ok('不是维护套件的电脑：不给导出，也不给关', ex0.status >= 400 && /维护套件/.test(ex0.json.error) && cl0.status >= 400 && gl.issues().every((i) => i.state === 'opened'), ex0.text + cl0.text);
    d = (await call('GET', '/api/kit/remote')).json;
    H.ok('配置里写什么都不认', d.maintainer === false && d.config.maintainerHosts === undefined, d.config);
    // 装成维护的那台电脑：带着测试用的环境变量重新起路由
    stopRouter();
    H.node(h, svc, ['start'], { cwd: h.root, timeout: 60000, env: Object.assign({}, live, { VIBE_KIT_MAINTAINER_HOSTS: os.hostname() }) });
    let back = false;
    for (let i = 0; i < 40 && !back; i++) { await H.sleep(250); back = (await call('GET', '/ui')).status === 200; }
    d = (await call('GET', '/api/kit/remote')).json;
    H.ok('维护的那台电脑：认了', back && d.maintainer === true, d && d.config);
    const ex1 = await call('POST', '/api/kit/remote/issues/export', {});
    H.ok('导出：只导出，内容交给页面（由浏览器下载），本机不存', ex1.status === 200 && ex1.json.export.ok && ex1.json.export.count === 2 && ex1.json.export.iids.length === 2 && /同事电脑上记的第一条/.test(ex1.json.export.text) && /^vibe-kit议题汇总-\d{8}-\d{6}\.md$/.test(ex1.json.export.name) && gl.issues().every((i) => i.state === 'opened') && !fs.existsSync(path.join(h.kit, 'issue-exports')), ex1.text.slice(0, 600));
    const cl = await call('POST', '/api/kit/remote/issues/close', { iids: ex1.json.export.iids, name: ex1.json.export.name });
    H.ok('页面交给浏览器之后再关：这一批关掉了', cl.status === 200 && cl.json.close.ok && cl.json.close.closed.length === 2 && gl.issues().every((i) => i.state === 'closed') && cl.json.issues.lastExport.closed === 2, cl.text.slice(0, 600));
    // 页面上点"导出"：文件交给浏览器之后问一句存下来没有。取消：不关，这一批还开着；确定：才关。用系统的 Edge 无头跑，下载落在浏览器自己的临时目录里
    H.node(h, '-e', ['require(' + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '出错', hook: 'verify-gate', title: '页面上导出时还开着的一条', what: 'x', sig: 'sig-ui-export-page' }) + ')'], { cwd: h.root });
    await call('POST', '/api/kit/remote/issues/sync', {});
    const openNow = () => gl.issues().filter((i) => i.state === 'opened' && !/使用情况/.test(i.title)).length;
    H.ok('（又有一条开放中的议题）', openNow() === 1, gl.issues().map((i) => i.state + ' ' + i.title));
    let eb = null; let ep = null; const dialogs = []; const pageErrors = []; let answer = false;
    try {
      const r = await require(path.join(H.SRC, 'kit', 'page', 'browser.js')).launchBrowser({});
      eb = r.browser;
      const ctx = await eb.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true });
      ep = await ctx.newPage();
      ep.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      ep.on('dialog', (dg) => { dialogs.push(dg.message()); (answer ? dg.accept() : dg.dismiss()).catch(() => {}); });
    } catch (e) { console.log('  这台电脑上起不来浏览器，页面上导出那部分没法测：' + String((e && e.message) || e).split('\n')[0]); }
    if (ep) {
      try {
        await ep.goto('http://127.0.0.1:' + PORT + '/ui');
        await ep.click('nav button[data-tab="remote"]');
        await ep.waitForSelector('#riExport', { state: 'visible', timeout: 30000 });
        const [dl1] = await Promise.all([ep.waitForEvent('download', { timeout: 60000 }), ep.click('#riExport')]);
        await ep.waitForFunction(() => /先不关/.test(document.querySelector('#riMsg').textContent), null, { timeout: 30000 });
        H.ok('文件交给了浏览器，接着问了一句存下来没有', /^vibe-kit议题汇总-\d{8}-\d{6}\.md$/.test(dl1.suggestedFilename()) && dialogs.length === 1 && /存下来了/.test(dialogs[0]) && /没存下来/.test(dialogs[0]), [dl1.suggestedFilename(), dialogs]);
        H.ok('选"取消"：这一批没关，说了下次导出会再带上', openNow() === 1 && /这一批还开着/.test(await ep.textContent('#riMsg')), await ep.textContent('#riMsg'));
        answer = true;
        await Promise.all([ep.waitForEvent('download', { timeout: 60000 }), ep.click('#riExport')]);
        await ep.waitForFunction(() => /关掉 \d+ 条/.test(document.querySelector('#riMsg').textContent), null, { timeout: 60000 });
        H.ok('选"确定"：关掉了', openNow() === 0 && dialogs.length === 2 && /关掉 1 条/.test(await ep.textContent('#riMsg')), [openNow(), await ep.textContent('#riMsg')]);
        H.ok('页面没有报错', pageErrors.length === 0, pageErrors);
      } catch (e) { H.ok('页面上导出走得通', false, String((e && e.stack) || e).slice(0, 600) + ' | 弹过的框：' + JSON.stringify(dialogs) + ' | 页面报的错：' + JSON.stringify(pageErrors)); }
    }
    if (eb) { try { await eb.close(); } catch (e) { /* 已经关了 */ } }
    const pv = await call('GET', '/api/kit/remote/usage/preview');
    H.ok('看看要传的使用情况：今天到现在的样子', pv.status === 200 && pv.json.usage && pv.json.usage.ok && /的使用情况/.test(pv.json.usage.today) && /<!-- vibe-kit-usage/.test(pv.json.usage.today), pv.text.slice(0, 600));
    const us = await call('POST', '/api/kit/remote/usage/sync', {});
    H.ok('立即上报使用情况：今天的明天才传', us.status === 200 && us.json.usageSync && us.json.usageSync.sent === 0 && us.json.issues && us.json.issues.usage, us.text.slice(0, 600));
    const mt = await call('POST', '/api/kit/remote/settings', { token: '' });
    const mint = await call('POST', '/api/kit/remote/mint', {});
    H.ok('清掉令牌，再用 SSH 申请一个', mt.json.settings.tokenSet === false && mint.status === 200 && mint.json.mint.ok && mint.json.settings.tokenSet && mint.json.settings.tokenSource === 'ssh' && /^\d{4}-/.test(mint.json.settings.tokenExpires) && !mint.text.includes(readJson(path.join(h.kit, 'secrets.json')).gitlabToken), mint.text);
    await call('POST', '/api/kit/config', { autoUpdate: 'notify' });
  }
  if (up && STAY > 0) {
    // 给人看页面：再发布一版，页面上能看到"有新版"
    const pkgC = H.makePackage('uiu-c', '20260917.0900');
    H.node(m, path.join(pkgC, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkgC, timeout: 600000, env: { VIBE_KIT_NO_UPDATE: undefined } });
    await call('POST', '/api/kit/remote/check', {});
    H.node(h, '-e', ['require(' + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '拦错了', hook: 'guard-spec', title: '留着给页面看的一条', what: 'x', sig: 'sig-ui-stay' }) + ')'], { cwd: h.root });
    console.log('配置页：http://127.0.0.1:' + PORT + '/ui   （点"更新和上报"）。留 ' + STAY + ' 秒；看完了建这个文件让它退出：' + path.join(h.root, 'stop'));
    const end = Date.now() + STAY * 1000;
    while (Date.now() < end && !fs.existsSync(path.join(h.root, 'stop'))) await H.sleep(500);
  }
  const stopped = stopRouter();
  H.ok('路由停掉了', stopped.code === 0, stopped.out + stopped.err);
  gl.stop();
  await H.sleep(500);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('配置页的更新和上报');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
