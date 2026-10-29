'use strict';
// 补充审核：原登记函数的受控并发、Python 离线自测和错误提示分支；不连接数据库。
const fs = require('fs');
const path = require('path');
const H = require('../../dev/lib/harness');
const python = process.argv[2];
if (!python || !fs.existsSync(python)) throw new Error('参数需给可用的 Python 完整路径');
const h = H.makeHome('codex-supplemental'); fs.mkdirSync(h.work, { recursive: true });
const dir = path.join(h.cfg, 'skills/ttls-db-crud/scripts');
for (const name of ['sqlguard_selftest.py', 'notes_selftest.py', 'discover_selftest.py']) {
  const r = H.run(h, python, ['-B', path.join(dir, name)], { cwd: h.work });
  H.ok('离线自测 ' + name, r.code === 0, r.out + r.err);
  console.log(name + ' ' + r.out.trim());
}
{
  const source = `import ast,pathlib,json,sys
root=pathlib.Path(sys.argv[1])
files=list(root.rglob('*.py'))
for f in files: ast.parse(f.read_text(encoding='utf-8-sig'),filename=str(f))
print(json.dumps({'pythonParsed':len(files),'syntaxErrors':0}))
`;
  const r = H.run(h, python, ['-B', '-c', source, dir], { cwd: h.work });
  H.ok('数据库技能 Python 语法检查', r.code === 0, r.err); console.log(r.out.trim());
}
{
  const file = path.join(h.work, 'concurrent.cjs');
  H.write(file, `'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),{spawn}=require('child_process');
const reg=${JSON.stringify(path.join(h.kit, 'state/devserver.json'))};const base=__dirname;
if(process.argv[2]){
 const id=process.argv[2];const source=fs.readFileSync(${JSON.stringify(path.join(h.kit, 'tools/devserver.js'))},'utf8');
 const begin=source.indexOf('function writeReg(fn) {');const end=source.indexOf(String.fromCharCode(10)+'function register(',begin);
 const readReg=()=>{const value=JSON.parse(fs.readFileSync(reg,'utf8'));fs.writeFileSync(path.join(base,'ready-'+id),'1');const other=id==='one'?'two':'one';const deadline=Date.now()+5000;while(!fs.existsSync(path.join(base,'ready-'+other))&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return value;};
 const context={fs,path,process,REG:reg,readReg};vm.createContext(context);vm.runInContext(source.slice(begin,end)+String.fromCharCode(10)+'writeReg(o=>{o["'+id+'"]={port:"'+id+'"};});',context);
}else{
 fs.writeFileSync(reg,'{}');const run=id=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[__filename,id],{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',c=>c?reject(new Error('并发子进程失败')):resolve());});
 Promise.all([run('one'),run('two')]).then(()=>{const keys=Object.keys(JSON.parse(fs.readFileSync(reg,'utf8')));console.log(JSON.stringify({writers:2,remainingEntries:keys.length,reproduced:keys.length===1,method:'原函数受控并发'}));}).catch(e=>{console.error(e);process.exitCode=1;});
}
`);
  const r = H.node(h, file, [], { cwd: h.work });
  const observed = r.code === 0 ? JSON.parse(r.out.trim()) : {};
  H.ok('F09 全机服务登记丢更新复现', observed.reproduced, r.err || observed); console.log('F09 ' + JSON.stringify(observed));
}
{
  const source = `import pathlib,sys,json,types,contextlib,io
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
import db,sqlguard
stmt=sqlguard.analyze('UPDATE T SET VALUE=2 WHERE ID=1','mysql')[0]
risk=sqlguard.classify(stmt,1)
db.run_runner=lambda *a,**kw: {'ok':False,'code':'SQL_ERROR','error':'模拟提交阶段连接中断'}
args=types.SimpleNamespace(snapshot_max_rows=10000,schema=None,ack='audit-fake',timeout=5)
conn={'name':'audit','dialect':'mysql','jdbc':'jdbc:mysql://127.0.0.1/fixture','user':'tester'}
err=io.StringIO()
with contextlib.redirect_stderr(err):
 code=db._apply(args,conn,pathlib.Path.cwd(),stmt,risk,1,sqlguard.count_sql_for(stmt),lambda n:sqlguard.classify(stmt,n),{},None)
text=err.getvalue()
print(json.dumps({'code':code,'declaresRollback':'已经回滚，数据没有变' in text,'declaresUnknown':'结果不明' in text,'method':'Python返回分支注入，未执行JDBC'},ensure_ascii=False))
`;
  const r = H.run(h, python, ['-B', '-c', source, dir], { cwd: h.work });
  const observed = r.code === 0 ? JSON.parse(r.out.trim()) : {};
  H.ok('F10 提交错误分支误报回滚复现', observed.declaresRollback && !observed.declaresUnknown, r.err || observed);
  console.log('F10 ' + JSON.stringify(observed));
}
{
  const file = path.join(h.work, 'ack-race.py');
  H.write(file, `import sys,json,multiprocessing
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(dir)})
import journal
def consume(index,barrier,saved,queue):
    original=journal._pending_load
    def synchronized_load():
        value=original()
        barrier.wait(timeout=10)
        if index==1:saved.wait(timeout=10)
        return value
    journal._pending_load=synchronized_load
    result=journal.pending_take('audit-fake-token','audit-fake-fingerprint')[0]
    if index==0:saved.set()
    queue.put(result)
if __name__=='__main__':
    journal.pending_put('audit-fake-token','audit-fake-fingerprint')
    ctx=multiprocessing.get_context('spawn')
    barrier=ctx.Barrier(2)
    queue=ctx.Queue()
    saved=ctx.Event()
    workers=[ctx.Process(target=consume,args=(index,barrier,saved,queue)) for index in range(2)]
    try:
        for p in workers:p.start()
        for p in workers:p.join(15)
        if any(p.is_alive() or p.exitcode!=0 for p in workers):
            raise RuntimeError('确认串测试子进程超时或异常退出')
        values=[queue.get(timeout=5) for _ in workers]
        print(json.dumps({'consumers':2,'successfulTakes':sum(values),'reproduced':all(values),'method':'原pending_take双进程受控并发'}))
    finally:
        for p in workers:
            if p.pid is None:continue
            if p.is_alive():p.terminate()
            p.join(5)
            if p.is_alive():
                p.kill()
                p.join(5)
        queue.close()
        queue.join_thread()
`);
  const r = H.run(h, python, ['-B', file], { cwd: h.work });
  const observed = r.code === 0 ? JSON.parse(r.out.trim()) : {};
  H.ok('F11 数据库同一确认串被双消费复现', observed.reproduced === true, r.err || observed);
  console.log('F11 ' + JSON.stringify(observed));
}
H.done('Codex 补充隔离核验');
