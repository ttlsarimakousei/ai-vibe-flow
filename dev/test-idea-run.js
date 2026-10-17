'use strict';
/*
 * devserver.js --idea：用 IDEA 的运行配置起服务、改完代码自动重启（用户 2026-10-17 定的）。对着假的 IDEA MCP（lib/fake-idea.js）跑，不用开着 IDEA。
 *   IDEA 用不了          没连上、没开 brave mode：照 -- 后面的命令起
 *   没写 --idea          IDEA 连着、有运行配置：不起，列出运行配置名
 *   调试方式起            起来了要等它答 HTTP，上次没等到答 HTTP 的再 start 接着等；调用开着事件流（IDEA 等不到事件流会把慢的调用丢掉）
 *   没改直接用、改了重启   改了代码：停掉 IDEA 的会话、重起，答的是新代码
 *   用户点 Run 起的        MCP 停不了：没改直接用；改了结束它、调试方式重起
 *   出错                  运行配置名写错列出有哪些；IDEA 不回话（弹了编辑框）说清去 IDEA 里看、不改用命令起；端口被别的程序占着不动它
 *   起服务的拦截提示       IDEA 能用时提 --idea
 * 真的 IDEA 上走一遍用 dev/probes/idea-devserver.js。
 * 用法：node dev/test-idea-run.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port) => new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000, agent: false }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b.trim())); }); q.on('error', (e) => res('ERR ' + e.code)); q.on('timeout', () => { q.destroy(); res('ERR timeout'); }); });
const last = (r) => (r.out.trim().split(/\r?\n/).pop() || '');
const BRAVE = (on) => '<application>\n  <component name="McpServerSettings">\n    <option name="enableBraveMode" value="' + on + '" />\n    <option name="enableMcpServer" value="true" />\n  </component>\n</application>\n';

(async () => {
  const watch = await H.watchWindows('idea-run-win');
  const h = H.makeHome('idea-run', FROM, { autoUpdate: 'off', issueUpload: 'off', usageReport: 'off', autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false });
  const shell = path.join(h.work, 'shell'); const app = path.join(shell, 'app'); const src = path.join(app, 'src');
  fs.mkdirSync(path.join(shell, '.idea'), { recursive: true }); fs.mkdirSync(src, { recursive: true });
  H.write(path.join(src, 'v.txt'), 'v1\n');
  const old = new Date(Date.now() - 600000); fs.utimesSync(path.join(src, 'v.txt'), old, old);
  const logs = H.tempDir('idea-run-logs');
  const svcPort = await freePort();
  const fake = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-idea.js'), String(svcPort), src, logs], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const mcpPort = await new Promise((res) => { let b = ''; fake.stdout.on('data', (c) => { b += c; const m = b.match(/\{"port":(\d+)\}/); if (m) res(Number(m[1])); }); });
  const url = 'http://127.0.0.1:' + mcpPort + '/stream';
  const DS = path.join(h.kit, 'tools', 'devserver.js');
  const env = { VIBE_KIT_IDEA_PID: String(fake.pid) };
  const ds = (args) => H.node(h, DS, args.concat(['--dir', app]), { cwd: app, timeout: 120000, env });
  const cmd = ['--', process.execPath, path.join(__dirname, 'lib', 'fake-idea.js'), '__service', String(svcPort), src, '0'];
  const startIdea = (extra) => ds(['start', '--name', 'app', '--idea', 'app', '--port', String(svcPort)].concat(extra || [], cmd));
  const connect = (brave) => {
    H.write(path.join(h.kit, 'state', 'idea-mcp.json'), JSON.stringify({ status: 'ready', checkedAt: Date.now(), connections: [{ name: 'vibe-idea-' + mcpPort, url, version: '2026.2.3', managed: true }] }));
    H.write(path.join(h.home, 'AppData', 'Roaming', 'JetBrains', 'IntelliJIdea2026.2', 'options', 'mcpServer.xml'), BRAVE(brave));
  };
  const touch = async (v) => { await H.sleep(1100); H.write(path.join(src, 'v.txt'), v + '\n'); };
  try {
    H.section('IDEA 用不了：照 -- 后面的命令起');
    const r0 = startIdea();
    H.ok('IDEA 的 MCP 没连上：说清楚，照命令起来了', r0.code === 0 && /用不了 IDEA 起：IDEA 的 MCP 没连上/.test(r0.out) && /^起来了：app，端口 \d+，/.test(last(r0)) && (await get(svcPort)) === 'v1', r0.out);
    H.ok('照命令起的停得掉', ds(['stop', '--all']).code === 0 && /ERR/.test(await get(svcPort)));
    connect(false);
    const r1 = startIdea();
    H.ok('IDEA 连着但没开 brave mode：说清楚怎么开，照命令起', r1.code === 0 && /没开 brave mode（设置 → 工具 → MCP 服务器/.test(r1.out) && /^起来了：/.test(last(r1)), r1.out);
    ds(['stop', '--all']);
    const r2 = ds(['start', '--name', 'app', '--idea', 'app', '--port', String(svcPort)]);
    H.ok('IDEA 用不了、-- 后面又没写命令：不起，说清原因', r2.code === 1 && /没起来：用不了 IDEA 起/.test(r2.out), r2.out);

    H.section('IDEA 能用：调试方式起、没改直接用、改了重启、停');
    connect(true);
    const r3 = ds(['start', '--name', 'app', '--port', 'auto'].concat(cmd));
    H.ok('没写 --idea：不起，列出运行配置名，说怎么写', r3.code === 2 && /IDEA 里有运行配置："app"、"broken"/.test(r3.out) && /--idea "<运行配置名>" --port <它监听的端口>/.test(r3.out) && /--no-idea/.test(r3.out) && /ERR/.test(await get(svcPort)), r3.out);
    const r3b = ds(['start', '--name', 'app', '--idea', 'app', '--port', 'auto'].concat(cmd));
    H.ok('--idea 配 --port auto：不行，端口是运行配置定的', r3b.code === 2 && /不能写 auto/.test(r3b.out), r3b.out);
    const r4 = startIdea();
    H.ok('调试方式起来了：最后一行说是 IDEA 运行配置', r4.code === 0 && new RegExp('^起来了：app，端口 ' + svcPort + '（IDEA 运行配置"app"，调试方式起的）').test(last(r4)), r4.out);
    H.ok('"起来了"的时候已经答 HTTP（先占端口、后答话的也等到答话）', (await get(svcPort)) === 'v1');
    // 上一次 start 没等到它答 HTTP（等超时了、被打断了）：记录里没有 upAt，端口通着也不能说已经在跑
    const recF = path.join(app, '.vibe', 'run', 'app.json');
    const rj = JSON.parse(fs.readFileSync(recF, 'utf8')); delete rj.upAt; fs.writeFileSync(recF, JSON.stringify(rj));
    const r4b = startIdea();
    H.ok('记录里没有 upAt：接着等它答 HTTP，不重起', r4b.code === 0 && /app 还在启动（IDEA 运行配置"app".*端口通了，上次没等到它答 HTTP）/.test(r4b.out) && /^起来了：app/.test(last(r4b)) && !/停掉，在 IDEA 里重起/.test(r4b.out) && !!JSON.parse(fs.readFileSync(recF, 'utf8')).upAt, r4b.out);
    // 测试自己调假 IDEA 用现在源码里的客户端（拿旧版跑时旧版没有它）
    const I = require(path.join(H.SRC, 'kit', 'lib', 'idea-run.js'));
    const stats = await I.callTool(url, '__stats', {}, 5000);
    H.ok('调用开着事件流（调试方式起要 2.5 秒，不开事件流假 IDEA 1.5 秒就丢掉）', stats.ok && stats.result.streamOpened > 0, stats);
    const r5 = startIdea();
    H.ok('代码没改：直接用，不重起', r5.code === 0 && /^已经在跑：app（端口 \d+，IDEA 运行配置"app"/.test(last(r5)), r5.out);
    await touch('v2');
    const r6 = startIdea();
    H.ok('改了代码：停掉 IDEA 的会话、在 IDEA 里重起，答的是新代码', r6.code === 0 && /跑的不是现在的代码（之后改过：src\/v\.txt）：停掉，在 IDEA 里重起/.test(r6.out) && /^起来了：/.test(last(r6)) && (await get(svcPort)) === 'v2', r6.out);
    const st = ds(['status']);
    H.ok('status：说是 IDEA 起的、跑的是现在的代码', /app：在跑，端口 \d+（IDEA 运行配置"app"，调试方式起的/.test(st.out) && /跑的是现在的代码/.test(st.out), st.out);
    const r7 = ds(['stop', '--name', 'app']);
    H.ok('stop：停掉 IDEA 的会话，端口空出来', r7.code === 0 && /^停了：app，端口 \d+ 空出来了（结束了 IDEA 会话 app）/.test(last(r7)) && /ERR/.test(await get(svcPort)), r7.out);

    H.section('用户在 IDEA 里点 Run 起的（MCP 停不了）');
    const run = await I.callTool(url, 'execute_run_configuration', { projectPath: shell, configurationName: 'app', waitForExit: false }, 10000);
    for (let i = 0; i < 30 && (await get(svcPort)) !== 'v2'; i++) await H.sleep(300);
    const r8 = startIdea();
    H.ok('代码没改：直接用，说是你在 IDEA 里起的', run.ok && r8.code === 0 && /^已经在跑：端口 \d+ 上是你在 IDEA 里起的 node（PID \d+/.test(last(r8)), r8.out);
    await touch('v3');
    const r9 = startIdea();
    H.ok('改了代码：结束它、调试方式重起，说一句；答的是新代码', r9.code === 0 && /你在 IDEA 里点 Run 起的 node（PID \d+.*结束了它，在 IDEA 里用调试方式重起/.test(r9.out) && /^起来了：/.test(last(r9)) && (await get(svcPort)) === 'v3', r9.out);
    ds(['stop', '--all']);

    H.section('出错的几种');
    const r10 = ds(['start', '--name', 'app', '--idea', 'nope', '--port', String(svcPort)].concat(cmd));
    H.ok('运行配置名写错：列出有哪些', r10.code === 2 && /IDEA 里没有叫"nope"的运行配置。有："app"、"broken"/.test(r10.out), r10.out);
    const t0 = Date.now();
    const r11 = ds(['start', '--name', 'bad', '--idea', 'broken', '--port', String(svcPort), '--wait', '2'].concat(cmd));
    H.ok('IDEA 不回话（弹了编辑框）：说清去 IDEA 里看，不改用命令起', r11.code === 1 && /IDEA 没回话。多半弹出了编辑运行配置的框/.test(r11.out) && /ERR/.test(await get(svcPort)) && Date.now() - t0 < 40000, [r11.out, Date.now() - t0]);
    const other = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-idea.js'), '__service', String(svcPort), src, '0'], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 30 && /ERR/.test(await get(svcPort)); i++) await H.sleep(200);
    const r12 = startIdea();
    other.kill();
    H.ok('端口被别的程序占着（不是 IDEA 起的）：不动它', r12.code === 1 && /不是 IDEA 起的，没有动它/.test(r12.out), r12.out);

    H.section('起服务的拦截提示');
    const hook = (cwd) => H.hook(h, 'guard-commit', { session_id: 's-idea', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'mvn spring-boot:run' }, transcript_path: H.transcript(path.join(h.root, 'g.jsonl'), [H.tr.user('起一下服务测一下')]) });
    H.write(path.join(app, 'pom.xml'), '<project/>\n');
    const g1 = hook(app);
    H.ok('IDEA 能用：拦下直接起服务时提 --idea', /devserver\.js/.test(H.reasonOf(g1)) && /IDEA 连着：后端用 IDEA 里配好的运行配置起/.test(H.reasonOf(g1)), H.reasonOf(g1));
    connect(false);
    const g2 = hook(app);
    H.ok('没开 brave mode：不提 --idea', /devserver\.js/.test(H.reasonOf(g2)) && !/--idea/.test(H.reasonOf(g2)), H.reasonOf(g2));
  } finally {
    // 中途失败（比如拿旧版跑，旧版不认 --idea、照命令起了）也把 devserver 起的停掉，不留进程、临时目录删得掉
    try { ds(['stop', '--all']); } catch (e) { /* 停不了算了 */ }
    try { fake.stdin.end(); } catch (e) { /* 已经退了 */ }
    await H.sleep(500);
    try { fake.kill(); } catch (e) { /* 已经退了 */ }
  }
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('devserver --idea');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
