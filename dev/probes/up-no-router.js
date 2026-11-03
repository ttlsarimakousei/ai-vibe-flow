'use strict';
/*
 * 探测：真装着旧路由（20261102.2248，带开机自启、真进程）的电脑升到这一版。假用户目录，路由起在测试端口。
 *   自动更新（VIBE_KIT_AUTO_UPDATE）：装完路由、key 都还在（自检不过装回旧版要用）；新代码第一次跑 session-start 才收
 *   手动安装：装完当场收
 * 用法：node dev/probes/up-no-router.js [旧版本号，默认 20261102.2248] [端口，默认 18810]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('../lib/harness');

const OLD = process.argv[2] || '20261102.2248';
const PORT = Number(process.argv[3]) || 18810;
const up = (port) => new Promise((resolve) => { const q = http.get({ host: '127.0.0.1', port, path: '/version', agent: false, timeout: 1500 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }); q.on('error', () => resolve('')); q.on('timeout', () => { q.destroy(); resolve(''); }); });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const hooksOf = (u) => Object.values(readJson(path.join(u.cfg, 'settings.json')).hooks || {}).flat().flatMap((g) => (g && g.hooks) || []);

function oldPackage(name) {
  const d = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(H.baselineDir(OLD), d, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(d);
  return d;
}
/** 装上旧版，路由真跑着，配置页点过"接上" */
async function oldMachine(name, port) {
  const u = H.freshHome(name);
  H.write(path.join(u.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-FAKE-KEY-0123456789' }], routes: [], default: { provider: 'gw' }, failover: [] }));
  const inst = H.node(u, path.join(oldPackage(name + '-pkg'), 'install.js'), ['--no-open'], { cwd: u.root, timeout: 300000, env: { VIBE_KIT_NO_UPDATE: '1' } });
  H.ok('（' + name + ' 装上了 ' + OLD + '）', inst.code === 0, inst.out.slice(-500));
  let v = '';
  for (let i = 0; i < 40 && !v; i++) { await H.sleep(250); v = await up(port); }
  H.ok('（旧路由真跑着）', !!v, v);
  H.ok('（开机自启写了）', fs.existsSync(path.join(u.home, 'Startup', 'vibe-kit-router.vbs')));
  H.ok('（钩子走 HTTP）', hooksOf(u).some((x) => x.type === 'http'), hooksOf(u).map((x) => x.type));
  const sf = path.join(u.cfg, 'settings.json');
  const st = readJson(sf); st.env = Object.assign({}, st.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'vibe-kit-router' });
  fs.writeFileSync(sf, JSON.stringify(st, null, 2));
  H.write(path.join(u.kit, 'router-data', 'claude-link.json'), JSON.stringify({ prevBaseUrl: 'https://gw.example/v1' }));
  return u;
}
function gone(u, port, notes) {
  const st = readJson(path.join(u.cfg, 'settings.json'));
  H.ok('router/、router-data/（key）都没了', !fs.existsSync(path.join(u.kit, 'router')) && !fs.existsSync(path.join(u.kit, 'router-data')), fs.readdirSync(u.kit));
  H.ok('开机自启撤了（旧版写的 UTF-16）', !fs.existsSync(path.join(u.home, 'Startup', 'vibe-kit-router.vbs')));
  H.ok('连回接上之前的地址', st.env.ANTHROPIC_BASE_URL === 'https://gw.example/v1' && st.env.ANTHROPIC_AUTH_TOKEN === undefined, st.env);
  H.ok('钩子全走命令，没有 guard-push', hooksOf(u).length > 0 && hooksOf(u).every((x) => x.type === 'command') && !hooksOf(u).some((x) => /guard-push/.test(String(x.command))), hooksOf(u).filter((x) => x.type !== 'command'));
  H.ok('令牌保护的 deny 还在', (st.permissions.deny || []).some((x) => /router-data/.test(x)), st.permissions.deny);
  H.ok('输出里没有 key', !/sk-FAKE-KEY/.test(notes), notes.slice(0, 200));
}

(async () => {
  const pkg = H.makePackage('unr-new', '20261104.2359');
  const watch = await H.watchWindows('unr-win');

  H.section('自动更新：装完都还在，新代码第一次跑 session-start 才收');
  {
    const u = await oldMachine('unr-auto', PORT);
    const inst = H.node(u, path.join(pkg, 'install.js'), ['--no-open', '--no-router'], { cwd: u.root, timeout: 300000, env: { VIBE_KIT_AUTO_UPDATE: '1', VIBE_KIT_NO_UPDATE: '1' } });
    H.ok('新版装上了', inst.code === 0 && /20261104\.2359/.test(H.read(path.join(u.kit, 'VERSION')) || ''), inst.out.slice(-500));
    H.ok('装完路由还在跑、key 还在（自检不过要装回旧版）', !!(await up(PORT)) && fs.existsSync(path.join(u.kit, 'router-data', 'config.json')));
    const r = H.node(u, path.join(u.kit, 'hooks', 'session-start.js'), [], { cwd: u.root, timeout: 60000, env: { VIBE_KIT_NO_UPDATE: '1' }, input: JSON.stringify({ session_id: 's-unr', cwd: u.root, hook_event_name: 'SessionStart', source: 'startup' }) });
    H.ok('会话开始说了收回', /模型路由/.test(r.out), r.out.slice(0, 400) + r.err);
    await H.sleep(500);
    H.ok('路由进程停了', !(await up(PORT)));
    gone(u, PORT, r.out + r.err);
  }

  H.section('手动安装：装完当场收');
  {
    const u = await oldMachine('unr-manual', PORT + 1);
    const inst = H.node(u, path.join(pkg, 'install.js'), ['--no-open'], { cwd: u.root, timeout: 300000, env: { VIBE_KIT_NO_UPDATE: '1' } });
    H.ok('新版装上了', inst.code === 0, inst.out.slice(-500));
    await H.sleep(500);
    H.ok('路由进程停了', !(await up(PORT + 1)));
    gone(u, PORT + 1, inst.out + inst.err);
  }
  const wins = await watch.stop();
  H.ok('桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('真装着旧路由的电脑升级');
})().catch((e) => { H.ok('测试异常', false, e && e.stack); H.done('真装着旧路由的电脑升级'); });
