'use strict';
/*
 * 10-30 那一批 E、F、G、H、I、J 批里的零散修复（docs/feedback-20261030.md），一项一节：
 *   F7（Codex C14）清理过程文件目录：扫不完整（超过 2000 项、8 层）就不删
 *   E4（审核 P20）路由：改了网关地址又没带新 key，拒绝保存
 *   别的节（E2、E6、H3、I3、F2、F3、F9、G2、G3、H4、H5、I4）见各节标题；拿 20261028.2041 跑每节至少一项不过
 * 用法：node dev/test-fixes-1031.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCV = FROM || H.SRC;

(async () => {
  H.section('F7 清理过程文件目录：扫不完整就不删（最新的文件可能在没看到的地方）');
  {
    const h = H.makeHome('tfx-f7', FROM);
    const T = require(path.join(h.kit, 'lib', 'tidy.js'));
    const root = path.join(h.work, 'proj');
    const big = path.join(root, '.vibe', 'tmp', '20261001-导出样本');
    fs.mkdirSync(big, { recursive: true });
    const old = new Date(Date.now() - 30 * 86400000);
    for (let i = 0; i < 2004; i++) { const f = path.join(big, 'a' + String(i).padStart(5, '0') + '.txt'); fs.writeFileSync(f, 'x'); fs.utimesSync(f, old, old); }
    fs.writeFileSync(path.join(big, 'zzzz-刚改的.txt'), '刚改的');
    fs.utimesSync(big, old, old);
    const small = path.join(root, '.vibe', 'tmp', '20261001-小样本');
    fs.mkdirSync(small, { recursive: true });
    fs.writeFileSync(path.join(small, 'a.txt'), 'x'); fs.utimesSync(path.join(small, 'a.txt'), old, old); fs.utimesSync(small, old, old);
    const gone = T.cleanTmp([root], 7, [], [], {});
    H.ok('2005 个文件、最后一个刚改过：没看全，不删', fs.existsSync(path.join(big, 'zzzz-刚改的.txt')), gone);
    H.ok('看得全、确实 30 天没动的：照样删', !fs.existsSync(small), gone);
  }

  H.section('E4 路由：改了网关地址又没带新 key，拒绝保存（已保存的 key 不跟到新地址）');
  {
    const h = H.makeHome('tfx-e4', FROM);
    const dir = path.join(h.root, 'router-data');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    const port = 18900 + Math.floor(Math.random() * 90);
    H.write(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-test-0123456789abcdef' }], routes: [], default: { provider: 'gw' }, failover: [] }, null, 2));
    const r = spawn(process.execPath, [path.join(SRCV, 'router', 'router.js'), '-c', cfg, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
    const call = (method, url, body) => new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'x-vibe-router': '1' }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); }); });
      q.on('error', () => resolve({ status: 0, json: null })); if (data) q.write(data); q.end();
    });
    let st = null; for (let i = 0; i < 60 && !(st && st.status === 200); i++) { await H.sleep(250); st = await call('GET', '/api/state'); }
    const moved = await call('POST', '/api/config', { providers: [{ name: 'gw', original_name: 'gw', base_url: 'http://127.0.0.1:10/v1' }], routes: [], default: { provider: 'gw' }, failover: [] });
    const saved = JSON.parse(H.read(cfg) || '{}');
    H.ok('地址改了、没填 key：不保存，说清楚', moved.status === 400 && /地址改了，要重新填一次 key/.test((moved.json && moved.json.error) || '') && saved.providers[0].base_url === 'http://127.0.0.1:9/v1', [moved, saved.providers]);
    const same = await call('POST', '/api/config', { providers: [{ name: 'gw', original_name: 'gw', base_url: 'http://127.0.0.1:9/v1', note: '备注' }], routes: [], default: { provider: 'gw' }, failover: [] });
    const saved2 = JSON.parse(H.read(cfg) || '{}');
    H.ok('地址没变、没填 key：照旧沿用原来的 key 保存', same.status === 200 && saved2.providers[0].api_key === 'sk-test-0123456789abcdef' && saved2.providers[0].note === '备注', [same.status, saved2.providers[0].note]);
    r.kill();
  }

  H.section('H3 会话记录：用户那句话在 3 MB 以外（这一轮工具输出很大），往前再读，不当成没说');
  {
    const h = H.makeHome('tfx-h3', FROM);
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const big = 'x'.repeat(400000);
    const entries = [H.tr.user('改完提交')];
    for (let i = 0; i < 10; i++) entries.push(...H.tr.ran('Bash', { command: 'mvn -q test' }, big));
    const file = H.transcript(path.join(h.root, 'big.jsonl'), entries);
    const r = S.userSaid(S.tailEntries(file, 3000000), 'commit');
    H.ok('记录 4 MB、用户的"改完提交"在最前面：认得出', fs.statSync(file).size > 3500000 && r.ok, { size: fs.statSync(file).size, ok: r.ok });
  }

  H.section('I3 问题反馈：几个进程同时记，编号不重、同签名的次数不丢');
  {
    const h = H.makeHome('tfx-i3', FROM);
    const fbjs = path.join(h.kit, 'lib', 'feedback.js');
    const script = path.join(h.root, 'rec.js');
    H.write(script, 'const F = require(' + JSON.stringify(fbjs) + ');\nconst who = process.argv[2];\nfor (let i = 0; i < 12; i++) { F.record({ kind: \'测试\', title: \'并发 \' + who + \' \' + i }); F.record({ kind: \'测试\', title: \'同一条\', sig: \'same-sig\' }); }\n');
    const kids = [0, 1, 2].map((k) => new Promise((resolve) => { const c = spawn(process.execPath, [script, 'p' + k], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' }); c.on('exit', resolve); }));
    await Promise.all(kids);
    const dir = path.join(h.kit, 'feedback');
    const files = fs.readdirSync(dir).filter((n) => /^F\d{8}-\d+.*\.md$/.test(n));
    const distinct = files.filter((n) => /并发/.test(n));
    const same = files.filter((n) => /同一条/.test(n)).map((n) => H.read(path.join(dir, n)));
    const count = same.length === 1 ? Number((/次数: (\d+)/.exec(same[0]) || [])[1]) : -1;
    H.ok('3 个进程各记 12 条不同的：36 个文件，编号不重', distinct.length === 36 && new Set(distinct.map((n) => n.slice(0, 13))).size === 36, distinct.length);
    H.ok('同一签名各记 12 次：并成一条，次数 36', same.length === 1 && count === 36, { files: same.length, count });
  }

  H.section('F3 锁有租期：进程号被复用（锁的主人看着还活着）、锁已经很旧了，照样拿得回来');
  {
    const h = H.makeHome('tfx-f3', FROM);
    const SS = require(path.join(h.kit, 'lib', 'state-store.js'));
    const lock = path.join(h.root, 'x.lock');
    // 主人"还活着"：用这个测试进程自己的进程号，冒充复用了进程号的别的程序；锁是 20 分钟前的
    H.write(lock, JSON.stringify({ pid: process.pid, thread: 0, token: 'old', at: Date.now() - 20 * 60000 }));
    const got = SS.acquire(lock, { waitMs: 200 });
    H.ok('20 分钟前的锁（默认租期 10 分钟）：拿得到', !!got, got);
    if (got) got.release();
    H.write(lock, JSON.stringify({ pid: process.pid, thread: 0, token: 'fresh', at: Date.now() }));
    H.ok('刚建的锁、主人活着：拿不到', !SS.acquire(lock, { waitMs: 200 }));
  }

  H.section('F2 装坏了、也没能装回上一版：状态栏第一行红字、配置页接口带上 broken');
  {
    const h = H.makeHome('tfx-f2', FROM, { autoUpdate: 'auto' });
    H.write(path.join(h.kit, 'VERSION'), '20261031.0900\n');
    H.write(path.join(h.kit, 'state', 'update.json'), JSON.stringify({ remoteVersion: '20261031.0900', failed: { version: '20261031.0900', from: '20261028.2041', times: 1, why: '装完自检没过', rolledBack: false, at: Date.now() } }));
    const proj = H.makeRepo(path.join(h.work, 'p'), { 'a.txt': 'x\n' });
    const sl = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: 's-f2', cwd: proj, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: proj }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: proj }).out.replace(/\x1b\[[0-9;]*m/g, '');
    H.ok('状态栏第一行：没装好、也没能装回上一版', /新版 20261031\.0900 没装好，也没能装回上一版/.test(sl.split('\n')[0] || ''), sl);
    const st = H.node(h, '-e', ['console.log(JSON.stringify(require(' + JSON.stringify(path.join(h.kit, 'lib', 'updater.js')) + ').status().broken || null))'], { timeout: 30000 });
    let b = null; try { b = JSON.parse(st.out.trim().split(/\r?\n/).pop()); } catch (e) { b = null; }
    H.ok('配置页接口：status().broken 写着坏的版本和上一版', !!b && b.version === '20261031.0900' && b.from === '20261028.2041', st.out + st.err);
  }

  H.done('10-31 零散修复（E、F、G、H、I、J 批）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
