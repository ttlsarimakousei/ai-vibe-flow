'use strict';
/* IDEA MCP 自动登记：假 IDEA 服务、假用户目录，安装、更新、卸载都走真实入口。
 * node dev/test-idea-mcp.js [旧版 vibe-kit 目录]。旧版必须测出缺少这项功能。
 * 不启动真实 IDE，不调用模型接口，不读其他 MCP 的凭据，不在真实用户目录写文件。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');
const oldArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const claudes = process.argv.map((a, i) => a === '--claude' ? process.argv[i + 1] : null).filter(Boolean);
let from = path.resolve(oldArg || H.SRC);
if (oldArg) {
  const old = path.join(H.tempDir('idea-old'), 'vibe-kit');
  H.copyDir(from, old, n => n === 'node_modules');
  for (const n of ['playwright', 'playwright-core', 'pixelmatch', 'pngjs']) H.write(path.join(old, 'kit/page/node_modules', n, 'package.json'), '{"name":"' + n + '","version":"0.0.0-test"}');
  from = old;
}
const services = [];
async function fake(mode) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      const j = JSON.parse(raw); seen.push(j.method);
      if (mode === 'slow') return;
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.invalid/' }); res.end(); return; }
      if (mode === 'large') { res.writeHead(200); res.end('x'.repeat(300000)); return; }
      if (!Object.prototype.hasOwnProperty.call(j, 'id')) { res.writeHead(204); res.end(); return; }
      let result;
      if (j.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: mode === 'foreign' ? 'Other MCP' : 'IntelliJ IDEA MCP Server', version: '2026.2.3' } };
      else result = { tools: mode === 'empty' ? [] : [{ name: 'execute_tool', description: 'IDEA 工具路由', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] };
      const text = JSON.stringify({ jsonrpc: '2.0', id: j.id, result });
      res.writeHead(200, { 'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'test-session' });
      res.end(mode === 'sse' ? 'event: message\ndata: ' + text + '\n\n' : text);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  services.push(srv);
  return { port: srv.address().port, url: 'http://127.0.0.1:' + srv.address().port + '/stream', seen };
}
function home(name, enabled) {
  const h = H.makeHome('idea-' + name, from, { autoUpdate: 'off', issueUpload: 'off', usageReport: 'off' });
  if (enabled !== undefined) H.write(path.join(h.home, 'AppData/Roaming/JetBrains/IntelliJIdea2026.2/options/mcpServer.xml'), '<application><component name="McpServerSettings"><option name="enableMcpServer" value="' + enabled + '" /></component></application>');
  return h;
}
const file = h => path.join(h.cfg, '.claude.json');
const state = h => path.join(h.kit, 'state/idea-mcp.json');
const read = f => { try { const v = JSON.parse(H.read(f)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
const exec = (h, args, ports, env) => new Promise(resolve => {
  const p = spawn(process.execPath, args, { cwd: h.root, windowsHide: true, env: H.envFor(h, Object.assign({ VIBE_KIT_IDEA_MCP_PORTS: (ports || []).join(',') }, env || {})), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c);
  const timer = setTimeout(() => p.kill(), 30000);
  p.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, err }); });
  p.on('close', code => { clearTimeout(timer); resolve({ code, out, err, value: (() => { try { return JSON.parse(out.trim()); } catch (e) { return {}; } })() }); });
});
const check = (h, ports) => exec(h, [path.join(h.kit, 'lib/updater.js'), 'idea-check'], ports);
const install = (h, src, flags, ports) => exec(h, [path.join(src, 'install.js'), ...(flags || []), '--no-router', '--no-open'], ports);
(async () => {
  const a = await fake('sse'), b = await fake('json');
  const h = home('install', true);
  const original = { oauthAccount: { fake: 'TEST_ONLY_SECRET_42' }, projects: { '/test': { allowedTools: [] } }, mcpServers: { mine: { type: 'stdio', command: 'test', env: { TOKEN: 'TEST_ONLY_SECRET_42' } } } };
  H.write(file(h), JSON.stringify(original));
  const r = await install(h, from, [], [a.port]);
  const name = 'vibe-idea-' + a.port;
  H.ok('安装成功并明确提醒重开 Claude', r.code === 0 && /IDEA MCP 已核验.*重新打开/.test(r.out), r.out + r.err);
  H.ok('装进用户 scope 的 HTTP 登记', JSON.stringify(read(file(h)).mcpServers && read(file(h)).mcpServers[name]) === JSON.stringify({ type: 'http', url: a.url }));
  H.ok('其它 MCP、登录和项目配置原样保留', read(file(h)).oauthAccount.fake === original.oauthAccount.fake && JSON.stringify(read(file(h)).mcpServers.mine) === JSON.stringify(original.mcpServers.mine) && JSON.stringify(read(file(h)).projects) === JSON.stringify(original.projects));
  H.ok('安装输出和状态不含其它配置的秘密', !r.out.includes('TEST_ONLY_SECRET_42') && !String(H.read(state(h))).includes('TEST_ONLY_SECRET_42'));
  H.ok('只核验握手和工具列表，没有执行项目操作', a.seen.includes('tools/list') && !a.seen.includes('tools/call'));
  const sr = await install(h, h.kit, ['--sync'], [a.port]);
  H.ok('同步不重复添加登记', sr.code === 0 && Object.keys(read(file(h)).mcpServers || {}).filter(n => n.startsWith('vibe-idea-')).length === 1);
  H.ok('跨会话状态不被清理', new RegExp('idea-mcp').test(H.read(path.join(h.kit, 'lib/session.js'))) && require(path.join(h.kit, 'lib/session.js')).GLOBAL_STATE.test('idea-mcp.json'));
  const multi = await check(h, [a.port, b.port]);
  H.ok('多个 IDEA 实例分别登记', (multi.value.connections || []).length === 2 && read(file(h)).mcpServers['vibe-idea-' + b.port], multi.value);
  await check(h, [b.port]);
  H.ok('换端口后撤回失效的自有登记', !read(file(h)).mcpServers[name] && read(file(h)).mcpServers['vibe-idea-' + b.port]);
  const custom = home('custom', true);
  H.write(file(custom), JSON.stringify({ mcpServers: { jetbrains: { type: 'http', url: a.url, headers: { Test: 'TEST_ONLY_SECRET_42' } } } }));
  const c = await check(custom, [a.port]);
  H.ok('已有同地址配置不重复登记、不接管', (c.value.connections || []).length === 1 && c.value.connections[0].managed === false && Object.keys(read(file(custom)).mcpServers).length === 1);
  H.setConfig(custom, { ideaMcp: false }); await install(custom, custom.kit, ['--sync'], [a.port]);
  H.ok('关开关保留用户自己登记的连接', !!read(file(custom)).mcpServers.jetbrains);
  H.setConfig(h, { ideaMcp: false }); await install(h, h.kit, ['--sync'], [b.port]);
  H.ok('关开关收回自有连接、保留其它 MCP', Object.keys(read(file(h)).mcpServers).join(',') === 'mine' && read(state(h)).status === 'off');
  H.setConfig(h, { ideaMcp: true }); await check(h, [a.port]);
  const x = read(file(h)); x.mcpServers = x.mcpServers || {}; x.mcpServers[name] = x.mcpServers[name] || { type: 'http', url: a.url }; x.mcpServers[name].headers = { Test: 'changed' }; H.write(file(h), JSON.stringify(x)); await check(h, [a.port]);
  H.ok('用户改过登记后暂停，不覆盖 headers', read(state(h)).status === 'user-changed' && read(file(h)).mcpServers[name].headers.Test === 'changed');
  H.setConfig(h, { ideaMcp: false }); await check(h, [a.port]); H.setConfig(h, { ideaMcp: true }); await check(h, [a.port]);
  H.ok('重新打开开关可使用改过的现有登记', read(state(h)).status === 'ready' && read(file(h)).mcpServers[name].headers.Test === 'changed');
  const del = home('delete', true); await check(del, [a.port]); const d = read(file(del)); d.mcpServers = d.mcpServers || {}; delete d.mcpServers[name]; H.write(file(del), JSON.stringify(d)); await check(del, [b.port]);
  H.ok('用户删了登记，不借新端口偷偷补回来', read(state(del)).status === 'user-changed' && Object.keys(read(file(del)).mcpServers).length === 0);
  const no = home('none'); const n = await check(no, [a.port]); H.ok('没有 IDEA 设置时不探测、不新增配置', n.value.status === 'no-idea' && !fs.existsSync(file(no)));
  const noModule = fs.existsSync(path.join(no.kit, 'lib/idea-mcp.js')) ? require(path.join(no.kit, 'lib/idea-mcp.js')) : null;
  H.write(state(no), JSON.stringify({ checkedAt: Date.now() - 6 * 60000 }));
  H.ok('没有 IDEA 时不为检测启动后台进程', !!noModule && noModule.due(no.cfg) === false);
  H.write(path.join(no.home, 'AppData/Roaming/JetBrains/IntelliJIdea2026.2/options/mcpServer.xml'), '<application><component name="McpServerSettings"><option name="enableMcpServer" value="true" /></component></application>');
  H.ok('后来开启 IDEA MCP 能被下次钩子发现', !!noModule && noModule.due(no.cfg) === true);
  H.write(state(no), JSON.stringify({ checkedAt: Date.now() }));
  H.ok('已经检测过的机器按五分钟节流', !!noModule && noModule.due(no.cfg) === false);
  H.setConfig(no, { ideaMcp: false }); H.write(state(no), JSON.stringify({ checkedAt: Date.now() - 6 * 60000 }));
  H.ok('开关关闭且没有自有登记时不启动后台', !!noModule && noModule.due(no.cfg) === false);
  H.write(state(no), JSON.stringify({ checkedAt: Date.now() - 6 * 60000, owned: { [name]: { type: 'http', url: a.url } } }));
  H.ok('关闭开关后仍能重试撤回遗留登记', !!noModule && noModule.due(no.cfg) === true);
  const disabled = home('disabled', false); const di = await check(disabled, [a.port]); H.ok('未开启的 IDEA 不登记', di.value.status === 'not-enabled' && !fs.existsSync(file(disabled)));
  const closed = home('closed', true); const cl = await check(closed, []); H.ok('IDEA 关闭时不阻塞套件', cl.code === 0 && cl.value.status === 'not-running');
  for (const mode of ['foreign', 'empty', 'slow', 'redirect', 'large']) { const s = await fake(mode); const t = home(mode, true); const bad = await check(t, [s.port]); H.ok(mode + ' 回复不能被当作 IDEA 登记', bad.value.status === 'not-running' && !fs.existsSync(file(t))); }
  const broken = home('broken', true); H.write(file(broken), '{"secret":"TEST_ONLY_SECRET_42",'); const brokenRaw = H.read(file(broken)); const br = await check(broken, [a.port]);
  H.ok('配置损坏时保持原文件、输出不含原文', br.value.status === 'config-error' && H.read(file(broken)) === brokenRaw && !br.out.includes('TEST_ONLY_SECRET_42'));
  const busy = home('busy', true); H.write(path.join(busy.kit, 'state/idea-mcp.lock'), ''); const bu = await check(busy, [a.port]); H.ok('并发检查不重复写配置', bu.value.busy === true && !fs.existsSync(file(busy)));
  const standard = home('standard', true);
  const std = await exec(standard, [path.join(standard.kit, 'lib/updater.js'), 'idea-check'], [a.port], { CLAUDE_CONFIG_DIR: undefined });
  H.ok('未设配置目录时写用户目录的 .claude.json', std.value.status === 'ready' && !!(read(path.join(standard.home, '.claude.json')).mcpServers || {})[name] && !fs.existsSync(file(standard)));
  await exec(standard, [path.join(standard.kit, 'lib/updater.js'), 'idea-check'], [a.port]);
  H.ok('后台传入配置目录仍沿用安装时选定的文件', !fs.existsSync(file(standard)));
  const api = require(path.join(H.SRC, 'router/kit-api.js'));
  const view = await api.handle('GET', '/api/kit', null, custom.kit);
  H.ok('配置页返回连接状态，不返回其它 MCP 凭据', view.ideaMcp && !JSON.stringify(view).includes('TEST_ONLY_SECRET_42'));
  const background = home('background', true); const up = await exec(background, [path.join(background.kit, 'lib/updater.js'), 'run', '--print'], [a.port]);
  H.ok('自动更新和上报都关着也能后台接上', up.code === 0 && up.value.ideaMcp && up.value.ideaMcp.status === 'ready');
  const removal = await install(background, background.kit, ['--uninstall'], []);
  H.ok('卸载只撤回套件登记', removal.code === 0 && !(read(file(background)).mcpServers || {})[name]);
  const brokenRemove = home('broken-remove', true); await install(brokenRemove, from, [], [a.port]);
  H.write(file(brokenRemove), '{"invalid":');
  const brokenResult = await install(brokenRemove, brokenRemove.kit, ['--uninstall'], []);
  H.ok('卸载遇到损坏的 MCP 配置保留原文并明确提示', brokenResult.code === 0 && H.read(file(brokenRemove)) === '{"invalid":' && brokenResult.out.includes('MCP 登记没能收回'));
  const defaultCfg = require(path.join(h.kit, 'lib/session.js')).DEFAULT_CONFIG;
  H.ok('默认自动接入且后端默认一致', defaultCfg.ideaMcp === true && api.DEFAULT_CONFIG.ideaMcp === true);
  H.ok('配置仅接受布尔值', api.cleanConfig({ ideaMcp: false }).ideaMcp === false && api.cleanConfig({ ideaMcp: 'false' }).ideaMcp === true);
  const ui = H.read(path.join(H.SRC, 'router/ui.html'));
  H.ok('本机环境页有开关、状态和手动检测', /id="k_ideaMcp"/.test(ui) && /id="ideaCheck"/.test(ui) && /renderIdea\(fresh.ideaMcp\)/.test(ui));
  H.ok('没往全局约定加入 MCP 长提示', !H.read(path.join(H.SRC, 'claude/CLAUDE.md')).includes('IDEA MCP'));
  if (from === H.SRC) {
    const P = require('./probes/common');
    for (const v of claudes) {
      const exe = P.exeOf(v);
      const loaded = await P.runFor(exe, ['mcp', 'get', name], { cwd: h.root, env: H.envFor(h, { DISABLE_AUTOUPDATER: '1' }) }, 20);
      H.ok('Claude Code ' + v + ' 识别用户级 HTTP 登记', loaded.code === 0 && loaded.out.includes(a.url), loaded.err);
    }
    const pageHome = home('page', true);
    H.copyDir(path.join(H.SRC, 'router'), path.join(pageHome.kit, 'router'));
    const port = 18719;
    H.write(path.join(pageHome.kit, 'router-data/config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }));
    H.write(path.join(pageHome.cfg, 'settings.json'), '{}');
    const router = spawn(process.execPath, [path.join(pageHome.kit, 'router/router.js'), '-c', path.join(pageHome.kit, 'router-data/config.json'), '-p', String(port)], { cwd: pageHome.root, windowsHide: true, stdio: 'ignore', env: H.envFor(pageHome, { VIBE_KIT_IDEA_MCP_PORTS: String(a.port) }) });
    let browser;
    try {
      for (let i = 0; i < 40; i++) { try { const r = await H.httpGet('http://127.0.0.1:' + port + '/health'); if (r.code === 200 || r.status === 200) break; } catch (e) { /* 正在启动 */ } await H.sleep(100); }
      const launched = await require(path.join(H.SRC, 'kit/page/browser.js')).launchBrowser({}); browser = launched.browser;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' }); const page = await ctx.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:' + port + '/ui'); await page.locator('[data-tab="local"]').click();
      await page.locator('#ideaCheck').click(); await page.waitForFunction(() => document.getElementById('ideaStatus').textContent.includes('已核验'));
      H.ok('页面手动检测可显示地址和归属', (await page.locator('#ideaConnections').innerText()).includes(a.url));
      await page.locator('#k_ideaMcp').uncheck(); await page.locator('#barSave').click(); await page.waitForFunction(() => document.getElementById('ideaStatus').textContent.includes('关掉'));
      H.ok('本机环境开关走保存条并收回自有登记', read(path.join(pageHome.kit, 'config.json')).ideaMcp === false && !Object.keys(read(file(pageHome)).mcpServers || {}).length);
      await page.locator('#k_ideaMcp').check(); await page.locator('#barSave').click(); await page.waitForFunction(() => document.getElementById('ideaStatus').textContent.includes('已核验'));
      H.ok('页面重新开启后恢复登记', !!(read(file(pageHome)).mcpServers || {})[name]);
      H.ok('新卡片和保存流程没有脚本错误', errors.length === 0, errors);
    } finally { if (browser) await browser.close(); router.kill(); await new Promise(r => router.exitCode !== null ? r() : router.once('close', r)); }
  }
  for (const srv of services) { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
  H.done('IDEA MCP 自动接入');
})().catch(async e => { console.log(e.stack); for (const srv of services) { srv.closeAllConnections(); srv.close(); } H.cleanup(); process.exit(2); });
