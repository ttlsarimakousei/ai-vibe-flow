'use strict';
// HTTP 钩子宿主故障注入：只替换假 KIT 的工作线程，验证故障放行是否留下问题反馈。
const fs = require('fs');
const path = require('path');
const H = require('../../dev/lib/harness');
const h = H.makeHome('codex-hook-fault'); fs.mkdirSync(h.work, { recursive: true });
H.write(path.join(h.kit, 'lib/hook-worker.js'), "'use strict';const {parentPort}=require('worker_threads');parentPort.on('message',()=>process.exit(7));\n");
const code = 'const fs=require("fs"),path=require("path");const kit=' + JSON.stringify(h.kit) + ';const host=require(path.join(kit,"lib/hook-host")).createHost({kitDir:kit,log:()=>{}});(async()=>{try{const result=await host.run("guard-read",{cwd:process.cwd(),session_id:"audit-fault",tool_name:"Grep",tool_input:{path:".",output_mode:"content"}});const dir=path.join(kit,"feedback");const feedbackRecords=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith(".md")).length:0;console.log(JSON.stringify({status:result.status,failOpen:result.out===null,workerErrors:host.stats().byHook["guard-read"].errors,feedbackRecords}));}finally{host.close();}})().catch(e=>{console.error(e);process.exitCode=1;});';
const r = H.node(h, '-e', [code], { cwd: h.work });
const observed = r.code === 0 ? JSON.parse(r.out.trim()) : {};
H.ok('F15 工作线程退出后放行却无问题反馈', observed.failOpen && observed.workerErrors === 1 && observed.feedbackRecords === 0, r.err || observed);
console.log('F15 ' + JSON.stringify(observed));
H.done('Codex HTTP 钩子故障注入');
