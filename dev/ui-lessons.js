'use strict';
/*
 * 配置页的"经验规则"卡片：在假的用户目录里起一个临时路由（换一个端口，不碰正在用的），先把接口测一遍，
 * 再留着几分钟给人（或浏览器工具）看页面。看完在临时目录里建一个叫 stop 的文件，或者等到时间，它自己退出并清理。
 * 用法：node dev/ui-lessons.js [端口，默认 18733] [留多少秒，默认 0 = 测完接口就退]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18733;
const STAY = Number(process.argv[3]) || 0;
const h = H.makeHome('ui', null, { lessonThreshold: 1 });
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
fs.writeFileSync(path.join(h.cfg, 'settings.json'), '{}\n');

const TOOL = path.join(h.kit, 'tools', 'lesson.js');
const A = H.makeRepo(path.join(h.work, 'sjytoa'), { 'pom.xml': '<project/>\n', 'src/main/java/com/x/OrderService.java': 'class OrderService {}\n', 'src/main/java/com/x/OrderMapper.java': 'interface OrderMapper {}\n', 'src/main/resources/mapper/OrderMapper.xml': '<mapper/>\n', 'web/src/views/Order.vue': '<template/>\n' });
const B = H.makeRepo(path.join(h.work, 'fileservice'), { 'pom.xml': '<project/>\n', 'src/main/resources/mapper/FileMapper.xml': '<mapper/>\n' });
const add = (cwd, file, text, from, extra) => H.node(h, TOOL, ['add', '--file', file, '--text', text, '--from', from, '--new'].concat(extra || []), { cwd });
add(A, 'src/main/java/com/x/OrderService.java', '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错', 'add-export 2.3', ['--kind', '边界']);
add(A, 'src/main/java/com/x/OrderService.java', '导出接口要走异步任务：同步导出超过一万行会超时', 'add-export 3.1');
add(A, 'web/src/views/Order.vue', '列表页切换查询条件要把页码重置成 1：不重置会停在一个不存在的页上', 'fix-list 1.1', ['--kind', '前端交互']);
add(A, 'src/main/resources/mapper/OrderMapper.xml', 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空，空的直接返回空结果', 'add-export 2.4');
add(B, 'src/main/resources/mapper/FileMapper.xml', 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空，空的直接返回空结果', 'add-upload 1.2');
H.setConfig(h, { lessonThreshold: 2 });
H.node(h, TOOL, ['add', '--file', 'src/main/java/com/x/OrderService.java', '--text', '分页查询的 pageSize 要限制上限：不限制的话传 100000 会把库拖垮', '--from', 'add-page 1.1', '--new'], { cwd: A });
// 已经是规则了又犯两次：配置页上要标"没管住"
H.node(h, TOOL, ['add', '--file', 'src/main/java/com/x/OrderService.java', '--text', '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错', '--from', 'add-refund 1.1'], { cwd: A });
H.node(h, TOOL, ['add', '--file', 'src/main/java/com/x/OrderService.java', '--text', '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错', '--from', 'add-stock 1.1'], { cwd: A });
const jf = path.join(A, '.claude', 'rules', 'ttls-lessons-java.md');
fs.writeFileSync(jf, fs.readFileSync(jf, 'utf8') + '- 金额一律用 BigDecimal，不用 double\n');

const call = (method, url, body) => new Promise((resolve) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: Object.assign({ 'content-type': 'application/json', 'x-vibe-router': '1' }, data ? { 'content-length': data.length } : {}) }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', (e) => resolve({ status: 0, json: null, text: String(e) }));
  if (data) req.write(data);
  req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  router.stdout.on('data', (d) => { log += d; });
  router.stderr.on('data', (d) => { log += d; });
  const stopAll = () => { try { router.kill(); } catch (e) { /* 已经退了 */ } };
  process.on('exit', stopAll);
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = (await call('GET', '/ui')).status === 200; }
  H.ok('临时路由起来了，配置页打得开', up, log);
  if (up) {
    H.section('接口');
    const page = await call('GET', '/ui');
    H.ok('经验规则单开一页，卡片和开关都在那一页', /data-tab="lessons"/.test(page.text) && /id="tab-lessons"[\s\S]*id="sec-lessons" data-sec="经验规则"[\s\S]*id="k_autoMemory"[\s\S]*id="tab-remote"/.test(page.text));
    const kitInfo = await call('GET', '/api/kit');
    H.ok('开关里有新的几项', kitInfo.json && kitInfo.json.config && kitInfo.json.config.lessons === 'on' && kitInfo.json.config.autoMemory === 'off' && kitInfo.json.config.lessonThreshold === 2, kitInfo.json && kitInfo.json.config);
    let d = (await call('GET', '/api/kit/lessons')).json;
    H.ok('列出了两个项目', d && d.projects && d.projects.length === 2 && d.projects.some((p) => p.name === 'sjytoa'), d);
    const pa = d.projects.find((p) => p.name === 'sjytoa');
    H.ok('项目的规则按文件类型分组', pa.files.map((f) => f.group).sort().join() === 'java,sql,web', pa.files.map((f) => f.group));
    const java = pa.files.find((f) => f.group === 'java');
    H.ok('手写的行列出来了', java.manual.some((m) => /BigDecimal/.test(m)), java);
    H.ok('没管住的次数', java.rules.some((r) => r.miss === 2), java.rules);
    H.ok('候选列出来了', pa.candidates.some((c) => /pageSize/.test(c.text) && c.count === 1), pa.candidates);
    H.ok('等确认的一条', d.pending.length === 1 && d.pending[0].projects.length === 2, d.pending);
    H.ok('还没有用户级规则', d.user.length === 0);
    const pr = await call('POST', '/api/kit/lessons/promote', { id: d.pending[0].id });
    H.ok('点"升成用户级"', pr.status === 200 && pr.json.user.length === 1 && pr.json.pending.length === 0 && fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-sql.md')), pr.text);
    const uid = pr.json.user[0].rules[0].id;
    const ed = await call('POST', '/api/kit/lessons/edit', { scope: 'user', id: uid, text: 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空' });
    H.ok('改用户级规则的字', ed.status === 200 && ed.json.user[0].rules[0].text === 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空', ed.text);
    const bad = await call('POST', '/api/kit/lessons/edit', { scope: 'user', id: uid, text: '短' });
    H.ok('改得太短不收', bad.status >= 400 || (bad.json && bad.json.error), bad.text);
    const pe = await call('POST', '/api/kit/lessons/remove', { scope: 'project', root: pa.root, id: java.rules[java.rules.length - 1].id });
    H.ok('删项目规则', pe.status === 200 && pe.json.projects.find((p) => p.name === 'sjytoa').files.find((f) => f.group === 'java').rules.length === java.rules.length - 1, pe.text);
    const evil = await call('POST', '/api/kit/lessons/remove', { scope: 'project', root: path.join(h.root, 'nowhere'), id: 'L000000' });
    H.ok('不认识的项目路径不收', evil.status >= 400 || (evil.json && evil.json.error), evil.text);
    // 路由原来的规定：读（GET）本机就行，改（POST）必须带页面的请求头
    const noHeader = await new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ scope: 'user', id: uid }));
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/kit/lessons/remove', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.write(data); req.end();
    });
    H.ok('不带页面的请求头改不了', noHeader === 403 && fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-sql.md')), noHeader);
    const sv = await call('POST', '/api/kit/config', { lessons: 'collect', lessonThreshold: 3, lessonMaxPerGroup: 8, lessonMaxChars: 100, lessonPromote: 'auto', autoMemory: 'on' });
    H.ok('保存设置', sv.status === 200 && sv.json.config.lessons === 'collect' && sv.json.config.lessonThreshold === 3 && sv.json.config.lessonMaxPerGroup === 8 && sv.json.config.lessonMaxChars === 100 && sv.json.config.lessonPromote === 'auto' && sv.json.config.autoMemory === 'on', sv.text);
    const sv2 = await call('POST', '/api/kit/config', { lessons: 'on', lessonThreshold: 99, lessonMaxPerGroup: 1, autoMemory: 'off', lessonPromote: 'ask' });
    H.ok('乱填的数不收，保持原值', sv2.json.config.lessonThreshold === 3 && sv2.json.config.lessonMaxPerGroup === 8 && sv2.json.config.lessons === 'on', sv2.text);
    const st = JSON.parse(H.read(path.join(h.cfg, 'settings.json')) || '{}');
    H.ok('保存后"自动记忆"那一项写进了假用户目录的 settings.json', st.env && st.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1', { st, out: sv2.json.output });
    await call('POST', '/api/kit/config', { lessonThreshold: 2, lessonMaxPerGroup: 10, lessonMaxChars: 120 });
    // 给页面看的：再攒一条等确认的
    H.setConfig(h, Object.assign(JSON.parse(H.read(path.join(h.kit, 'config.json'))), { lessonThreshold: 1 }));
    add(A, 'web/src/views/Order.vue', '弹窗关闭时要清掉表单校验状态：不清的话下次打开还带着上次的红字', 'fix-dialog 1.1');
    H.makeRepo(path.join(h.work, 'portal'), { 'package.json': '{}\n', 'src/views/User.vue': '<template/>\n' });
    add(path.join(h.work, 'portal'), 'src/views/User.vue', '弹窗关闭时要清掉表单校验状态：不清的话下次打开还带着上次的红字', 'add-user 1.1');
    H.setConfig(h, Object.assign(JSON.parse(H.read(path.join(h.kit, 'config.json'))), { lessonThreshold: 2 }));
    d = (await call('GET', '/api/kit/lessons')).json;
    H.ok('页面上会有一条等确认的', d.pending.length === 1, d.pending);
  }
  if (up && STAY > 0) {
    console.log('配置页：http://127.0.0.1:' + PORT + '/ui   （点"套件开关"，往下找"经验规则"）。留 ' + STAY + ' 秒；看完了建这个文件让它退出：' + path.join(h.root, 'stop'));
    const end = Date.now() + STAY * 1000;
    while (Date.now() < end && !fs.existsSync(path.join(h.root, 'stop'))) await sleep(500);
  }
  stopAll();
  await sleep(600);
  H.done('配置页的经验规则');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); process.exit(2); });
