'use strict';
/*
 * 配置页用时才起（第 39 条）：只收本机、别的网站的页面拒绝、没心跳退出、不留进程、端口被占换一个。
 * 用法：node dev/test-config-page.js [旧版套件目录]（2248 没有 config-page.js，跑不过）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2];
const PORT = 18798;
const h = H.makeHome('config-page', FROM);
const page = path.join(h.kit, 'lib', 'config-page.js');
const stateFile = path.join(h.kit, 'state', 'config-page.json');
const env = (extra) => H.envFor(h, Object.assign({ VIBE_KIT_CONFIG_PORT: String(PORT), VIBE_KIT_NO_BROWSER: '1' }, extra));
const call = (port, method, url, headers, body) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: Object.assign({ 'content-type': 'application/json' }, headers), agent: false, timeout: 3000 }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers })); });
  r.on('error', () => resolve({ status: 0, text: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: '' }); });
  r.end(body ? JSON.stringify(body) : undefined);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const portOf = () => JSON.parse(H.read(stateFile)).port;
const pidOf = () => JSON.parse(H.read(stateFile)).pid;
const ensure = () => H.run(h, process.execPath, ['-e', 'require(' + JSON.stringify(page) + ').ensure().then((r)=>{console.log(JSON.stringify(r));process.exit(0)})'], { env: env() });
const serve = (extra) => { const p = spawn(process.execPath, [page, 'serve'], { env: env(extra), stdio: 'ignore', windowsHide: true }); return p; };
const until = async (fn, ms) => { for (let i = 0; i < (ms || 5000) / 100; i++) { if (await fn()) return true; await H.sleep(100); } return false; };

(async () => {
  H.section('起来、复用');
  const first = JSON.parse(ensure().out.trim().split('\n').pop());
  H.ok('起来了，给地址', first.ok && first.url === 'http://127.0.0.1:' + PORT + '/ui', first);
  const pid = pidOf();
  const second = JSON.parse(ensure().out.trim().split('\n').pop());
  H.ok('起着就复用，不再起一个', second.already === true && pidOf() === pid, second);

  H.section('只收本机，别的网站的页面拒绝');
  const ui = await call(PORT, 'GET', '/ui');
  H.ok('/ui 能打开，不许被嵌', ui.status === 200 && /x-frame|DENY/i.test(String(ui.headers['x-frame-options'])), ui.status);
  H.ok('页面上没有模型、用量两页', !/data-tab="models"/.test(ui.text) && !/data-tab="usage"/.test(ui.text));
  H.ok('页面发心跳', /\/api\/ping/.test(ui.text));
  H.ok('读开关', (await call(PORT, 'GET', '/api/kit')).status === 200);
  H.ok('Host 不是本机：拒绝', (await call(PORT, 'GET', '/api/kit', { host: 'evil.example' })).status === 403);
  H.ok('别的网站的页面发的：拒绝', (await call(PORT, 'GET', '/api/kit', { 'sec-fetch-site': 'cross-site' })).status === 403);
  H.ok('改东西不带自定义头：拒绝', (await call(PORT, 'POST', '/api/kit/config', {}, { tmpKeepDays: 5 })).status === 403);
  H.ok('Origin 是别的网站：拒绝', (await call(PORT, 'POST', '/api/kit/config', { 'x-vibe-router': '1', origin: 'https://evil.example' }, { tmpKeepDays: 5 })).status === 403);
  const save = await call(PORT, 'POST', '/api/kit/config', { 'x-vibe-router': '1', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:' + PORT }, { tmpKeepDays: 5 });
  H.ok('自己保存开关照常', save.status === 200 && JSON.parse(H.read(path.join(h.kit, 'config.json'))).tmpKeepDays === 5, save.text.slice(0, 200));
  H.ok('路由那些接口没了', (await call(PORT, 'GET', '/api/state')).status === 404 && (await call(PORT, 'GET', '/api/usage')).status === 404 && (await call(PORT, 'POST', '/v1/messages', { 'x-vibe-router': '1' }, {})).status === 404);
  process.kill(pid);
  await until(() => !alive(pid));

  H.section('没心跳退出，没人开退出，不留进程');
  {
    const p = serve({ VIBE_KIT_CONFIG_IDLE_MS: '600', VIBE_KIT_CONFIG_NOBODY_MS: '60000' });
    await until(() => fs.existsSync(stateFile) && alive(pidOf()) && pidOf() === p.pid);
    await call(PORT, 'GET', '/api/ping');
    H.ok('心跳之后没人了：退出', await until(() => !alive(p.pid), 6000));
    H.ok('退出时状态文件删了', !fs.existsSync(stateFile));
    const q = serve({ VIBE_KIT_CONFIG_IDLE_MS: '60000', VIBE_KIT_CONFIG_NOBODY_MS: '600' });
    await until(() => fs.existsSync(stateFile) && pidOf() === q.pid);
    H.ok('起来了没人开：也退出', await until(() => !alive(q.pid), 6000));
  }

  H.section('固定端口被占：换一个');
  {
    const holder = http.createServer((q, s) => s.end('x'));
    await new Promise((r) => holder.listen(PORT, '127.0.0.1', r));
    const r = JSON.parse(ensure().out.trim().split('\n').pop());
    H.ok('换了端口，地址对', r.ok && portOf() !== PORT && r.url.includes(':' + portOf() + '/'), r);
    const other = pidOf();
    holder.close();
    process.kill(other);
    await until(() => !alive(other));
  }
  H.section('敲 /vk-config：钩子起配置页、拦下这句话，不发模型请求');
  for (const prompt of ['/vk-config', '<command-message>vk-config</command-message>\n<command-name>/vk-config</command-name>']) {
    const out = H.node(h, path.join(h.kit, 'hooks', 'task-anchor.js'), [], { cwd: h.root, env: { VIBE_KIT_CONFIG_PORT: String(PORT) }, input: JSON.stringify({ session_id: 's-cfg', cwd: h.root, hook_event_name: 'UserPromptSubmit', prompt }) }).out.trim();
    const j = (() => { try { return JSON.parse(out); } catch (e) { return {}; } })();
    H.ok('拦下，理由里是地址：' + prompt.slice(0, 20), j.decision === 'block' && /配置页：http:\/\/127\.0\.0\.1:\d+\/ui/.test(j.reason), out);
    if (fs.existsSync(stateFile)) { const p = pidOf(); process.kill(p); await until(() => !alive(p)); try { fs.unlinkSync(stateFile); } catch (e) { /* 没有 */ } }
  }
  const other = H.hook(h, 'task-anchor', { session_id: 's-cfg', cwd: h.root, hook_event_name: 'UserPromptSubmit', prompt: '讲讲 /vk-config 是干什么的' });
  H.ok('话里提到不算', !/"decision":\s*"block"/.test(JSON.stringify(other || '')), other);

  H.section('更新装完（VERSION 变了）：用新代码重起一份，端口不变');
  {
    const p = serve({ VIBE_KIT_CONFIG_IDLE_MS: '60000', VIBE_KIT_CONFIG_NOBODY_MS: '60000' });
    await until(() => fs.existsSync(stateFile) && pidOf() === p.pid);
    await call(PORT, 'GET', '/api/ping');
    const ver = path.join(h.kit, 'VERSION');
    const old = H.read(ver) || '';
    H.write(path.join(h.kit, 'update', 'lock.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    H.write(ver, '20991231.0000\n');
    await H.sleep(5500);
    H.ok('更新进程还拿着锁：不重起', alive(p.pid) && pidOf() === p.pid);
    fs.unlinkSync(path.join(h.kit, 'update', 'lock.json'));
    H.ok('放了锁：换了进程', await until(() => fs.existsSync(stateFile) && pidOf() !== p.pid && !alive(p.pid), 12000));
    H.ok('新的还在原来的端口上答话', await until(async () => (await call(PORT, 'GET', '/api/ping')).status === 200, 5000));
    // 先停再改回版本号：不然它看见版本号又变了，再重起一次
    const q = pidOf();
    process.kill(q);
    await until(() => !alive(q));
    H.write(ver, old);
    try { fs.unlinkSync(stateFile); } catch (e) { /* 没有 */ }
  }

  H.section('固定端口被占、在别的端口上：重起还在那个端口（复审 R8）');
  {
    const holder = http.createServer((q, s) => s.end('x'));
    const P2 = PORT + 1; // 上一节连过 PORT，Windows 上 TIME_WAIT 没过去 bind 不上
    await new Promise((r) => holder.listen(P2, '127.0.0.1', r));
    const p = serve({ VIBE_KIT_CONFIG_PORT: String(P2), VIBE_KIT_CONFIG_IDLE_MS: '60000', VIBE_KIT_CONFIG_NOBODY_MS: '60000' });
    await until(() => fs.existsSync(stateFile) && pidOf() === p.pid);
    const port0 = portOf();
    H.ok('（固定端口被占，在别的端口上）', port0 !== P2, port0);
    const old = new Date(Date.now() - 5 * 86400000);
    fs.utimesSync(stateFile, old, old);
    await call(port0, 'GET', '/api/ping');
    H.ok('心跳把状态文件摸新：开着的页面不会被按时间清掉', Date.now() - fs.statSync(stateFile).mtimeMs < 60000);
    const ver = path.join(h.kit, 'VERSION');
    const keep = H.read(ver) || '';
    H.write(ver, '20991231.0001\n');
    H.ok('换了进程', await until(() => fs.existsSync(stateFile) && pidOf() !== p.pid && !alive(p.pid), 12000));
    H.ok('端口不变', portOf() === port0, [portOf(), port0]);
    const q = pidOf();
    process.kill(q);
    await until(() => !alive(q));
    H.write(ver, keep);
    holder.close();
    try { fs.unlinkSync(stateFile); } catch (e) { /* 没有 */ }
  }

  H.section('首页：流程图放进来，离线能看');
  {
    const page2 = H.read(path.join(h.kit, 'ui', 'ui.html')) || '';
    H.ok('默认打开套件说明', /<button data-tab="guide" class="on">/.test(page2) && /<section id="tab-guide" class="tab">/.test(page2));
    const guide = page2.slice(page2.indexOf('id="tab-guide"'), page2.indexOf('id="tab-local"'));
    H.ok('图 1～4、6～8 一共 7 张', (guide.match(/<svg/g) || []).length === 7, (guide.match(/<svg/g) || []).length);
    H.ok('没有外链字体、脚本', !/fonts\.googleapis|<link[^>]+href="http|<script[^>]+src="http/.test(page2));
    H.ok('没有改动说明、路由', !/路由|要改（|第 39 条|用量那一行/.test(guide), (guide.match(/.{20}路由.{20}/) || [''])[0]);
  }
  H.done('配置页用时才起');
})().catch((e) => { H.ok('测试异常', false, e.stack); H.done('配置页用时才起'); });
