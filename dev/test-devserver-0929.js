'use strict';
/*
 * 起服务的工具（kit/tools/devserver.js），0929 反馈里的一条：
 *   F20260928-011   stop && start 串起来重启：看不到"起来了"那一行；反复几次之后两个 java 一起跑
 * 1017 加的：先占端口、过几秒才答 HTTP 的（Tomcat 那种）要等它答 HTTP 才说起来了；一直不答 HTTP 的端口通了 60 秒也算；只听 ::1 的也认得。
 * 拿一个 node 写的小服务当被测的服务。全程盯着桌面，结尾查没有留下进程。
 * 用法：node dev/test-devserver-0929.js [端口，默认 18781] [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18781;
const FROM = process.argv[3] && fs.existsSync(path.join(process.argv[3], 'kit')) ? process.argv[3] : null;
const h = H.makeHome('dev0929', FROM);
const TOOL = path.join(h.kit, 'tools', 'devserver.js');
const proj = H.makeRepo(path.join(h.work, 'app'), { 'pom.xml': '<project/>' });
// 被测的服务：听一个端口，另外起一个不听端口的帮手进程（像 mvn 起的 java 旁边那个）
H.write(path.join(proj, 'srv.js'), [
  "const http = require('http');",
  "const { spawn } = require('child_process');",
  "const helper = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { windowsHide: true, stdio: 'ignore' });",
  "require('fs').writeFileSync(require('path').join(__dirname, 'pids.json'), JSON.stringify({ srv: process.pid, helper: helper.pid }));",
  "http.createServer((q, s) => s.end('v' + (process.argv[3] || '1'))).listen(Number(process.argv[2]), '127.0.0.1');",
].join('\n'));
// 把服务甩到后台就退出的启动脚本（startup.bat 那种）
H.write(path.join(proj, 'launch.js'), [
  "const { spawn } = require('child_process');",
  "const c = spawn(process.execPath, [require('path').join(__dirname, 'srv.js'), process.argv[2], 'bg'], { detached: true, windowsHide: true, stdio: 'ignore', cwd: __dirname });",
  "c.unref();",
  "setTimeout(() => process.exit(0), 300);",
].join('\n'));

const tool = (args) => H.node(h, TOOL, args, { cwd: proj, timeout: 120000 });
const lastLine = (r) => r.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
const open = (port) => new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(500, () => { s.destroy(); resolve(false); }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } };
const pids = () => { try { return JSON.parse(fs.readFileSync(path.join(proj, 'pids.json'), 'utf8')); } catch (e) { return {}; } };
const startArgs = ['start', '--name', 'app', '--port', String(PORT), '--hot', '--', 'node', 'srv.js', String(PORT)];

(async () => {
  const watch = await H.watchWindows('dev-win');

  H.section('起来：最后一行就是结果');
  const s1 = tool(startArgs);
  H.ok('起来了', s1.code === 0 && (await open(PORT)), s1.out + s1.err);
  H.ok('反馈原样：输出的最后一行是"起来了"', /^起来了：app，端口 \d+/.test(lastLine(s1)), s1.out);
  H.ok('说了听这个端口的是哪个进程', new RegExp('听这个端口的是 node（PID ' + pids().srv + '）').test(lastLine(s1)), [lastLine(s1), pids()]);
  const rec = JSON.parse(fs.readFileSync(path.join(proj, '.vibe', 'run', 'app.json'), 'utf8'));
  H.ok('记下了它起的每个进程（服务和帮手都在）', Array.isArray(rec.tree) && rec.tree.some((p) => p.pid === pids().srv) && rec.tree.some((p) => p.pid === pids().helper), [rec.tree, pids()]);
  const again = tool(startArgs);
  H.ok('已经在跑：不再起一个', again.code === 0 && /^已经在跑：app/.test(lastLine(again)) && pids().srv === rec.tree.find((p) => p.pid === pids().srv).pid, again.out);

  H.section('停：它起的进程都清掉，端口空出来才返回');
  const first = pids();
  const t1 = tool(['stop', '--name', 'app']);
  H.ok('停了，最后一行说端口空出来了', t1.code === 0 && /^停了：app，端口 \d+ 空出来了/.test(lastLine(t1)), t1.out + t1.err);
  H.ok('端口真的空了', !(await open(PORT)));
  H.ok('服务和帮手进程都没了', !alive(first.srv) && !alive(first.helper), first);

  H.section('stop 和 start 串在一条命令里（F20260928-011）');
  tool(startArgs);
  const before = pids();
  // 反馈原样：node devserver.js stop … && sleep 2 && node devserver.js start …
  const q = (s) => '"' + s + '"';
  const chain = [q(process.execPath), q(TOOL), 'stop', '--name', 'app', '&&', q(process.execPath), q(TOOL)].concat(startArgs.map((a) => (/\s/.test(a) ? q(a) : a))).join(' ');
  const r = spawnSync(chain, { cwd: proj, env: H.envFor(h), encoding: 'utf8', shell: true, windowsHide: true, timeout: 120000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  H.ok('串起来跑：退出码 0', r.status === 0, out);
  H.ok('反馈原样：最后一行是"起来了"，前面有"停了"', /^起来了：app/.test(lines[lines.length - 1] || '') && lines.some((l) => /^停了：app/.test(l)), out);
  const after = pids();
  H.ok('换了新的进程，旧的都没了', after.srv !== before.srv && !alive(before.srv) && !alive(before.helper) && alive(after.srv), [before, after]);
  H.ok('端口上只有一个进程在听', /听这个端口的是 node（PID \d+）。/.test(lines[lines.length - 1]) && !/、/.test((lines[lines.length - 1].match(/听这个端口的是 ([^。]+)。/) || [])[1] || ''), lines[lines.length - 1]);
  // 连着重启几次，不会越攒越多
  const seen = [after];
  for (let i = 0; i < 2; i++) { tool(['stop', '--name', 'app']); tool(startArgs); seen.push(pids()); }
  H.ok('连着重启三次：每次旧的都清干净', seen.slice(0, -1).every((p) => !alive(p.srv) && !alive(p.helper)) && alive(seen[seen.length - 1].srv), seen);
  tool(['stop', '--all']);

  H.section('启动命令把服务甩到后台就退出的（startup.bat 那种）');
  const b = tool(['start', '--name', 'bg', '--port', String(PORT), '--hot', '--', 'node', 'launch.js', String(PORT)]);
  H.ok('等到服务真的起来', b.code === 0 && /^起来了：bg/.test(lastLine(b)) && (await open(PORT)), b.out + b.err);
  const bg = pids();
  const bs = tool(['stop', '--name', 'bg']);
  H.ok('停得掉甩到后台的服务', bs.code === 0 && /空出来了/.test(lastLine(bs)) && !(await open(PORT)) && !alive(bg.srv) && !alive(bg.helper), [bs.out, bg]);

  H.section('端口被这个项目的进程占着、却没有记录：看是谁起的（0930 审查）');
  const { spawn } = require('child_process');
  const runDetached = (args, cwd) => { const c = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd: cwd || proj }); c.unref(); return c.pid; };
  const waitOpen = async (want) => { for (let i = 0; i < 40; i++) { if ((await open(PORT)) === want) return true; await H.sleep(250); } return false; };
  // 没人管的：起它的程序已经退了（以前起了没关）
  runDetached([path.join(proj, 'launch.js'), String(PORT)]);
  await waitOpen(true);
  const orphan = pids();
  const o1 = tool(startArgs);
  // 2026-10-31 改了（审核 P29）：起它的程序不在了、又找不到 devserver 起过它的痕迹（全机登记里没有这个端口），当成用户自己起的
  // （双击 startup.bat 起的 Tomcat 就是这样），不停；以前直接停掉重起
  H.ok('起它的程序已经不在了、没有 devserver 痕迹：当用户自己起的，不停它', o1.code === 1 && /用户自己起的/.test(o1.out) && alive(orphan.srv), [o1.out, orphan]);
  for (const p of [orphan.srv, orphan.helper]) { try { process.kill(p); } catch (e) { /* 已经没了 */ } }
  tool(['stop', '--all']);
  await waitOpen(false);
  // 用户自己起的：这里拿带调试器参数的进程代替（带 -agentlib:jdwp 的一律算用户的，IDE 的调试会话不能断）
  const userPid = runDetached([path.join(proj, 'srv.js'), String(PORT), 'user', '-agentlib:jdwp=transport=dt_socket,server=y']);
  await waitOpen(true);
  const u1 = tool(startArgs);
  H.ok('用户自己起的（带着调试器）：不动它，退出码 1，说了怎么办', u1.code === 1 && /用户自己起的/.test(u1.out) && /--takeover/.test(u1.out) && alive(userPid) && (await open(PORT)), u1.out);
  const u2 = tool(startArgs.slice(0, 5).concat(['--takeover'], startArgs.slice(5)));
  H.ok('加了 --takeover：接管，重起', u2.code === 0 && /^起来了：app/.test(lastLine(u2)) && !alive(userPid), u2.out);
  tool(['stop', '--all']);
  await waitOpen(false);
  // 过期的记录（电脑重启过）：那个端口后来被别的程序占了，stop --all 不能把它停掉
  const other = H.tempDir('dev-other');
  fs.writeFileSync(path.join(other, 'srv.js'), fs.readFileSync(path.join(proj, 'srv.js')));
  const otherPid = runDetached([path.join(other, 'srv.js'), String(PORT), 'other'], other);
  await waitOpen(true);
  fs.mkdirSync(path.join(proj, '.vibe', 'run'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.vibe', 'run', 'old.json'), JSON.stringify({ name: 'old', port: PORT, pid: 999999, startedAt: Date.now() - 86400000, upAt: Date.now() - 86400000 + 5000, cmd: 'node srv.js', tree: [{ pid: 999998, name: 'node.exe', created: Date.now() - 86400000 }] }));
  const st1 = tool(['stop', '--all']);
  H.ok('过期的记录：无法确认归属时没有停别的程序', alive(otherPid) && (await open(PORT)) && /无法确认归属，没有动它/.test(st1.out), [st1.out, otherPid]);
  try { process.kill(otherPid); } catch (e) { /* 已经没了 */ }
  try { const p = JSON.parse(fs.readFileSync(path.join(proj, 'pids.json'), 'utf8')); for (const x of [p.srv, p.helper]) { try { process.kill(x); } catch (e) { /* 没了 */ } } } catch (e) { /* 没有 */ }
  await waitOpen(false);

  H.section('先占端口、过几秒才答 HTTP 的（Tomcat 那种，1017）');
  // 服务用 lib/fake-idea.js 的 __service：一起来就占端口，过 SLOW_MS 才答（之前来的请求挂着）。答的是 v.txt 的内容。
  // 模型紧接着调接口的超时给 2 秒：只看端口就说起来了的话，这一下拿不到内容
  const SLOW_MS = 10000;
  const get = (timeout) => new Promise((resolve) => { const g = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout, agent: false }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => resolve(t.trim())); }); g.on('timeout', () => { g.destroy(); resolve('ERR timeout'); }); g.on('error', (e) => resolve('ERR ' + e.code)); });
  H.write(path.join(proj, 'v.txt'), 'slow-v1\n');
  const slowArgs = (extra) => ['start', '--name', 'slow', '--port', String(PORT)].concat(extra || [], ['--', 'node', path.join(__dirname, 'lib', 'fake-idea.js'), '__service', String(PORT), proj, String(SLOW_MS)]);
  const slowRec = () => { try { return JSON.parse(fs.readFileSync(path.join(proj, '.vibe', 'run', 'slow.json'), 'utf8')); } catch (e) { return null; } };
  const w1 = tool(slowArgs());
  const got1 = await get(2000);
  H.ok('"起来了"之后第一次请求就拿到内容（端口通了还要等它答 HTTP）', w1.code === 0 && /^起来了：slow，端口 \d+/.test(lastLine(w1)) && got1 === 'slow-v1', [lastLine(w1), got1]);
  tool(['stop', '--name', 'slow']);
  await waitOpen(false);
  const w2 = tool(slowArgs(['--wait', '2']));
  const kept = slowRec();
  H.ok('等超时的时候端口通着、还没答 HTTP：说清楚，记录留着', w2.code === 1 && /^没起来：端口 \d+ 通了，但 2 秒内一直没答 HTTP/.test(lastLine(w2)) && kept && !kept.upAt, [w2.out, kept]);
  const w3 = tool(slowArgs());
  const got3 = await get(2000);
  H.ok('再 start：接着等它答 HTTP，不重起；"起来了"之后第一次请求就拿到内容', w3.code === 0 && /slow 还在启动（进程 \d+，.*端口通了，上次没等到它答 HTTP）/.test(w3.out) && /^起来了：slow/.test(lastLine(w3)) && got3 === 'slow-v1' && kept && (slowRec() || {}).pid === kept.pid, [w3.out, got3]);
  tool(['stop', '--name', 'slow']);
  await waitOpen(false);
  // 一直不答 HTTP 的（不是网页服务，像 Dubbo 的端口）：连上了不说话
  H.write(path.join(proj, 'tcp.js'), "require('net').createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1');\n");
  const n1 = tool(['start', '--name', 'tcp', '--port', String(PORT), '--', 'node', 'tcp.js', String(PORT)]);
  H.ok('一直不答 HTTP 的：端口通了 60 秒也算起来，说了没答 HTTP', n1.code === 0 && /^起来了：tcp，端口 \d+，用了 \d+ 秒，端口通了 60 秒一直没答 HTTP/.test(lastLine(n1)), n1.out);
  tool(['stop', '--name', 'tcp']);
  await waitOpen(false);
  // 只听 ::1 的（Vite 这类只听 localhost 的，Node 17 起可能只在 ::1 上）：问 127.0.0.1 没人听，要再问 ::1，不能拖成 60 秒
  const v6 = await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(PORT, '::1', () => s.close(() => resolve(true))); });
  if (v6) {
    H.write(path.join(proj, 'v6.js'), "require('http').createServer((q, s) => s.end('v6')).listen(Number(process.argv[2]), '::1');\n");
    const s6 = tool(['start', '--name', 'v6', '--port', String(PORT), '--wait', '30', '--', 'node', 'v6.js', String(PORT)]);
    H.ok('只听 ::1 的网页服务：答了 HTTP 就算起来，不等 60 秒', s6.code === 0 && /^起来了：v6/.test(lastLine(s6)) && !/没答 HTTP/.test(lastLine(s6)), s6.out);
    tool(['stop', '--name', 'v6']);
  } else console.log('  （这台电脑听不了 ::1，跳过只听 ::1 的那一项）');

  H.section('起不来：最后一行说清没起来');
  const f = tool(['start', '--name', 'bad', '--port', String(PORT), '--wait', '5', '--', 'node', '-e', 'process.exit(3)']);
  H.ok('退出码 1，最后一行是"没起来"', f.code === 1 && /^没起来：/.test(lastLine(f)), f.out);

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('起服务 0929');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); try { tool(['stop', '--all']); } catch (x) { /* 停不了 */ } H.cleanup(); process.exit(2); });
