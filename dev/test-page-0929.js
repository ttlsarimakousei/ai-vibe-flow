'use strict';
/*
 * 看页面的场景执行器（kit/page/scenario-run.js），0929 反馈里的两条：
 *   F20260929-017   登录失败也返回 200，只等响应不查内容，没登录上场景照样往下走
 *   F20260929-012   上传控件被自己画的按钮盖住、要应答文件选择框，场景文件做不了
 * 用本机的 Edge 无头跑，不开窗口。用法：node dev/test-page-0929.js [端口，默认 18771]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18771;
const BASE = 'http://127.0.0.1:' + PORT;
const h = H.makeHome('page0929');
// 看页面要用的依赖不在假用户目录里（拷套件时没带 node_modules）：直接跑源码里的那一份执行器
const RUN = path.join(H.SRC, 'kit', 'page', 'scenario-run.js');
const work = path.join(h.work, 'site');
fs.mkdirSync(work, { recursive: true });
H.write(path.join(work, 'data', 'a.txt'), 'hello\n');

/** 跑一个场景（不能用同步的：假站点在另一个进程里，这里要等它） */
function run(name, scenario, extra) {
  const file = path.join(work, '.vibe', 'scenarios', name + '.json');
  H.write(file, typeof scenario === 'string' ? scenario : JSON.stringify(scenario, null, 1));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [RUN, file, '--base', BASE].concat(extra || []), { cwd: work, env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 已经退了 */ } }, 90000);
    c.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      const line = out.split(/\r?\n/).filter((l) => /^RESULT /.test(l)).pop();
      try { result = JSON.parse(line.slice(7)); } catch (e) { result = null; }
      resolve({ code, out, err, result });
    });
  });
}
const login = (pwd, more) => [{ goto: '/login.html' }, { fill: '#username', value: 'aqbmy' }, { fill: '#password', value: pwd }].concat(more);

