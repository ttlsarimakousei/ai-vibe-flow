'use strict';
/*
 * 11-01 这一批里路由的几项（docs/feedback-20261101.md）：
 *   K1-1 路由拆成几个文件：router.js 留入口，引到的文件都在、都在打包的必备清单里，入口里还认得钩子请求
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

  H.done('11-01 路由（K1-1 拆分、E1 安装标识、E3 断在半截）');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
