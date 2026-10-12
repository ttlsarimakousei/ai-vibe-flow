'use strict';
/* 真起两个假服务，核对前后端实际地址和场景入口。只使用假项目与回环端口，不连接业务系统。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('service-address', process.argv[2]); const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'package.json': '{"name":"fake-service"}' });
  H.write(path.join(p, 'server.js'), "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({backend:process.env.VIBE_BACKEND_URL||'',port:process.env.PORT}));}).listen(Number(process.env.PORT),'127.0.0.1');\n");
  const tool = (a) => H.node(h, path.join(h.kit, 'tools/devserver.js'), a, { cwd: p, timeout: 90000 });
  const rec = (name) => JSON.parse(fs.readFileSync(path.join(p, '.vibe/run', name + '.json')));
  try {
    const b = tool(['start', '--name', 'backend', '--port', 'auto', '--avoid', '8080', '--wait', '10', '--', 'node', 'server.js']);
    H.ok('后端在独立端口启动', b.code === 0, b.out);
    const f = tool(['start', '--name', 'frontend', '--port', 'auto', '--avoid', '8080,5173', '--backend', 'backend', '--wait', '10', '--', 'node', 'server.js']);
    H.ok('普通 Node 服务也能绑定后端启动', f.code === 0, f.out + f.err);
    const back = rec('backend'); const front = rec('frontend');
    H.ok('前端记录引用实际后端地址', f.code === 0 && front.backendUrl === 'http://127.0.0.1:' + back.port && front.port !== back.port, f.out);
    const r = await H.httpGet('http://127.0.0.1:' + front.port);
    H.ok('前端进程收到实际后端环境变量', String(r.text || r.body || '').includes('http://127.0.0.1:' + back.port), r);
    const scenario = path.join(p, '.vibe/scenarios/actual.json'); H.write(scenario, JSON.stringify({ steps: [{ request: 'GET /', expectStatus: 200, expectJson: 'backend', equals: 'http://127.0.0.1:' + back.port }] }));
    // 执行器的依赖用源码目录，套件状态仍由 VIBE_KIT_DIR 指向假的目录。
    const src = path.resolve(process.argv[2] || H.SRC); const page = path.join(src, 'kit/page/scenario-run.js');
    // baseline 不保存 node_modules；复用现有依赖，避免把缺依赖误算成旧版行为反例。
    const pageOpts = { cwd: p, timeout: 90000, env: { NODE_PATH: path.join(H.SRC, 'kit/page/node_modules') } };
    const result = H.node(h, page, [scenario, '--service', 'frontend', '--project', p], pageOpts);
    H.ok('场景按服务记录验证实际地址', result.code === 0 && /RESULT.*"ok":true/.test(result.out), result.out + result.err);
    const conflict = H.node(h, page, [scenario, '--service', 'frontend', '--project', p, '--base', 'http://127.0.0.1:5173'], pageOpts);
    H.ok('场景拒绝和登记冲突的固定地址', conflict.code === 2 && /不一致/.test(conflict.out + conflict.err), conflict.out + conflict.err);
    H.write(path.join(p, 'package.json'), JSON.stringify({ name: 'fake-front', dependencies: { vue: '2.7', webpack: '3' }, scripts: { dev: 'webpack-dev-server' } }));
    H.write(path.join(p, 'config/index.js'), "module.exports={proxyTable:{'/api':{target:'http://127.0.0.1:8096/oa'}}};\n");
    const fixed = tool(['start', '--name', 'proxy-front', '--port', 'auto', '--backend', 'backend', '--wait', '10', '--', 'node', 'server.js']);
    H.ok('绑定后端时提示固定代理与上下文路径', fixed.code === 0 && /写死的 target/.test(fixed.err) && /上下文路径/.test(fixed.err), fixed.out + fixed.err);
    tool(['stop', '--name', 'backend']);
    const missing = tool(['start', '--name', 'bad', '--port', 'auto', '--backend', 'backend', '--wait', '10', '--', 'node', 'server.js']);
    H.ok('后端未起时不假设代理已就绪', missing.code !== 0, missing.out);
  } finally { tool(['stop', '--all']); }
  H.done('服务实际地址');
})().catch((e) => { H.ok('服务测试异常', false, e.stack); H.done('服务实际地址'); });
