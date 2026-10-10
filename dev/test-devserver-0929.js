'use strict';
/*
 * 起服务的工具（kit/tools/devserver.js），0929 反馈里的一条：
 *   F20260928-011   stop && start 串起来重启：看不到"起来了"那一行；反复几次之后两个 java 一起跑
 * 拿一个 node 写的小服务当被测的服务。全程盯着桌面，结尾查没有留下进程。
 * 用法：node dev/test-devserver-0929.js [端口，默认 18781]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18781;
const h = H.makeHome('dev0929');
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
  H.ok('起它的程序已经不在了：停掉重起', o1.code === 0 && /起它的程序已经不在了/.test(o1.out) && !alive(orphan.srv) && /^起来了：app/.test(lastLine(o1)), [o1.out, orphan]);
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

  H.section('起不来：最后一行说清没起来');
  const f = tool(['start', '--name', 'bad', '--port', String(PORT), '--wait', '5', '--', 'node', '-e', 'process.exit(3)']);
  H.ok('退出码 1，最后一行是"没起来"', f.code === 1 && /^没起来：/.test(lastLine(f)), f.out);

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('起服务 0929');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); try { tool(['stop', '--all']); } catch (x) { /* 停不了 */ } H.cleanup(); process.exit(2); });