(async () => {
  const watch = await H.watchWindows('page-win');
  const site = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-site.js'), String(PORT)], { windowsHide: true, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await H.sleep(150); up = (await H.httpGet(BASE + '/__ping')).status === 200; }
  H.ok('假站点起来了', up);

  H.section('登录失败也返回 200：同一步里查返回的内容（F20260929-017）');
  {
    const bad = await run('login-bad', { name: '口令不对', steps: login('wrong', [
      { waitResponse: '/api/login', click: '#go', expectStatus: 200, expectJson: 'iserror', equals: false },
      { request: 'GET /api/me', expectStatus: 200 }]) });
    if (bad.result === null && /无法启动任何浏览器/.test(bad.out + bad.err)) { console.log('  这台电脑上起不来浏览器，看页面的部分没法测：' + (bad.out + bad.err).slice(0, 300)); }
    H.ok('反馈原样：没登录上，等响应的那一步就失败', bad.code === 1 && bad.result && bad.result.ok === false && /^4\. /.test(bad.result.failed[0]) && /iserror = true，期望 false/.test(bad.result.failed[0]), bad.out + bad.err);
    H.ok('后面的步骤没有执行', /"failed":\["4\./.test(bad.out) && !/√ 5\./.test(bad.out), bad.out);
    const good = await run('login-good', { name: '口令对', steps: login('right', [
      { waitResponse: '/api/login', click: '#go', expectStatus: 200, expectJson: 'iserror', equals: false },
      { request: 'GET /api/me', expectStatus: 200, expectJson: 'user', equals: 'admin' }, { expectText: '登录成功' }]) });
    H.ok('登录上了：全过，后面的接口带着登录状态', good.code === 0 && good.result && good.result.ok === true, good.out + good.err);
    H.ok('同一步的结果里动作和断言都写着', /√ 4\. .*→ 200.*状态码 200.*iserror = false/.test(good.out), good.out);
    const old = await run('login-old', { name: '分开写', steps: login('wrong', [{ waitResponse: '/api/login', click: '#go' }, { expectJson: 'iserror', equals: false }]) });
    H.ok('断言单独写一步的老写法照样管用', old.code === 1 && /^5\. /.test(old.result.failed[0]), old.out + old.err);
  }

  H.section('只调接口的场景：断言写在 request 那一步里');
  {
    const a = await run('api-inline', { name: '接口', steps: [
      { request: 'POST /api/login', json: { u: 'x', p: 'wrong' }, expectStatus: 200, expectJson: 'iserror', equals: true },
      { request: 'POST /api/login', json: { u: 'x', p: 'right' }, readJson: 'code', as: 'code' },
      { request: 'GET /api/me', expectStatus: 200 }] });
    const via = (() => { try { return JSON.parse(fs.readFileSync(path.join(a.result.out, 'result.json'), 'utf8')).via; } catch (e) { return ''; } })();
    H.ok('全过，没开浏览器', a.code === 0 && a.result.ok === true && /没开浏览器/.test(via), [via, a.out + a.err]);
    H.ok('request 和 readJson 写在一步里：读到了值', a.result && a.result.values.code === 0, a.result);
    const b = await run('api-two-expect', { name: '两条断言', steps: [
      { request: 'POST /api/login', json: { u: 'x', p: 'wrong' } }, { expectStatus: 200, expectJson: 'code', equals: 0 }] });
    H.ok('一步里两条断言：第二条没过也算失败（以前第二条被忽略）', b.code === 1 && /code = 1，期望 0/.test(b.result.failed[0]), b.out + b.err);
  }

  H.section('上传文件、应答文件选择框、点被盖住的控件（F20260929-012）');
  {
    const u = await run('upload', { name: '上传', steps: [{ goto: '/upload.html' }, { upload: '#f', files: ['../../data/a.txt'] }, { read: '#name', as: 'name' }] });
    H.ok('藏起来、被盖住的文件输入框：直接交文件', u.code === 0 && u.result.values.name === 'a.txt', u.out + u.err);
    const c = await run('chooser', { name: '文件选择框', steps: [{ goto: '/upload.html' }, { onFileChooser: ['../../data/a.txt'] }, { click: '#browse' }, { wait: 300 }, { read: '#name', as: 'name' }] });
    H.ok('点了按钮才弹的文件选择框：自动选上', c.code === 0 && c.result.values.name === 'a.txt', c.out + c.err);
    // 反馈原样：控件被自己画的 label 盖住，常规点击过不了"点不点得到"的检查；强制点击会弹文件选择框，要有人应答
    const f = await run('force', { name: '强制点击', timeout: 3000, steps: [{ goto: '/upload.html' }, { onFileChooser: ['../../data/a.txt'] }, { click: '#f', force: true }, { wait: 300 }, { read: '#name', as: 'name' }] });
    H.ok('反馈原样：被盖住的上传控件，强制点击加应答文件选择框', f.code === 0 && f.result.values.name === 'a.txt', f.out + f.err);
    const n = await run('noforce', { name: '不加 force', timeout: 3000, steps: [{ goto: '/upload.html' }, { click: '#f' }] });
    H.ok('不加 force：点不到，这一步失败', n.code === 1 && /^2\. /.test(n.result.failed[0]), n.out + n.err);
    const m = await run('missing', { name: '文件不存在', steps: [{ goto: '/upload.html' }, { upload: '#f', files: ['nope.txt'] }] });
    H.ok('要上传的文件不存在：说清是哪个', m.code === 1 && /要上传的文件不存在/.test(m.result.failed[0]), m.out + m.err);
  }

  H.section('一步里写了两个动作：只做第一个，结果里提醒');
  {
    const t = await run('two', { name: '两个动作', steps: [{ goto: '/two.html' }, { click: '#a', hover: '#b' }, { read: '#log', as: 'log' }] });
    H.ok('做了第一个动作，场景没失败', t.code === 0 && t.result.values.log === 'a', t.out + t.err);
    H.ok('结果里有提醒，说清没做哪个', Array.isArray(t.result.warnings) && /只做了 click，没做 hover/.test(t.result.warnings[0]) && /★/.test(t.out), t.result);
    const w = await run('wait-fill', { name: '等响应带动作', steps: [{ goto: '/login.html' }, { fill: '#username', value: 'a' }, { fill: '#password', value: 'right' }, { waitResponse: '/api/login', method: 'POST', click: '#go' }, { expectJson: 'code', equals: 0 }] });
    H.ok('waitResponse 带一个触发动作的老写法：没有提醒', w.code === 0 && !w.result.warnings, w.out + w.err);
  }

  H.section('0930 审查：带 BOM 的场景文件、时限、读到的长值');
  {
    const bom = await run('bom', '﻿' + JSON.stringify({ name: '带 BOM', steps: [{ wait: 10 }] }));
    H.ok('场景文件带 BOM（记事本另存的 UTF-8）：照样能跑', bom.code === 0 && bom.result && bom.result.ok === true, bom.out + bom.err);
    const t0 = Date.now();
    const slow = await run('max', { name: '总时限', steps: [{ wait: 999999 }, { wait: 10 }] }, ['--max', '3']);
    const took = Date.now() - t0;
    H.ok('到了总时限（--max 3）：几秒内退出，退出码 1', slow.code === 1 && took < 20000, [took, slow.out + slow.err]);
    const slowFull = (() => { try { return JSON.parse(fs.readFileSync(path.join(slow.result.out, 'result.json'), 'utf8')); } catch (e) { return null; } })();
    H.ok('结果里说清是总时限：正在做的那一步失败，后面的跳过，result.json 写出来了', slow.result && /超过 3 秒/.test(slow.result.fatal || '') && /^1\. .*到了总时限/.test(slow.result.failed[0] || '') && slowFull && slowFull.steps.length === 2 && slowFull.steps[1].skipped === true, [slow.result, slowFull && slowFull.steps]);
    H.ok('wait 写得太大：按 60 秒算，记了提醒', slow.result && (slow.result.warnings || []).some((x) => /wait 写了 999999ms，最多等 60 秒/.test(x)), slow.result);
    const to = await run('timeout-cap', { name: 'timeout 上限', timeout: 999999, steps: [{ request: 'GET /__ping', expectStatus: 200 }] });
    H.ok('timeout 写得太大：按 120 秒算，记了提醒', to.code === 0 && to.result && (to.result.warnings || []).some((x) => /timeout 写了 999999ms，最多等 120 秒/.test(x)), to.out + to.err);
    const lv = await run('long-values', { name: '长的值', steps: [{ goto: '/long.html' }, { read: '#t' }, { read: '#s' }, { request: 'GET /api/long', readJson: 'list', as: 'list' }] });
    H.ok('读到的长文字：步骤那一行和 RESULT 里都截断，说了全文在 result.json', lv.code === 0 && lv.result && /v1 = "长{10,}[^\n]*…（共 \d+ 字，全文见 result\.json）/.test(lv.out) && /全文见 result\.json/.test(String(lv.result.values.v1)) && String(lv.result.values.v1).length < 300 && /全文见 result\.json/.test(String(lv.result.values.list)), lv.out + lv.err);
    const lvFull = (() => { try { return JSON.parse(fs.readFileSync(path.join(lv.result.out, 'result.json'), 'utf8')); } catch (e) { return null; } })();
    H.ok('result.json 里是全文', lvFull && lvFull.values.v1.length === 500 && Array.isArray(lvFull.values.list) && lvFull.values.list.length === 100, lvFull && lvFull.values);
    H.ok('没写 as 的按顺序叫 v1、v2（以前说明里的名字多一号）', /√ 2\. [^\n]*v1 = /.test(lv.out) && /√ 3\. [^\n]*v2 = "短"/.test(lv.out) && lv.result && lv.result.values.v2 === '短', lv.out);
  }

  H.section('截图、布局树、和设计图比对（0930 删了没人用的布局树比对代码，这条路照样要通）');
  {
    const s1 = await run('shot', { name: '截图', steps: [{ goto: '/two.html' }, { screenshot: 'p' }, { layout: 'p' }] });
    const png = path.join(work, '.vibe', 'out', 'shot', 'p.png');
    H.ok('截图和布局树都出来了', s1.code === 0 && fs.existsSync(png) && fs.existsSync(path.join(work, '.vibe', 'out', 'shot', 'p-layout.txt')), s1.out + s1.err);
    const ref = path.join(work, '.vibe', 'scenarios', 'ref.png');
    if (fs.existsSync(png)) fs.copyFileSync(png, ref);
    const cmp = [{ goto: '/two.html' }, { screenshot: 'p' }, { layout: 'p' }, { diff: 'p', ref: 'ref.png' }];
    const same = await run('diff-same', { name: '一样', steps: cmp });
    H.ok('和自己比：差异 0', same.code === 0 && same.result && same.result.values.pDiff === '0.00%', same.out + same.err);
    // 设计图左上角涂一块：差异要落到那里的按钮上
    if (fs.existsSync(ref)) require(path.join(H.SRC, 'kit', 'page', 'pixel-diff.js')).paintRects(ref, [{ x: 0, y: 0, w: 60, h: 30 }]);
    const changed = await run('diff-changed', { name: '不一样', steps: cmp });
    const txt = H.read(path.join(work, '.vibe', 'out', 'diff-changed', 'p-diff.txt')) || '';
    H.ok('设计图改了一块：有差异，说了落在哪个节点上', changed.code === 0 && changed.result && parseFloat(changed.result.values.pDiff) > 0 && /(命中|相交节点) button/.test(txt), [changed.out + changed.err, txt]);
  }

  try { site.kill(); } catch (e) { /* 已经退了 */ }
  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('看页面 0929');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
