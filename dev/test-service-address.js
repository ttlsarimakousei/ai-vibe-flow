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
    const back = rec('backend'); const front = rec('frontend');
    H.ok('前端记录引用实际后端地址', f.code === 0 && front.backendUrl === 'http://127.0.0.1:' + back.port && front.port !== back.port, f.out);
    const r = await H.httpGet('http://127.0.0.1:' + front.port);
    H.ok('前端进程收到实际后端环境变量', String(r.text || r.body || '').includes('http://127.0.0.1:' + back.port), r);
    const scenario = path.join(p, '.vibe/scenarios/actual.json'); H.write(scenario, JSON.stringify({ steps: [{ request: 'GET /', expectStatus: 200, expectJson: 'backend', equals: 'http://127.0.0.1:' + back.port }] }));
    // 执行器的依赖用源码目录，套件状态仍由 VIBE_KIT_DIR 指向假的目录。
    const src = process.argv[2] || H.SRC; const page = path.join(src, 'kit/page/scenario-run.js');
    const result = H.node(h, page, [scenario, '--service', 'frontend', '--project', p], { cwd: p, timeout: 90000 });
    H.ok('场景按服务记录验证实际地址', result.code === 0 && /RESULT.*"ok":true/.test(result.out), result.out + result.err);
    const conflict = H.node(h, page, [scenario, '--service', 'frontend', '--project', p, '--base', 'http://127.0.0.1:5173'], { cwd: p });
    H.ok('场景拒绝和登记冲突的固定地址', conflict.code === 2 && /不一致/.test(conflict.out + conflict.err), conflict.out + conflict.err);
    tool(['stop', '--name', 'backend']);
    const missing = tool(['start', '--name', 'bad', '--port', 'auto', '--backend', 'backend', '--wait', '10', '--', 'node', 'server.js']);
    H.ok('后端未起时不假设代理已就绪', missing.code !== 0, missing.out);
  } finally { tool(['stop', '--all']); }
  H.done('服务实际地址');
})().catch((e) => { H.ok('服务测试异常', false, e.stack); H.done('服务实际地址'); });
