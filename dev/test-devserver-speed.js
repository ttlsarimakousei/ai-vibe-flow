'use strict';
/*
 * devserver 慢（问题表第 20 条、审核第五节，2026-10-30，docs/feedback-20261030.md 的 C 批）：
 *   C1 "服务起来之后代码改过没有"按内容判断：起服务时记下 HEAD 和改动文件的内容，之后比内容。md、openspec、docs、src/test、
 *      运行时写出来的日志和库文件不算；只是提交了不算；删掉、改名算。以前按修改时间，打个勾、改个 md、提交一次都要整轮重启，删文件反而不算
 *   C2 一次调用只查一份进程表：以前每查一个进程起一个 PowerShell（一次 1—3 秒），一次 start 要起好几个
 * 用法：node dev/test-devserver-speed.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;

H.section('C1 改过没有按内容算：md、openspec、src/test、日志不算，只是提交不算；删文件、改 pom 算');
{
  const h = H.makeHome('tds-c1', FROM);
  const proj = H.makeRepo(path.join(h.work, 'proj'), {
    'pom.xml': '<project/>\n', 'README.md': '# 说明\n', '.gitignore': '.vibe/\ntarget/\n',
    'src/main/java/A.java': 'class A {}\n', 'src/main/java/B.java': 'class B {}\n', 'src/main/resources/app.yml': 'a: 1\n',
    'src/test/java/ATest.java': 'class ATest {}\n', 'openspec/changes/x/tasks.md': '- [ ] 1.1 改 A\n',
  });
  // 起服务时工作区里已经有一处没提交的改动
  H.write(path.join(proj, 'src', 'main', 'java', 'B.java'), 'class B { int dirty; }\n');
  const code = [
    'const D = require(' + JSON.stringify(path.join(h.kit, 'tools', 'devserver.js')) + ');',
    'const fs = require("fs"), path = require("path"), cp = require("child_process");',
    'const proj = process.argv[1];',
    'const git = (...a) => cp.execFileSync("git", ["-C", proj].concat(a), { stdio: "ignore" });',
    'const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), t); };',
    'const snap = D.codeSnap ? D.codeSnap(proj) : null;',
    'const t = Date.now() - 1000;',
    'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    'const ch = () => D.changedSince(t, proj, snap);',
    'const out = {};',
    'sleep(1200);',
    'w("README.md", "# 说明\\n改了\\n"); out.md = ch();',
    'w("openspec/changes/x/tasks.md", "- [x] 1.1 改 A\\n"); out.tick = ch();',
    'w("src/test/java/ATest.java", "class ATest { int t; }\\n"); out.test = ch();',
    'w("app.log", "日志\\n"); w("data/db.mv.db", "x"); out.runtime = ch();',
    'git("add", "-A"); git("commit", "-qm", "提交一下"); out.commit = ch();',
    'w("src/main/java/A.java", "class A { int x; }\\n"); out.edit = ch();',
    'w("src/main/java/A.java", "class A {}\\n"); out.revert = ch();',
    'fs.unlinkSync(path.join(proj, "src/main/java/A.java")); out.del = ch();',
    'git("checkout", "--", "src/main/java/A.java");',
    'w("pom.xml", "<project><x/></project>\\n"); out.pom = ch();',
    'console.log(JSON.stringify(out));',
  ].join('\n');
  const r = H.node(h, '-e', [code, proj], { cwd: proj, timeout: 120000 });
  let o = {}; try { o = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { o = {}; }
  const none = (k) => Array.isArray(o[k]) && o[k].length === 0;
  const has = (k, re) => Array.isArray(o[k]) && o[k].some((f) => re.test(f));
  H.ok('改 README.md：不算改过', none('md'), o.md || r.out + r.err);
  H.ok('在 tasks.md 里打勾：不算改过', none('tick'), o.tick);
  H.ok('改 src/test：不算改过', none('test'), o.test);
  H.ok('服务写出来的日志、H2 库文件：不算改过', none('runtime'), o.runtime);
  H.ok('只是把起服务前就改着的 B.java 提交了（内容没变）：不算改过', none('commit'), o.commit);
  H.ok('改了 src/main 的 A.java：算改过', has('edit', /A\.java$/), o.edit);
  H.ok('又改回去了（内容和起服务时一样）：不算改过', none('revert'), o.revert);
  H.ok('删了 A.java：算改过', has('del', /A\.java$/), o.del);
  H.ok('改了 pom.xml：算改过', has('pom', /pom\.xml$/), o.pom);
}

H.section('C2 一次调用只查一份进程表：查几个进程不再各起一个 PowerShell');
if (process.platform !== 'win32') console.log('  （不是 Windows，跳过）');
else {
  const h = H.makeHome('tds-c2', FROM);
  // 数 devserver 起了几次 powershell：把 child_process.execFileSync 包一层
  const code = [
    'const cp = require("child_process"); const real = cp.execFileSync; let ps = 0;',
    'cp.execFileSync = function (f, ...a) { if (/powershell/i.test(String(f))) ps++; return real.call(this, f, ...a); };',
    'const D = require(' + JSON.stringify(path.join(h.kit, 'tools', 'devserver.js')) + ');',
    'const pids = [process.pid, process.ppid];',
    'const t0 = Date.now();',
    'const infos = pids.map((p) => D.procInfo(p)); const table = D.procTable(); const again = pids.map((p) => D.procInfo(p));',
    'console.log(JSON.stringify({ ps, ms: Date.now() - t0, name: infos[0].name, cmd: !!infos[0].cmd, table: table.length, again: again[1].pid }));',
  ].join('\n');
  const r = H.node(h, '-e', [code], { cwd: h.root, timeout: 120000 });
  let o = {}; try { o = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { o = {}; }
  H.ok('查到了进程的名字和命令行', /node/i.test(o.name || '') && o.cmd === true && o.table > 5, o);
  H.ok('查两个进程、取一次进程表、再查两次：只起了 1 个 PowerShell（以前 5 个）', o.ps === 1, o);
}

H.section('C3 命令跑完记证据：只算命令针对的仓库；版本查询、curl 不记；分类；环境指纹不含 PATH');
{
  const h = H.makeHome('tds-c3', FROM);
  const shell = H.makeRepo(path.join(h.work, 'shell'), { 'README.md': '# 壳子\n', '.gitignore': 'sub/\n' });
  const sub = H.makeRepo(path.join(shell, 'sub'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n' });
  const code = [
    'const E = require(' + JSON.stringify(path.join(h.kit, 'lib', 'evidence.js')) + ');',
    'const shell = process.argv[1];',
    'const a = (command) => { const r = E.actual({ tool_name: "Bash", cwd: shell, tool_input: { command }, tool_response: { stdout: "BUILD SUCCESS" } }); return r ? { root: r.root.replace(/\\\\/g, "/").toLowerCase(), kind: r.kind } : null; };',
    'const out = {',
    '  f: a("mvn -q -o -f sub/pom.xml compile"),',
    '  prefix: a("npm --prefix sub run build"),',
    '  ver: a("java -version"), nodev: a("node --version"),',
    '  curl: a("curl -s http://127.0.0.1:8080/api/x"),',
    '  test: a("mvn -q -f sub/pom.xml test"), tc: a("mvn -q -f sub/pom.xml test-compile"), skip: a("mvn -q -f sub/pom.xml package -DskipTests"),',
    '  other: a("node sub/tools/gen.js"),',
    '  pkg: a("mvn -q -f sub/pom.xml package"), chk: a("node --check sub/a.js"), apit: a("node sub/scripts/api-test.js"), gitc: a("git -C ../other status; node a.js"),',
    '  env: E.environment(shell),',
    '};',
    'console.log(JSON.stringify(out));',
  ].join('\n');
  const run = (extraPath) => { const r = H.node(h, '-e', [code, shell], { cwd: shell, env: { PATH: extraPath + path.delimiter + process.env.PATH }, timeout: 60000 }); try { return JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { return { err: r.out + r.err }; } };
  const o = run('C:\\vk-a');
  const o2 = run('C:\\vk-b');
  const subKey = sub.replace(/\\/g, '/').toLowerCase();
  H.ok('mvn -f sub/pom.xml：记在 sub 这个仓库（以前不记）', !!o.f && o.f.root === subKey && o.f.kind === 'compile', o.f || o.err);
  H.ok('npm --prefix sub：记在 sub', !!o.prefix && o.prefix.root === subKey, o.prefix);
  H.ok('java -version、node --version：不记', o.ver === null && o.nodev === null, [o.ver, o.nodev]);
  H.ok('curl 探一下接口：不记', o.curl === null, o.curl);
  H.ok('分类：test 是测试，test-compile、-DskipTests 的 package 是编译检查，node 跑脚本是 other', o.test && o.test.kind === 'test' && o.tc && o.tc.kind === 'compile' && o.skip && o.skip.kind === 'compile' && o.other && o.other.kind === 'other', [o.test, o.tc, o.skip, o.other]);
  H.ok('和手册的表一致：不跳过测试的 mvn package 算自测，node --check 算快检，名字带 test 的脚本算自测', o.pkg && o.pkg.kind === 'test' && o.chk && o.chk.kind === 'compile' && o.apit && o.apit.kind === 'test', [o.pkg, o.chk, o.apit]);
  H.ok('git -C 指到别处的：照旧不记', o.gitc === null, o.gitc);
  H.ok('PATH 不一样，环境指纹一样（命令方式和 HTTP 方式的钩子 PATH 不同）', !!o.env && o.env === o2.env, [o.env, o2.env]);
}

H.done('devserver 提速（C 批）');
