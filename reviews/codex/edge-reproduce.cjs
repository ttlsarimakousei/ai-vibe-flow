'use strict';
// 清理边界、Redis 临界 TTL、发布时部分推送：全部在假目录和本机假服务中核验。
const fs = require('fs');
const path = require('path');
const H = require('../../dev/lib/harness');
const h = H.makeHome('codex-edges'); H.makeRepo(h.work, { 'app.js': 'module.exports=1;\n' });
{
  const code = 'const fs=require("fs"),path=require("path");const T=require(' + JSON.stringify(path.join(h.kit, 'lib/tidy')) + ');const d=path.join(process.cwd(),".vibe/tmp/audit-large");if(path.relative(process.cwd(),d).startsWith(".."))throw new Error("路径越界");fs.mkdirSync(d,{recursive:true});const old=new Date(Date.now()-8*86400000);for(let i=0;i<2001;i++){const f=path.join(d,String(i).padStart(5,"0")+".txt");fs.writeFileSync(f,"测试");fs.utimesSync(f,old,old);}const recent=path.join(d,"02000.txt");fs.writeFileSync(recent,"刚修改");fs.utimesSync(d,old,old);const seen=T.newestMtime(d);const deleted=T.cleanTmp([process.cwd()],7,[],[],{});console.log(JSON.stringify({files:2001,scanSeesOld:seen<Date.now()-7*86400000,deleted:deleted.length,recentFileLost:!fs.existsSync(recent)}));';
  const r = H.node(h, '-e', [code], { cwd: h.work }); const x = r.code === 0 ? JSON.parse(r.out.trim()) : {};
  H.ok('F12 扫描截断误删刚修改的文件', x.recentFileLost && x.deleted === 1, r.err || x); console.log('F12 ' + JSON.stringify(x));
}
{
  const script = path.join(h.work, 'redis-edge.cjs');
  H.write(script, `const net=require('net'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');const client=${JSON.stringify(path.join(h.cfg, 'skills/ttls-redis/scripts/redis.js'))};const {Parser}=require(client);let sent=[];const server=net.createServer(s=>{const p=new Parser();s.on('data',b=>{p.push(b);for(const row of p.out.splice(0)){const a=row.map(v=>Buffer.isBuffer(v)?v.toString():String(v));sent.push(a);s.write(a[0]==='PTTL'?':0'+String.fromCharCode(13,10):'+OK'+String.fromCharCode(13,10));}});});server.listen(0,'127.0.0.1',()=>{const port=server.address().port;const cfg=path.join(__dirname,'.vibe/redis.json');fs.mkdirSync(path.dirname(cfg),{recursive:true});fs.writeFileSync(cfg,JSON.stringify({connections:{dev:{host:'127.0.0.1',port,db:0}}}));const p=spawn(process.execPath,[client,'--project',__dirname,'set','audit-key','value'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',c=>out+=c);p.on('exit',code=>server.close(()=>{const set=sent.find(a=>a[0]==='SET')||[];console.log(JSON.stringify({code,pttl:0,setArgumentCount:set.length,setsExpiry:set.includes('PX')||set.includes('KEEPTTL'),ok:!!JSON.parse(out).ok}));}));});`);
  const r = H.node(h, script, [], { cwd: h.work }); const x = r.code === 0 ? JSON.parse(r.out.trim()) : {};
  H.ok('F13 PTTL 为零时 SET 丢失过期策略', x.ok && !x.setsExpiry && x.setArgumentCount === 3, r.err || x); console.log('F13 ' + JSON.stringify(x));
}
{
  const bare = path.join(h.root, 'fake-remote.git');
  const must = (dir, args) => { const r = H.git(dir, args); if (r.code !== 0) throw new Error(r.err); return r.out.trim(); };
  must(h.root, ['init', '--bare', '-q', bare]);
  must(h.work, ['tag', 'v-audit']); must(h.work, ['push', '-q', bare, 'HEAD:refs/heads/main', 'refs/tags/v-audit']);
  H.write(path.join(h.work, 'app.js'), 'module.exports=2;\n'); must(h.work, ['add', '--', 'app.js']); must(h.work, ['commit', '-q', '-m', 'fix: 测试发布部分成功']);
  const head = must(h.work, ['rev-parse', 'HEAD']); must(h.work, ['tag', '-f', 'v-audit']);
  const push = H.git(h.work, ['push', '-q', bare, 'HEAD:refs/heads/main', 'refs/tags/v-audit']);
  const branch = must(bare, ['rev-parse', 'refs/heads/main']); const tag = must(bare, ['rev-parse', 'refs/tags/v-audit']);
  const x = { pushExitCode: push.code, branchAdvanced: branch === head, tagAdvanced: tag === head, method: '真实临时裸仓库，使用发布脚本相同推送参数' };
  H.ok('F14 非原子推送报失败但分支已发布', push.code !== 0 && x.branchAdvanced && !x.tagAdvanced, x); console.log('F14 ' + JSON.stringify(x));
}
H.done('Codex 边界隔离复现');
