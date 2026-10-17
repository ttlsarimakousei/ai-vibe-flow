'use strict';
/*
 * 拿真的 IDEA 走一遍 devserver.js --idea（2026-10-17）：起、没改直接用、改了代码自动重启、停；用户点 Run 起着的改了代码结束重起；
 * 没写 --idea 时列运行配置；运行配置名写错。不是回归测试（要开着 IDEA、开了 MCP 和 brave mode），输出给人看。
 * 用的是假用户目录（和测试一样不碰真实的 ~/.claude）：里面记着 IDEA MCP 连上了、brave mode 开着。项目用 C:\WorkSpace\TestIdea
 * （Spring Boot 的 boot-demo，18081；pom 里配 tomcat7 插件的 mvc-pom，18082）。改过的源文件最后改回原样。
 * 用法：node dev/probes/idea-devserver.js [IDEA MCP 地址，默认 http://127.0.0.1:64342/stream] [项目目录，默认 C:\WorkSpace\TestIdea]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('../lib/harness');

const URL_ = process.argv[2] || 'http://127.0.0.1:64342/stream';
const PROJ = process.argv[3] || 'C:\\WorkSpace\\TestIdea';
const h = H.makeHome('idea-devserver');
H.write(path.join(h.kit, 'state', 'idea-mcp.json'), JSON.stringify({ status: 'ready', checkedAt: Date.now(), connections: [{ name: 'vibe-idea-' + new URL(URL_).port, url: URL_, version: '', managed: false }] }));
H.write(path.join(h.home, 'AppData', 'Roaming', 'JetBrains', 'IntelliJIdea2026.2', 'options', 'mcpServer.xml'), '<application>\n  <component name="McpServerSettings">\n    <option name="enableBraveMode" value="true" />\n    <option name="enableMcpServer" value="true" />\n  </component>\n</application>\n');
const DS = path.join(h.kit, 'tools', 'devserver.js');
const I = require(path.join(h.kit, 'lib', 'idea-run.js'));
const ds = (sub, dir, args) => { const t = Date.now(); const r = H.node(h, DS, [sub, '--dir', dir].concat(args || []), { cwd: dir, timeout: 400000 }); const last = (r.out.trim().split(/\r?\n/).pop() || '').slice(0, 260); console.log('  [' + r.code + '，' + ((Date.now() - t) / 1000).toFixed(1) + ' 秒] ' + sub + ' ' + (args || []).join(' ').slice(0, 80) + '\n      ' + (r.out.trim().split(/\r?\n/).length > 1 ? r.out.trim().split(/\r?\n/).slice(0, -1).filter((l) => !/^测完停掉用/.test(l)).map((l) => l.slice(0, 200)).join('\n      ') + '\n      ' : '') + '→ ' + last); return r; };
const get = (port) => new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: '/hello', timeout: 3000, agent: false }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b.slice(0, 40))); }); q.on('error', (e) => res('ERR ' + e.code)); q.on('timeout', () => { q.destroy(); res('ERR timeout'); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const swap = (f, a, b) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(a, b));

(async () => {
  const boot = path.join(PROJ, 'boot-demo'); const bootSrc = path.join(boot, 'src/main/java/com/example/boot/HelloController.java');
  const pom = path.join(PROJ, 'mvc-pom'); const pomSrc = path.join(pom, 'src/main/java/com/example/mvc/HelloController.java');
  const origBoot = fs.readFileSync(bootSrc, 'utf8'); const origPom = fs.readFileSync(pomSrc, 'utf8');
  const r = { url: URL_, projectPath: PROJ };
  try {
    console.log('== 没写 --idea：列运行配置，不起');
    ds('start', boot, ['--name', 'boot', '--port', 'auto', '--', 'mvn', 'spring-boot:run']);
    console.log('== Spring Boot：起、没改直接用、改了重启、停');
    ds('start', boot, ['--name', 'boot', '--idea', 'boot-demo', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
    console.log('  页面：', await get(18081));
    ds('start', boot, ['--name', 'boot', '--idea', 'boot-demo', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
    await sleep(1500); swap(bootSrc, /boot-demo v\d+/, 'boot-demo v8');
    ds('start', boot, ['--name', 'boot', '--idea', 'boot-demo', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
    console.log('  页面（应是 v8）：', await get(18081));
    ds('status', boot);
    ds('stop', boot, ['--name', 'boot']);
    console.log('  停了之后页面：', await get(18081));
    console.log('== 用户点 Run 起着的：没改直接用；改了结束它、调试方式重起');
    const run = await I.callTool(URL_, 'execute_run_configuration', { projectPath: PROJ, configurationName: 'boot-demo', waitForExit: false }, 60000);
    console.log('  Run 方式起：', run.ok ? '好了' : JSON.stringify(run).slice(0, 200));
    for (let i = 0; i < 40 && !/v8/.test(await get(18081)); i++) await sleep(1000);
    ds('start', boot, ['--name', 'boot', '--idea', 'boot-demo', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
    await sleep(1500); swap(bootSrc, /boot-demo v\d+/, 'boot-demo v9');
    ds('start', boot, ['--name', 'boot', '--idea', 'boot-demo', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
    console.log('  页面（应是 v9）：', await get(18081));
    ds('stop', boot, ['--all']);
    console.log('== Maven tomcat7:run：起、改了重启、停');
    ds('start', pom, ['--name', 'mvc', '--idea', 'mvc-pom [tomcat7:run]', '--port', '18082', '--', 'mvn', 'tomcat7:run']);
    console.log('  页面：', await get(18082));
    await sleep(1500); swap(pomSrc, /mvc-pom v\d+/, 'mvc-pom v8');
    ds('start', pom, ['--name', 'mvc', '--idea', 'mvc-pom [tomcat7:run]', '--port', '18082', '--', 'mvn', 'tomcat7:run']);
    console.log('  页面（应是 v8）：', await get(18082));
    ds('stop', pom, ['--all']);
    console.log('== 运行配置名写错');
    ds('start', boot, ['--name', 'boot', '--idea', 'boot', '--port', '18081', '--', 'mvn', 'spring-boot:run']);
  } finally {
    fs.writeFileSync(bootSrc, origBoot); fs.writeFileSync(pomSrc, origPom);
    const s = await I.sessions(r);
    if (s.ok) for (const x of s.list) await I.stopSession(r, x.id);
    for (const d of [boot, pom]) { try { fs.rmSync(path.join(d, '.vibe'), { recursive: true, force: true }); } catch (e) { /* 删不掉算了 */ } }
    H.cleanup();
    console.log('源文件改回原样，IDEA 里的调试会话停了：', s.ok ? s.list.map((x) => x.id).join('、') || '本来就没有' : '查不了');
  }
})();
