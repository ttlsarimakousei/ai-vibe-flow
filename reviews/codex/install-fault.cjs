'use strict';
// 只在假安装包注入路由启动失败，核对安装退出码和安装后自检；不调用更新网络入口。
const fs = require('fs');
const path = require('path');
const net = require('net');
const H = require('../../dev/lib/harness');
(async () => {
  const h = H.freshHome('codex-round3-install');
  fs.mkdirSync(h.work, { recursive: true });
  const pkg = H.makePackage('codex-round3-package', '20261028.2041', p => {
    H.write(path.join(p, 'router/router.js'), "'use strict'; throw new Error('审核注入：路由启动即失败');\n");
  });
  const reserve = net.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  H.write(path.join(h.kit, 'router-data/config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [] }));
  const installed = H.node(h, path.join(pkg, 'install.js'), ['--no-open'], { cwd: h.work, timeout: 60000 });
  H.ok('G04 安装输出确实报告路由启动失败', /\[X\] 模型路由没启动/.test(installed.out), installed.err);
  const inspected = H.node(h, '-e', ['const u=require(' + JSON.stringify(path.join(h.kit, 'lib/updater')) + ');console.log(JSON.stringify(u.selfCheck()));'], { cwd: h.work });
  const check = inspected.code === 0 ? JSON.parse(inspected.out.trim()) : { ok: false };
  const observation = { installerExit: installed.code, routerFailureReported: /\[X\] 模型路由没启动/.test(installed.out), selfCheckOk: check.ok, routerEntryIsFaultFixture: fs.readFileSync(path.join(h.kit, 'router/router.js'), 'utf8').includes('审核注入') };
  console.log('G04 ' + JSON.stringify(observation));
  H.ok('G04 路由启动失败但安装返回成功且 updater 自检通过', observation.installerExit === 0 && observation.routerFailureReported && observation.selfCheckOk && observation.routerEntryIsFaultFixture, inspected.err || observation);
  H.done('第三轮安装失败核验');
})().catch(e => { console.error(e.stack); H.cleanup(); process.exitCode = 1; });
