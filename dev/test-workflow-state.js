'use strict';
/* 状态存储的并发与恢复反例。全部在假用户目录，旧套件参数用于确认新测试真能检出覆盖更新。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');
const children = [];
function child(h, script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script].concat(args || []), { cwd: h.work, env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(p);
    let output = ''; p.stdout.on('data', (b) => { output += b; }); p.stderr.on('data', (b) => { output += b; });
    const timer = setTimeout(() => { p.kill(); }, 12000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
(async () => {
  const h = H.makeHome('workflow-state', process.argv[2]);
  fs.mkdirSync(h.work, { recursive: true });
  const script = path.join(h.work, 'update.js');
  H.write(script, `const fs=require('fs'); const path=require('path'); const S=require(process.argv[2]);
const id=process.argv[3]; const barrier=process.argv[4]; fs.writeFileSync(path.join(barrier,id),'');
const wait=(n)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,n);
const end=Date.now()+5000; while(fs.readdirSync(barrier).length<8&&Date.now()<end)wait(5);
const result=S.updateState('concurrent',o=>{wait(70);o[id]=true;o.count=(o.count||0)+1;});
if(!result)process.exitCode=1;`);
  const barrier = path.join(h.work, 'barrier'); fs.mkdirSync(barrier);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child(h, script, [path.join(h.kit, 'lib/session.js'), String(i), barrier])));
  H.ok('八个写入进程成功退出', results.every((r) => r.code === 0), results);
  const record = JSON.parse(H.read(path.join(h.kit, 'state/concurrent.json')) || '{}');
  H.ok('各自字段没有被覆盖', Array.from({ length: 8 }, (_, i) => record[i]).every(Boolean), record);
  H.ok('累计次数没有丢失', record.count === 8, record.count);
  const mod = path.join(h.kit, 'lib/state-store.js');
  H.ok('状态锁模块随套件交付', fs.existsSync(mod));
  if (fs.existsSync(mod)) {
    const S = require(mod); const file = path.join(h.kit, 'state/recovery.json');
    const crash = path.join(h.work, 'crash.js');
    H.write(crash, `const S=require(process.argv[2]); const lock=S.acquire(process.argv[3]); if(!lock)process.exit(2);process.exit(0);`);
    const died = await child(h, crash, [mod, file + '.lock']);
    H.ok('异常退出留下可识别归属', died.code === 0 && fs.existsSync(file + '.lock'));
    const updated = S.update(file, (o) => { o.recovered = true; });
    H.ok('已退出进程的锁可回收', updated && updated.recovered);
    H.ok('操作结束释放锁', !fs.existsSync(file + '.lock'));
    const held = S.acquire(file + '.lock');
    H.ok('活锁不能被第二个调用抢走', !!held && S.acquire(file + '.lock', { waitMs: 20 }) === null);
    if (held) held.release();
    let threw = false;
    try { S.update(file, () => { throw new Error('测试异常'); }); } catch (e) { threw = true; }
    H.ok('回调异常也释放锁', threw && !fs.existsSync(file + '.lock'));
    fs.writeFileSync(file, '坏的 JSON'); fs.utimesSync(file, new Date(0), new Date(0));
    H.ok('旧损坏记录隔离后可恢复', S.update(file, (o) => { o.ok = true; }).ok && fs.existsSync(file + '.bad'));
  }
  H.done('状态并发与恢复');
})().finally(() => { for (const p of children) { if (p.exitCode === null) p.kill(); } });
