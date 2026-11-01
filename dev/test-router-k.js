'use strict';
/*
 * 11-01 这一批里路由的几项（docs/feedback-20261101.md）：
 *   K1-1 路由拆成几个文件：router.js 留入口，引到的文件都在、都在打包的必备清单里，入口里还认得钩子请求
 *   E1   远程桌面多人共用一台电脑：/version 带本安装的标识，service.js 认出别的安装的路由，不停、不当成自己的、说清端口被占；
 *        老版本的路由（不带标识）照以前的规矩处理，新旧 service.js 和新旧路由互相停得掉、起得来
 * 用法：node dev/test-router-k.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 * 只起本机的假网关、临时端口上的路由，key 是假的；家目录、APPDATA、"启动"文件夹都指假的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? path.resolve(process.argv[2]) : null;
const SRCV = FROM || H.SRC;
// 拆分、E1 之前的那一版：兼容的几项拿它当"老版本"
const OLD = path.join(__dirname, 'baseline', '20261031.1436', 'vibe-kit');

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function getJson(port, url) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: url, timeout: 2000, agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, json: null, text: '' }));
  });
}
/** 一份装了路由的假用户目录：套件、路由程序（从 from 拷）、路由的配置（端口 port，没有模型） */
function install(tag, from, port) {
  const h = H.makeHome(tag, FROM);
  H.copyDir(path.join(from, 'router'), path.join(h.kit, 'router'));
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
  return h;
}
/** 换掉路由程序目录（装新版、装回老版本时 install.js 就是整个换） */
function swapRouter(h, from) {
  fs.rmSync(path.join(h.kit, 'router'), { recursive: true, force: true });
  H.copyDir(path.join(from, 'router'), path.join(h.kit, 'router'));
}
const svc = (h, cmd) => H.node(h, path.join(h.kit, 'router', 'service.js'), [cmd], { cwd: h.root, timeout: 60000 });

