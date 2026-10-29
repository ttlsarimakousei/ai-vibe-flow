'use strict';
/* 路由集成复现：假用户目录、随机本机端口、固定假 key，不调用公司网关。约需一分钟。 */
const fs = require('fs');
const path = require('path');
const H = require('../../dev/lib/harness');
const h = H.makeHome('codex-router'); fs.mkdirSync(h.work, { recursive: true });
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
const script = path.join(h.work, 'route-check.cjs');
H.write(script, `
'use strict';
const http=require('http');const fs=require('fs');const path=require('path');const {spawn}=require('child_process');
const kit=${JSON.stringify(h.kit)};
let mode='partial';let requests=0;let router;let mock;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function request(port,url,body,headers){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path:url,method:body?'POST':'GET',headers:Object.assign({'content-type':'application/json'},headers||{})},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,complete:res.complete,ended:true,body:text}));res.on('error',reject);});r.on('error',reject);r.setTimeout(90000,()=>r.destroy(new Error('假客户端等待超时')));r.end(body?JSON.stringify(body):undefined);});}
(async()=>{
 try{
  mock=http.createServer((req,res)=>{requests++;req.resume();req.on('end',()=>{
   if(mode==='partial'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: message_start\\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\\n\\n');res.end('event: content_block_delta\\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半截回复"}}\\n\\n');return;}
   setTimeout(()=>{if(req.url.startsWith('/first')){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"type":"api_error","message":"模拟暂时不可用"}}');}else{res.writeHead(200,{'content-type':'application/json'});res.end('{"type":"message","content":[{"type":"text","text":"好"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');}},26000);
  });});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));const mp=mock.address().port;
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const config=path.join(kit,'router-data','config.json');fs.mkdirSync(path.dirname(config),{recursive:true});
  fs.writeFileSync(config,JSON.stringify({listen:{host:'127.0.0.1',port},providers:[{name:'first',base_url:'http://127.0.0.1:'+mp+'/first',api_key:'audit-fake-key'},{name:'second',base_url:'http://127.0.0.1:'+mp+'/second',api_key:'audit-fake-key'}],default:{provider:'first'},routes:[],failover:['second'],options:{firstByteTimeoutSec:30,rateLimitWaitSec:0,stickySession:false}}));
  router=spawn(process.execPath,[path.join(kit,'router/router.js'),'-c',config],{windowsHide:true,stdio:'ignore'});
  let up=false;for(let i=0;i<100;i++){try{const x=await request(port,'/version');if(x.status===200){up=true;break;}}catch(e){}await delay(100);}if(!up)throw new Error('假路由未能启动');
  const partial=await request(port,'/v1/messages',{model:'audit-sonnet',stream:true,messages:[{role:'user',content:'测试'}]});
  await delay(50);const stats=JSON.parse((await request(port,'/stats')).body);const last=stats.recentLogs[stats.recentLogs.length-1];
  console.log('F07 '+JSON.stringify({normalHttpEnd:partial.ended&&partial.complete,hasMessageStop:partial.body.includes('message_stop'),routerRecordedFailure:!!last.failed,reproduced:partial.complete&&!partial.body.includes('message_stop')&&last.failed}));
  mode='deadline';requests=0;const t=Date.now();const response=await request(port,'/v1/messages',{model:'audit-sonnet',stream:false,messages:[{role:'user',content:'测试'}]},{'x-stainless-timeout':'45'});const elapsedMs=Date.now()-t;
  console.log('F08 '+JSON.stringify({clientTimeoutSeconds:45,elapsedMs,upstreamRequests:requests,status:response.status,reproduced:elapsedMs>45000&&requests===2&&response.status===200}));
 }finally{
  if(router&&router.exitCode===null){const exited=new Promise(r=>router.once('exit',r));router.kill();await exited;}
  if(mock)await new Promise(r=>mock.close(r));
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
`);
const r = H.node(h, script, [], { cwd: h.work, timeout: 120000 });
process.stdout.write(r.out); if (r.err) process.stderr.write(r.err);
H.ok('假路由复现进程正常结束', r.code === 0, r.err);
for (const id of ['F07', 'F08']) {
  const line = r.out.split(/\r?\n/).find(x => x.startsWith(id + ' '));
  const result = line ? JSON.parse(line.slice(4)) : {};
  H.ok(id + ' 复现命中', result.reproduced === true, result);
}
H.done('Codex 路由集成复现');
