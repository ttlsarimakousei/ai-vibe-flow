'use strict';
/* IDEA MCP 接入撤掉（用户 2026-10-28 定的）：装新版、卸载时把套件以前登记的 vibe-idea-<端口> 撤掉，用户自己登记的、改过的不动；
 * 不再登记、不再后台探测，配置页后端不再返回 IDEA 状态。假用户目录，安装、卸载都走真实入口。
 * node dev/test-idea-mcp.js [旧版 vibe-kit 目录]。旧版会照旧登记、不撤，必须测出不过。
 * 不启动真实 IDE，不调用模型接口，不在真实用户目录写文件。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');
const oldArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
let from = path.resolve(oldArg || H.SRC);
if (oldArg) {
  const old = path.join(H.tempDir('idea-old'), 'vibe-kit');
  H.copyDir(from, old, n => n === 'node_modules');
  for (const n of ['playwright', 'playwright-core', 'pixelmatch', 'pngjs']) H.write(path.join(old, 'kit/page/node_modules', n, 'package.json'), '{"name":"' + n + '","version":"0.0.0-test"}');
  from = old;
}
const URL1 = 'http://127.0.0.1:64342/stream';
const URL2 = 'http://127.0.0.1:64343/stream';
function home(name) {
  const h = H.makeHome('idea-' + name, from, { autoUpdate: 'off', issueUpload: 'off', usageReport: 'off' });
  // IDEA 开着 MCP：旧版会去登记（探测端口指到一个没人听的端口，不连真的 IDEA）
  H.write(path.join(h.home, 'AppData/Roaming/JetBrains/IntelliJIdea2026.2/options/mcpServer.xml'), '<application><component name="McpServerSettings"><option name="enableMcpServer" value="true" /></component></application>');
  return h;
}
const file = h => path.join(h.cfg, '.claude.json');
const state = h => path.join(h.kit, 'state/idea-mcp.json');
const read = f => { try { const v = JSON.parse(H.read(f)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
const exec = (h, args) => new Promise(resolve => {
  const p = spawn(process.execPath, args, { cwd: h.root, windowsHide: true, env: H.envFor(h, { VIBE_KIT_IDEA_MCP_PORTS: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c);
  const timer = setTimeout(() => p.kill(), 60000);
  p.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, err }); });
  p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
});
const install = (h, flags) => exec(h, [path.join(from, 'install.js'), ...(flags || []), '--no-router', '--no-open']);
// 以前的版本登记过：状态里记着套件加的，用户配置里有这一项
function registered(h, servers, owned) {
  H.write(file(h), JSON.stringify({ numStartups: 3, mcpServers: servers }, null, 2));
  H.write(state(h), JSON.stringify({ status: 'ready', clientFile: file(h), owned, connections: Object.keys(owned).map(n => ({ name: n, url: owned[n].url })) }, null, 2));
}
(async () => {
  H.section('装新版：套件登记的撤掉，用户的不动');
  {
    const h = home('retract');
    registered(h, { 'vibe-idea-64342': { type: 'http', url: URL1 }, jetbrains: { type: 'http', url: URL2 }, other: { type: 'stdio', command: 'x' } }, { 'vibe-idea-64342': { type: 'http', url: URL1 } });
    const r = await install(h);
    const c = read(file(h));
    H.ok('安装成功', r.code === 0, r.out.slice(-600) + r.err);
    H.ok('套件登记的 vibe-idea-64342 撤掉了', !c.mcpServers['vibe-idea-64342'], c.mcpServers);
    H.ok('用户自己登记的 jetbrains、别的 MCP 原样留着', c.mcpServers.jetbrains && c.mcpServers.jetbrains.url === URL2 && c.mcpServers.other && c.mcpServers.other.command === 'x' && c.numStartups === 3, c);
    H.ok('安装输出说撤掉了', /不再接 IDEA 的 MCP[\s\S]*vibe-idea-64342/.test(r.out), r.out.slice(-800));
    const s = read(state(h));
    H.ok('状态记成 off，不再记着套件加的登记', s.status === 'off' && !s.owned, s);
    const again = await install(h);
    H.ok('再装一次不再提 IDEA', again.code === 0 && !/IDEA/.test(again.out), again.out.slice(-800));
    H.ok('新版不再有 lib/idea-run.js（旧版留下的装新版时删掉）', !fs.existsSync(path.join(h.kit, 'lib/idea-run.js')));
  }

  H.section('用户改过套件登记的那一项：不动，说一句');
  {
    const h = home('changed');
    registered(h, { 'vibe-idea-64342': { type: 'http', url: URL1, headers: { 'X-User': 'mine' } } }, { 'vibe-idea-64342': { type: 'http', url: URL1 } });
    const r = await install(h);
    const c = read(file(h));
    H.ok('改过的留着', c.mcpServers['vibe-idea-64342'] && c.mcpServers['vibe-idea-64342'].headers, c.mcpServers);
    H.ok('安装输出说留着没动', /你改过，留着没动/.test(r.out), r.out.slice(-800));
  }

  H.section('从没登记过：不碰用户配置');
  {
    const h = home('none');
    const r = await install(h);
    H.ok('安装成功、没有建 .claude.json', r.code === 0 && !fs.existsSync(file(h)), r.out.slice(-400));
    H.ok('不提 IDEA', !/IDEA/.test(r.out), r.out.slice(-800));
  }

  H.section('用户配置解析不了：不改，下次再撤');
  {
    const h = home('broken');
    registered(h, {}, { 'vibe-idea-64342': { type: 'http', url: URL1 } });
    H.write(file(h), '{ 坏了');
    const r = await install(h);
    H.ok('安装照常成功', r.code === 0, r.err);
    H.ok('坏的用户配置原样没动', H.read(file(h)) === '{ 坏了');
    H.ok('还记着套件加的登记，下次再撤', !!read(state(h)).owned, read(state(h)));
    H.ok('安装输出说没撤成', /没撤成/.test(r.out), r.out.slice(-600));
  }

  H.section('卸载也撤');
  {
    const h = home('uninstall');
    const first = await install(h);
    registered(h, { 'vibe-idea-64342': { type: 'http', url: URL1 } }, { 'vibe-idea-64342': { type: 'http', url: URL1 } });
    const r = await exec(h, [path.join(h.kit, 'install.js'), '--uninstall']);
    H.ok('卸载撤掉了套件登记', first.code === 0 && r.code === 0 && !read(file(h)).mcpServers['vibe-idea-64342'], r.out.slice(-600));
  }

  H.section('不再后台探测、配置页后端不再给 IDEA 状态');
  {
    const h = home('nocheck');
    const m = require(path.join(h.kit, 'lib/idea-mcp.js'));
    H.ok('due() 恒为 false：后台不为 IDEA 起进程', m.due() === false);
    const u = H.read(path.join(h.kit, 'lib/updater.js')) || '';
    H.ok('自动更新不再有 idea-check', !/idea-check|idea-mcp/.test(u));
    const api = H.read(path.join(from, 'router/kit-api.js')) || '';
    H.ok('配置页后端不再有 IDEA 接口和 ideaMcp 开关', !/idea\/check|ideaMcp/.test(api));
    const cfg = require(path.join(h.kit, 'lib/session.js')).DEFAULT_CONFIG;
    H.ok('默认开关里没有 ideaMcp', !Object.prototype.hasOwnProperty.call(cfg, 'ideaMcp'));
  }
  H.done('IDEA MCP 接入撤掉');
})().catch(e => { console.error(e); process.exit(1); });
