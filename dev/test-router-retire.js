'use strict';
/*
 * 升级时收回模型路由（第 39 条）：不留守，key 一起删；自检过了才动。每种现场一个假用户目录。
 * 用法：node dev/test-router-retire.js [旧版套件目录]（2248 没有 router-retire.js，跑不过）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2];
const PORT = 18791;
function scene(name, o) {
  const h = H.makeHome('retire-' + name, FROM);
  const data = path.join(h.kit, 'router-data');
  H.write(path.join(h.kit, 'router', 'router.js'), '// 路由\n');
  H.write(path.join(h.kit, 'router', 'service.js'), '// 后台管理\n');
  H.write(path.join(data, 'config.json'), JSON.stringify({ listen: { port: PORT }, providers: [{ name: 'a', api_key: 'FAKE-KEY' }] }));
  H.write(path.join(data, 'usage-daily.json'), '{}');
  H.write(path.join(data, 'backups', 'config-1.json'), '{"api_key":"FAKE-KEY"}');
  if (o.memo !== undefined) H.write(path.join(data, 'claude-link.json'), JSON.stringify(o.memo));
  const st = { env: o.url ? { ANTHROPIC_BASE_URL: o.url, ANTHROPIC_AUTH_TOKEN: 'vibe-kit-router' } : {}, permissions: { deny: ['Read(~/.claude/vibe-kit/router-data/**)', 'Read(~/.claude/vibe-kit/secrets.json)'] } };
  H.write(path.join(h.cfg, 'settings.json'), JSON.stringify(st, null, 2));
  H.write(path.join(h.kit, 'config.json'), JSON.stringify({ statusUsage: 'tokens', hookTransport: 'http', reviewExecutor: 'agent', reviewMaxFiles: 30, reviewLoop: true, applyReviewMaxRounds: 5, tmpKeepDays: 9 }));
  H.write(path.join(h.kit, 'installed.json'), JSON.stringify({ router: true, autostart: true, allow: [] }));
  for (const n of ['hook-stats.json', 'hook-miss.json', 'gateway.json', 'idea-mcp.json', 'idea-mcp.lock']) H.write(path.join(h.kit, 'state', n), '{}');
  const startup = path.join(h.root, 'Startup');
  if (o.vbs) H.write(path.join(startup, 'vibe-kit-router.vbs'), o.vbs === 'mine' ? 'CreateObject("WScript.Shell").Run "node ""' + path.join(h.kit, 'router', 'router.js') + '""", 0\n' : 'CreateObject("WScript.Shell").Run "node ""D:\\别人的\\router\\router.js""", 0\n');
  if (o.modelRouter) H.write(path.join(h.cfg, 'model-router', 'router.js'), o.modelRouter);
  process.env.VIBE_KIT_STARTUP_DIR = startup;
  return { h, data, startup, Rt: require(path.join(h.kit, 'lib', 'router-retire.js')) };
}
const setOf = (h) => JSON.parse(H.read(path.join(h.cfg, 'settings.json')));
const cfgOf = (h) => JSON.parse(H.read(path.join(h.kit, 'config.json')));

/** 假路由：/internal/shutdown 带对令牌才退出 */
function fakeRouter(port, token) {
  const code = "const http=require('http');http.createServer((q,s)=>{if(q.url==='/internal/shutdown'&&q.headers['x-vibe-token']===process.argv[1]){s.end('{}');setTimeout(()=>process.exit(0),50);return;}s.statusCode=403;s.end('no');}).listen(Number(process.argv[2]),'127.0.0.1');";
  const p = spawn(process.execPath, ['-e', code, token, String(port)], { stdio: 'ignore', windowsHide: true });
  return p;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

(async () => {
  H.section('配置页"接上"过：恢复原地址，都删干净');
  {
    const { h, data, startup, Rt } = scene('full', { url: 'http://127.0.0.1:' + PORT, memo: { prevBaseUrl: 'https://gw.example/v1' }, vbs: 'mine', modelRouter: "const VERSION = '3.1';\n" });
    H.ok('有要收的', Rt.pending());
    const r = await Rt.run();
    H.ok('收完了', r.done && !r.errors.length, r);
    H.ok('Claude Code 连回原地址，占位 token 去掉', setOf(h).env.ANTHROPIC_BASE_URL === 'https://gw.example/v1' && setOf(h).env.ANTHROPIC_AUTH_TOKEN === undefined, setOf(h).env);
    H.ok('router/、router-data/（key、用量、备份）都没了', !fs.existsSync(path.join(h.kit, 'router')) && !fs.existsSync(data));
    H.ok('开机自启撤了', !fs.existsSync(path.join(startup, 'vibe-kit-router.vbs')));
    H.ok('~/.claude/model-router（上一代路由）删了', !fs.existsSync(path.join(h.cfg, 'model-router')));
    for (const n of ['hook-stats.json', 'hook-miss.json', 'gateway.json', 'idea-mcp.json', 'idea-mcp.lock']) H.ok('状态文件没了：' + n, !fs.existsSync(path.join(h.kit, 'state', n)));
    const c = cfgOf(h);
    H.ok('旧开关清了，别的开关还在', c.tmpKeepDays === 9 && !('statusUsage' in c) && !('hookTransport' in c) && !('reviewExecutor' in c) && !('reviewMaxFiles' in c) && !('reviewLoop' in c) && !('applyReviewMaxRounds' in c), c);
    const man = JSON.parse(H.read(path.join(h.kit, 'installed.json')));
    H.ok('安装记录：不再有路由', man.router === false && !('autostart' in man), man);
    H.ok('令牌保护的 deny 规则留着（只能收紧）', setOf(h).permissions.deny.length === 2, setOf(h).permissions);
    H.ok('再跑一次：什么都不做', !Rt.pending() && (await Rt.run()).done);
    H.ok('说的话里没有 key', !/FAKE-KEY/.test(JSON.stringify(r)), r);
  }

  H.section('没有接上之前的地址：不动 settings，说一句');
  {
    const { h, Rt } = scene('nomemo', { url: 'http://127.0.0.1:' + PORT });
    const r = await Rt.run();
    H.ok('settings 没动', setOf(h).env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:' + PORT, setOf(h).env);
    H.ok('说了一句，说了用 cch 切', r.notes.some((n) => /cch/.test(n)), r.notes);
    H.ok('路由照删', !fs.existsSync(path.join(h.kit, 'router')));
    const e = scene('empty', { url: 'http://127.0.0.1:' + PORT, memo: { prevBaseUrl: '' } });
    await e.Rt.run();
    H.ok('原地址是空的：也不动', setOf(e.h).env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:' + PORT);
    const g = scene('gw', { url: 'https://gw.example/v1' });
    await g.Rt.run();
    H.ok('已经提前切走（指着别的地址）：不动', setOf(g.h).env.ANTHROPIC_BASE_URL === 'https://gw.example/v1' && setOf(g.h).env.ANTHROPIC_AUTH_TOKEN === 'vibe-kit-router', setOf(g.h).env);
  }

  H.section('进程：自己的停，别人的不停');
  {
    const { h, data, Rt } = scene('proc', {});
    const p = fakeRouter(PORT, 'tok');
    await H.sleep(600);
    H.write(path.join(data, 'router.pid'), JSON.stringify({ pid: p.pid, port: PORT, token: 'tok' }));
    const r = await Rt.run();
    await H.sleep(300);
    H.ok('令牌对：请它退出了', !alive(p.pid) && r.notes.some((n) => /停了/.test(n)), r);
    void h;
    const q = fakeRouter(PORT + 1, 'other');
    await H.sleep(600);
    const o = scene('foreign', {});
    H.write(path.join(o.data, 'router.pid'), JSON.stringify({ pid: q.pid, port: PORT + 1, token: 'mine' }));
    const r2 = await o.Rt.run();
    H.ok('令牌不对：不停，只收自己的文件', alive(q.pid) && r2.done && r2.notes.some((n) => /没有停/.test(n)), r2);
    try { q.kill(); } catch (e) { /* 已经退了 */ }
  }

  H.section('别人的东西不动');
  {
    const a = scene('other-vbs', { vbs: 'other' });
    await a.Rt.run();
    H.ok('"启动"文件夹里别的安装的 .vbs 不动', fs.existsSync(path.join(a.startup, 'vibe-kit-router.vbs')));
    const b = scene('other-mr', { modelRouter: '// 用户自己的东西\n' });
    await b.Rt.run();
    H.ok('~/.claude/model-router 认不出是套件的：不动', fs.existsSync(path.join(b.h.cfg, 'model-router', 'router.js')));
  }

  H.section('载入没有副作用');
  {
    const a = scene('load', {});
    H.ok('require 不动文件（旧更新器自检时载入）', fs.existsSync(path.join(a.h.kit, 'router')) && fs.existsSync(a.data));
  }

  delete process.env.VIBE_KIT_STARTUP_DIR;
  H.done('收回模型路由');
})().catch((e) => { H.ok('测试异常', false, e.stack); H.done('收回模型路由'); });