(async () => {
  H.section('K1-1 路由拆成几个文件：引到的文件都在、都在打包的必备清单里，入口还是 router.js');
  {
    const dir = path.join(SRCV, 'router');
    const pack = H.read(path.join(H.REPO, 'dev', 'pack.js')) || '';
    const local = new Set();
    const walk = (f) => { for (const m of (H.read(path.join(dir, f)) || '').matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) { const n = m[1] + '.js'; if (!local.has(n)) { local.add(n); walk(n); } } };
    walk('router.js');
    walk('service.js');
    // 配置页里套件那几页的后端：没有它路由也能单独用（try 着载），不算必备
    local.delete('kit-api.js');
    H.ok('router.js、service.js 引到的文件都在', [...local].every((n) => fs.existsSync(path.join(dir, n))), [...local]);
    H.ok('都在 dev/pack.js 的必备清单里（漏打进包路由就起不来）', [...local].every((n) => pack.includes("'router/" + n + "'")), [...local].filter((n) => !pack.includes("'router/" + n + "'")));
    // install.js 按 router.js 里有没有 /vibe-kit/hook/ 判断这个路由认不认得钩子请求（--no-router 时留着的可能是老版本）
    H.ok('入口 router.js 里还有钩子入口的路径（安装器靠它判断能不能走 HTTP 钩子）', (H.read(path.join(dir, 'router.js')) || '').includes('/vibe-kit/hook/'));
  }

  H.section('E1 远程桌面多人共用一台电脑：端口上是别的安装的路由，不停它、不当成自己的，说清端口被占');
  {
    const port = await freePort();
    const A = install('trk-e1a', SRCV, port);
    const B = install('trk-e1b', SRCV, port);
    try {
      const a1 = svc(A, 'start');
      H.ok('（甲的路由起来了）', a1.code === 0, a1.out + a1.err);
      const v1 = await getJson(port, '/version');
      const id = v1.json && v1.json.install;
      H.ok('/version 带着这份安装的标识（16 位十六进制）', typeof id === 'string' && /^[0-9a-f]{16}$/.test(id), v1.text);
      const user = String((os.userInfo() || {}).username || '').toLowerCase();
      H.ok('/version 里没有用户名、路径原文', !!v1.text && !/vkt-|home|users|\\|\//i.test(v1.text) && !(user.length > 2 && v1.text.toLowerCase().includes(user)), v1.text);
      const b1 = svc(B, 'stop');
      const v2 = await getJson(port, '/version');
      H.ok('乙停路由：甲的路由照常在跑（没被停掉）', v2.status === 200 && !!v2.json && v2.json.install === id, [b1.out, v2.status]);
      H.ok('乙停路由：说清端口被另一个安装的路由占着、没有停它', b1.code === 0 && new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b1.out), [b1.code, b1.out]);
      const b2 = svc(B, 'start');
      H.ok('乙起路由：不当成自己的"本来就在运行"，退出码 1、说清端口被占', b2.code === 1 && new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b2.out), [b2.code, b2.out]);
      const b3 = svc(B, 'status');
      H.ok('乙看状态：说端口被另一个安装的路由占着', new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b3.out), b3.out);
      const v3 = await getJson(port, '/version');
      H.ok('乙这几下之后甲的路由还是原来那个', v3.status === 200 && !!v3.json && !!id && v3.json.install === id, v3.text);
      const a2 = svc(A, 'stop');
      const v4 = await getJson(port, '/version');
      H.ok('甲自己停：停得掉', a2.code === 0 && /已停止/.test(a2.out) && v4.status === 0, [a2.out, v4.status]);
    } finally { svc(A, 'stop'); svc(B, 'stop'); }
  }

  H.section('E1 兼容：老版本的路由不带标识，照以前的规矩当成自己的（自动更新时新版的 service.js 要停得掉它）');
  {
    const port = await freePort();
    const C = install('trk-e1c', OLD, port);
    try {
      const s = svc(C, 'start');
      H.ok('（老版本的路由起来了）', s.code === 0, s.out + s.err);
      swapRouter(C, SRCV);
      const st = svc(C, 'stop');
      const v = await getJson(port, '/version');
      H.ok('新版的 service.js 停得掉老版本的路由', st.code === 0 && /已停止/.test(st.out) && v.status === 0, [st.out, v.status]);
    } finally { svc(C, 'stop'); }
  }

  H.section('E1 兼容：装回老版本时老的 service.js 停得掉新路由；老的 service.js 起新的 router.js 也认（入口、参数没变）');
  {
    const port = await freePort();
    const D = install('trk-e1d', SRCV, port);
    try {
      const s = svc(D, 'start');
      H.ok('（新路由起来了）', s.code === 0, s.out + s.err);
      swapRouter(D, OLD);
      const st = svc(D, 'stop');
      const v = await getJson(port, '/version');
      H.ok('老版本的 service.js 停得掉新路由', st.code === 0 && /已停止/.test(st.out) && v.status === 0, [st.out, v.status]);
      // 程序目录是新的，只有 service.js 是老的：自动更新之后还在跑的老进程、老的自启动脚本拉起新路由就是这样
      swapRouter(D, SRCV);
      fs.copyFileSync(path.join(OLD, 'router', 'service.js'), path.join(D.kit, 'router', 'service.js'));
      const s2 = svc(D, 'start');
      const v2 = await getJson(port, '/version');
      H.ok('老的 service.js 起新的 router.js：起得来、认得出', s2.code === 0 && /已在后台启动/.test(s2.out) && v2.status === 200, [s2.out, v2.text]);
      const st2 = svc(D, 'stop');
      H.ok('老的 service.js 再停掉它', st2.code === 0 && /已停止/.test(st2.out), st2.out);
    } finally { svc(D, 'stop'); }
  }

  H.done('11-01 路由（K1-1 拆分、E1 安装标识、E3 断在半截）');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
