'use strict';
/* 自动连接失效、恢复与旧后台池。只用假口令和本机 H2，不连接用户数据库。旧版参数用于反例。 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const rt = H.runtime('auto');
const h = H.makeHome('connection-lifecycle', process.argv[2]);
const p = H.makeRepo(path.join(h.work, 'backend'), { 'pom.xml': '<project/>', '.gitignore': '.vibe/\n', 'application-dev.yml': 'spring.profiles: dev\n' });
const O = require(path.join(h.kit, 'lib/onboard'));
const f = { dialect: 'mysql', url: 'jdbc:mysql://127.0.0.1:1/dev', user: 'fake', password: 'FAKE_ONLY_Connection', source: 'application-dev.yml', line: 1, nameHint: 'dev' };
O.mergeDb(p, [f], {});
const ini = path.join(p, '.vibe/db-crud.ini');
H.write(ini, H.read(ini) + '\n[manual]\ndialect=mysql\njdbc=jdbc:mysql://127.0.0.1:2/dev\nuser=manual\npassword=FAKE_MANUAL\n');
const gone = O.mergeDb(p, [], {});
H.ok('失效自动连接从可执行 INI 移除', gone.changed && !/\[dev\]/.test(H.read(ini)));
H.ok('人工连接保留', /\[manual\]/.test(H.read(ini)));
const retired = H.read(path.join(p, '.vibe/connections-retired.json'));
H.ok('失效来源记录可查', /application-dev.yml/.test(retired));
H.ok('来源记录不含地址账号口令', !/jdbc:|FAKE_|127\.0|fake/.test(retired));
O.mergeDb(p, [f], {});
H.ok('重新识别开发连接可恢复', /\[dev\]/.test(H.read(ini)));
H.ok('恢复后移除失效标记', !/db\|dev/.test(H.read(path.join(p, '.vibe/connections-retired.json'))));
const red = { host: '127.0.0.1', port: 1, db: 0, password: 'FAKE_REDIS', source: 'application-dev.yml', line: 1, nameHint: 'dev' };
O.mergeRedis(p, [red], {}); O.mergeRedis(p, [], {});
H.ok('最后一个 Redis 自动连接也实际删除', Object.keys(JSON.parse(H.read(path.join(p, '.vibe/redis.json'))).connections).length === 0);
O.mergeRedis(p, [red], {});
H.ok('Redis 重新识别恢复', JSON.parse(H.read(path.join(p, '.vibe/redis.json'))).connections.dev.auto);
if (rt.python) {
  const scripts = path.join(h.cfg, 'skills/ttls-db-crud/scripts');
  const probe = path.join(h.work, 'parse.py');
  H.write(ini, '[old]\ndialect=mysql\njdbc=jdbc:mysql://127.0.0.1:1/dev\nsource=application-dev.yml:1\n; ★ 来源文件里已经找不到这个连接\n[disabled]\nenabled=false\ndialect=mysql\njdbc=jdbc:mysql://127.0.0.1:1/dev\n[manual]\ndialect=mysql\njdbc=jdbc:mysql://127.0.0.1:2/dev\n');
  H.write(probe, 'import sys\nsys.path.insert(0,sys.argv[1])\nimport dbconf\nprint(",".join(dbconf._parse(sys.argv[2]).keys()))\n');
  const parsed = H.run(h, rt.python, [probe, scripts, ini]);
  H.ok('解析器不选择旧注释失效和停用连接', parsed.code === 0 && parsed.out.trim() === 'manual', parsed.out + parsed.err);
  if (rt.java && rt.h2) {
    const script = path.join(h.work, 'pool.py');
    H.write(script, `import sys,pathlib,hashlib,json,os
sys.path.insert(0,sys.argv[1])
import daemon
f=pathlib.Path(sys.argv[2]);f.write_text('[dev]\\nenabled=true\\n',encoding='utf-8')
stamp=hashlib.sha256(f.read_bytes()).hexdigest()
args=['--mode','ping','--url','jdbc:h2:mem:lifecycle','--user','sa','--driver-class','org.h2.Driver','--config-file',str(f),'--config-stamp',stamp]
try:
 a=daemon.request(sys.argv[3],sys.argv[4],'DbRunner',args,'','',10)
 f.write_text('[dev]\\nenabled=false\\n',encoding='utf-8')
 status=daemon.status()
 b=daemon.request(sys.argv[3],sys.argv[4],'DbRunner',args,'','',10)
 print(json.dumps({'first':bool(a and a.get('ok')),'pool':status[0]['connections'] if status else -1,'stale':b.get('code') if b else ''}))
finally: daemon.stop_all()
`);
    const cp = path.join(scripts, 'runner') + path.delimiter + rt.h2;
    const r = H.run(h, rt.python, [script, scripts, ini, rt.java, cp], { timeout: 30000 });
    let result = {}; try { result = JSON.parse(r.out.trim()); } catch (e) { /* 断言输出诊断 */ }
    H.ok('H2 测试连接建立', r.code === 0 && result.first, r.out + r.err);
    H.ok('配置变化关闭旧后台连接', result.pool === 0, result);
    H.ok('过期配置请求不会执行', result.stale === 'STALE_CONFIG', result);
  }
}
H.done('连接生命周期');
