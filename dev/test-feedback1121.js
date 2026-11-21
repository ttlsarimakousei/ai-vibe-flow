'use strict';
/*
 * 多角度全量审核查出的问题（2026-11-21，docs/feedback-20261121.md，报告 reviews/claude/20261121-vibe-kit-多角度全量审核.md）：
 *   B1 锁文件是空的、一片 0、没有进程号（断电时链接落了盘、内容没落盘）：5 秒没动就按失效收回；刚写的、活进程拿着的照旧不抢
 *   B2 guard-ask 调技能那一段出错：照旧放行，但记一条问题反馈
 *   B3 guard-commit 载入时就崩（自动更新覆盖到一半）：命令里像推送的照样要用户确认，别的放行
 *   A4 查库工具：查询里调了会改库的函数（setval、pg_terminate_backend……）不当查询跑，exec 要人点头
 *   C  文档过时、没人调用的 lib/pull.js
 * 用法：node dev/test-feedback1121.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCDIR = FROM || H.SRC;

H.section('B1 坏掉的锁文件收得回来');
{
  const h = H.makeHome('t1121-lock', FROM);
  const SS = require(path.join(h.kit, 'lib', 'state-store.js'));
  const dir = path.join(h.kit, 'state');
  const ago = (ms) => new Date(Date.now() - ms);
  const put = (f, body, ms) => { fs.writeFileSync(f, body); if (ms) fs.utimesSync(f, ago(ms), ago(ms)); };
  for (const [name, body] of [['空的', Buffer.alloc(0)], ['一片 0', Buffer.alloc(120)], ['没有进程号', Buffer.from('{}')], ['不是 JSON', Buffer.from('{"pid":12')]]) {
    const f = path.join(dir, 'lk-' + Buffer.from(name).toString('hex').slice(0, 8) + '.json');
    put(f + '.lock', body, 60000);
    const t0 = Date.now();
    const r = SS.update(f, (o) => { o.n = 1; });
    H.ok('锁文件' + name + '、一分钟没动：收回来，写进去了，不用等满 2 秒', !!r && r.n === 1 && Date.now() - t0 < 1500, { r, ms: Date.now() - t0 });
  }
  {
    const f = path.join(dir, 'lk-fresh.json');
    put(f + '.lock', Buffer.alloc(120), 0);
    H.ok('一片 0 的锁刚写下（不到 5 秒）：不动', SS.update(f, (o) => { o.n = 1; }) === null && fs.existsSync(f + '.lock'));
  }
  {
    const f = path.join(dir, 'lk-live.json');
    put(f + '.lock', JSON.stringify({ pid: process.pid, thread: 0, token: 'live', at: Date.now() - 60000 }), 60000);
    H.ok('活着的进程拿着的锁（一分钟没动）：照旧不抢', SS.update(f, (o) => { o.n = 1; }) === null && JSON.parse(fs.readFileSync(f + '.lock', 'utf8')).token === 'live');
  }
  {
    const f = path.join(dir, 'lk-recover.json');
    put(f + '.lock.recover', Buffer.alloc(80), 120000);
    const r = SS.update(f, (o) => { o.n = 2; });
    H.ok('收回锁用的 .recover 也坏了（两分钟没动）：删掉，照常拿锁', !!r && r.n === 2 && !fs.existsSync(f + '.lock.recover'), r);
  }
  {
    const f = path.join(dir, 'lk-recover2.json');
    put(f + '.lock.recover', Buffer.alloc(80), 10000);
    H.ok('.recover 坏了、才 10 秒：先不删（别人可能正拿着它收锁）', SS.update(f, (o) => { o.n = 3; }) === null && fs.existsSync(f + '.lock.recover'));
  }
}

H.section('B2 guard-ask 调技能那一段出错：放行，记一条问题反馈');
{
  const h = H.makeHome('t1121-ask', FROM);
  const proj = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n' });
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  S.entryVoice = () => { throw new Error('探针：进流程的判断出错了'); };
  const G = require(path.join(h.kit, 'hooks', 'guard-ask.js'));
  let out; let threw = false;
  try { out = G.handle({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'opsx:propose' }, session_id: 't1121-skill', cwd: proj }); } catch (e) { threw = String(e); }
  H.ok('出错照旧放行（不拦、不抛）', !threw && out === null, threw || out);
  const fb = path.join(h.kit, 'feedback');
  const recs = fs.existsSync(fb) ? fs.readdirSync(fb).filter((n) => /\.md$/.test(n)).map((n) => H.read(path.join(fb, n))).join('\n') : '';
  H.ok('记了一条问题反馈，说是 guard-ask 调技能那一段、带着错误信息', /guard-ask 调技能/.test(recs) && /探针：进流程的判断出错了/.test(recs), recs.slice(0, 600));
}

H.section('B3 guard-commit 载入时就崩了：像推送的要确认，别的放行');
{
  const h = H.makeHome('t1121-load', FROM);
  const proj = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n' });
  const run = (command) => H.hook(h, 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't1121-load', cwd: proj }, { spawn: true });
  const intact = run('git push');
  H.ok('（库是好的：git push 照旧按"用户没说推送"拦下，兜底不插手）', !!intact && intact.decision === 'block' && !/没载入成功/.test(JSON.stringify(intact)), intact);
  // 自动更新拷到一半：guard-git.js 只剩半截
  fs.writeFileSync(path.join(h.kit, 'lib', 'guard-git.js'), "'use strict';\nmodule.exports = {\n  pushAnywhere(cmd) {\n");
  const push = run('git -C sub push origin main');
  const hs = (push && push.hookSpecificOutput) || {};
  H.ok('库坏了、命令里有 git push：要用户确认，说清是检查没载入成功', hs.permissionDecision === 'ask' && /没载入成功/.test(hs.permissionDecisionReason || ''), push);
  H.ok('库坏了、普通命令：照旧放行（什么都不说）', run('ls src') === null);
  const fb = path.join(h.kit, 'feedback');
  const recs = fs.existsSync(fb) ? fs.readdirSync(fb).filter((n) => /\.md$/.test(n)).map((n) => H.read(path.join(fb, n))).join('\n') : '';
  H.ok('记了一条问题反馈：guard-commit 载入出错', /guard-commit（载入）/.test(recs), recs.slice(0, 600));
}

H.section('A4 查库工具：查询里调了会改库的函数，不当查询跑');
{
  const PY = H.runtime('auto').python;
  if (!PY) console.log('  （这台电脑找不到 Python，跳过这一节）');
  else {
    const scripts = path.join(SRCDIR, 'claude', 'skills', 'vk-db-crud', 'scripts');
    const code = [
      'import sys, json', 'sys.dont_write_bytecode = True', 'sys.path.insert(0, ' + JSON.stringify(scripts) + ')', 'import sqlguard as g',
      'out = {}',
      'for d, sql in json.loads(sys.argv[1]):',
      '    st = g.analyze(sql, d)[0]',
      '    out[sql] = {"kind": st.kind, "level": g.classify(st).level, "ro": g.readonly_problem(st), "fn": getattr(st, "side_effect", None)}',
      'out["where"] = g.fragment_problem("pg_terminate_backend(PID) IS NOT NULL", "--where", "postgresql")',
      'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const sqls = [['postgresql', "SELECT setval('seq_order', 1)"], ['postgresql', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity'], ['postgresql', "SELECT currval('seq_order')"], ['postgresql', "INSERT INTO t(id) VALUES (nextval('seq_order'))"]];
    const r = spawnSync(PY, ['-B', '-X', 'utf8', '-c', code, JSON.stringify(sqls)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let o = {}; try { o = JSON.parse(String(r.stdout).trim()); } catch (e) { o = {}; }
    const a = o[sqls[0][1]] || {}; const b = o[sqls[1][1]] || {}; const c = o[sqls[2][1]] || {}; const d = o[sqls[3][1]] || {};
    H.ok('SELECT setval：不算查询（query 拦），exec 按看不懂的语句、要确认，记下函数名', a.kind === 'UNKNOWN' && a.level === 'DANGEROUS' && /setval/.test(a.ro || '') && a.fn === 'setval', [a, r.stderr]);
    H.ok('SELECT pg_terminate_backend：一样', b.kind === 'UNKNOWN' && !!b.ro && b.fn === 'pg_terminate_backend', b);
    H.ok('SELECT currval：只读，照常查', c.kind === 'SELECT' && c.ro === null && c.level === 'SAFE', c);
    H.ok('INSERT 里用 nextval：照旧是 INSERT', d.kind === 'INSERT', d);
    H.ok('peek 的 --where 里调 pg_terminate_backend：不行', typeof o.where === 'string' && /pg_terminate_backend/.test(o.where), o.where);
  }
}

H.section('A3 Read 读令牌：权限规则认不出的几种写法，钩子按真实路径拦');
{
  const h = H.makeHome('t1121-read', FROM);
  const sec = path.join(h.kit, 'secrets.json');
  fs.writeFileSync(sec, '{"token":"t1121"}');
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), '{"key":"t1121"}');
  const proj = H.makeRepo(path.join(h.work, 'shop'), { 'a.txt': 'a\n' });
  // 8.3 短名：cmd 的 for %~sI（原样交给 cmd，不让 Node 改引号）；这个盘没开短名就是原样
  const sh = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d /s /c "for %I in ("' + sec + '") do @echo %~sI"'], { encoding: 'utf8', windowsHide: true, timeout: 10000, windowsVerbatimArguments: true });
  const short = (String(sh.stdout || '').trim().split(/\r?\n/).pop() || '').replace(/^(?![A-Za-z]:\\).*$/, '') || sec;
  const link = path.join(h.work, 'kitlink');
  spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mklink', '/J', link, h.kit], { windowsHide: true, timeout: 10000 });
  const drive = sec[0];
  const read = (file) => H.hook(h, 'guard-read', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, session_id: 't1121-read', cwd: proj }, { spawn: true });
  const blocked = (o) => !!o && o.decision === 'block' && /放令牌、放模型 key/.test(H.reasonOf(o));
  const cases = [
    ['正常写法', sec],
    ['8.3 短名' + (short === sec ? '（这个盘没开短名）' : ''), short],
    ['\\\\?\\ 前缀', '\\\\?\\' + sec],
    ['\\\\localhost\\C$ 管理共享', '\\\\localhost\\' + drive + '$' + sec.slice(2)],
    ['//127.0.0.1/c$ 正斜杠', '//127.0.0.1/' + drive.toLowerCase() + '$' + sec.slice(2).split('\\').join('/')],
    ['\\\\本机名\\C$', '\\\\' + require('os').hostname() + '\\' + drive + '$' + sec.slice(2)],
    ['目录联接', path.join(link, 'secrets.json')],
    ['~ 开头', '~/.claude/vibe-kit/secrets.json'],
    ['router-data 下的，\\\\?\\ 前缀', '\\\\?\\' + path.join(h.kit, 'router-data', 'config.json')],
  ];
  for (const [name, file] of cases) { const o = read(file); H.ok('Read ' + name + '：拦下', blocked(o), [file, o]); }
  H.ok('同目录的 config.json：照常读', read(path.join(h.kit, 'config.json')) === null);
  H.ok('项目里的文件：照常读', read(path.join(proj, 'a.txt')) === null);
  H.ok('别的电脑的共享（\\\\other-pc\\C$）：不当成本机', read('\\\\other-pc-t1121\\' + drive + '$' + sec.slice(2)) === null);
  const inst = H.read(path.join(SRCDIR, 'install.js')) || '';
  H.ok('安装器登记 guard-read 时管 Read 和 Grep', /matcher: 'Grep\|Read', hooks: \[fast\('guard-read'\)\]/.test(inst));
  // 跑命令那一道：\\?\ 里的 ? 不当通配符，先换成普通写法再算真实路径
  const cmd = (tool, command) => H.hook(h, 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, session_id: 't1121-read', cwd: proj }, { spawn: true });
  H.ok('Bash：cat "\\\\?\\<短名>" 拦下', blocked(cmd('Bash', 'cat "\\\\?\\' + short + '"')));
  H.ok('PowerShell：Get-Content 管理共享的写法 拦下', blocked(cmd('PowerShell', "Get-Content '\\\\localhost\\" + drive + '$' + short.slice(2) + "'")));
  // 复审 R1：卷 GUID 写法（\\?\Volume{…}\…）去掉前缀会成了相对路径，要留给 realpath 还原成盘符
  let guid = '';
  try { guid = String(spawnSync('mountvol', [drive + ':\\', '/L'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout || '').trim().replace(/\\$/, ''); } catch (e) { guid = ''; }
  if (!/^\\\\\?\\Volume\{/.test(guid)) console.log('  （这台电脑取不到卷 GUID，跳过卷 GUID 那几项）');
  else {
    H.ok('Read 卷 GUID 写法（\\\\?\\Volume{…}\\…）：拦下', blocked(read(guid + sec.slice(2))), guid + sec.slice(2));
    H.ok('Read 卷 GUID 加短名：拦下', blocked(read(guid + short.slice(2))));
    H.ok('Bash：cat 卷 GUID 加短名 拦下', blocked(cmd('Bash', 'cat "' + guid + short.slice(2) + '"')));
  }
  // MCP 工具的路径字段：guard-mcp 交给 guard-read 和 realish，几种写法一样认
  const mcp = (input) => H.hook(h, 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'mcp__files__read_file', tool_input: input, session_id: 't1121-read', cwd: proj }, { spawn: true });
  const mcpBlocked = (o) => !!o && o.decision === 'block' && /令牌/.test(H.reasonOf(o));
  H.ok('MCP：路径字段写 \\\\?\\<短名>，拦下', mcpBlocked(mcp({ path: '\\\\?\\' + short })));
  H.ok('MCP：路径字段写管理共享加短名，拦下', mcpBlocked(mcp({ path: '\\\\localhost\\' + drive + '$' + short.slice(2) })));
  if (/^\\\\\?\\Volume\{/.test(guid)) H.ok('MCP：路径字段写卷 GUID 加短名，拦下', mcpBlocked(mcp({ path: guid + short.slice(2) })));
  H.ok('MCP：读项目里的文件，放行', mcp({ path: path.join(proj, 'a.txt') }) === null);
}

H.section('复审 R3 安装器拷文件先写临时文件再改名，正在载入的钩子读不到半截');
{
  const h = H.freshHome('t1121-inst');
  const install = () => H.node(h, path.join(SRCDIR, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  const first = install();
  H.ok('（装上了）', first.code === 0, first.out + first.err);
  // 第二遍是覆盖已有的文件：边装边有人一直读 guard-commit.js，读到的每一次都要是完整的
  const target = path.join(h.kit, 'hooks', 'guard-commit.js');
  const want = fs.readFileSync(path.join(SRCDIR, 'kit', 'hooks', 'guard-commit.js'));
  const log = path.join(h.root, 'reads.json');
  const reader = require('child_process').spawn(process.execPath, ['-e', [
    "const fs = require('fs'); const want = " + want.length + "; let n = 0, bad = 0, miss = 0; const end = Date.now() + 60000;",
    "const stop = () => { fs.writeFileSync(" + JSON.stringify(log) + ", JSON.stringify({ n, bad, miss })); process.exit(0); };",
    "process.on('SIGTERM', stop); setInterval(() => { if (fs.existsSync(" + JSON.stringify(log + '.stop') + ") || Date.now() > end) stop(); }, 50);",
    "(function loop() { for (let i = 0; i < 200; i++) { try { const b = fs.readFileSync(" + JSON.stringify(target) + "); n++; if (b.length !== want) bad++; } catch (e) { miss++; } } setImmediate(loop); })();",
  ].join('\n')], { windowsHide: true, stdio: 'ignore' });
  const again = install();
  fs.writeFileSync(log + '.stop', '');
  const t0 = Date.now(); while (!fs.existsSync(log) && Date.now() - t0 < 10000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  try { reader.kill(); } catch (e) { /* 已经退了 */ }
  let r = {}; try { r = JSON.parse(fs.readFileSync(log, 'utf8')); } catch (e) { r = {}; }
  H.ok('（覆盖安装也装上了）', again.code === 0, again.out + again.err);
  H.ok('装的时候一直读 guard-commit.js：没读到过半截、也没读不到', r.n > 0 && r.bad === 0 && r.miss === 0, r);
  const left = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.vk-copy-\d+\.tmp$/.test(e.name)) left.push(p); } };
  walk(h.cfg);
  H.ok('装完没有留下拷贝用的临时文件', left.length === 0, left.slice(0, 5));
  H.ok('装上的钩子和包里的一样', fs.readFileSync(target).equals(want));
  H.ok('安装器拷文件先写临时文件、再改名换掉', /function copyFile[\s\S]{0,600}copyFileSync\(s, tmp\)[\s\S]{0,300}renameSync\(tmp, d\)/.test(H.read(path.join(SRCDIR, 'install.js')) || ''));
}

H.section('A1、C 说明和代码对上、没人调用的 lib/pull.js 删掉');
{
  const read = (rel) => H.read(path.join(SRCDIR, rel)) || '';
  const readme = read('README.md');
  const ui = read('kit/ui/ui.html');
  H.ok('README：到点留给用户的只有认得出的那几种，删单个文件、直连数据库、MCP 到点照样按允许', /删单个文件、直连数据库的客户端（`mysql -e`、`psql -c`）、MCP 工具、改 `~\/\.claude` 下的文件，到点照样按允许/.test(readme));
  H.ok('配置页：同样的说法', /删单个文件、直连数据库的客户端（mysql -e、psql -c）、MCP 工具、改 ~\/\.claude 下的文件，到点照样按允许/.test(ui));
  // 说的和做的一样：README 说到点放行的这几条，ask-timeout 真的不拦；说留给用户的，真的拦
  const at = H.read(path.join(SRCDIR, 'kit', 'hooks', 'ask-timeout.js')) || '';
  const m = /const DESTRUCTIVE = (\/.*\/[a-z]*);/.exec(at);
  let D = null; try { D = m ? new Function('return ' + m[1])() : null; } catch (e) { D = null; }
  H.ok('说明和 DESTRUCTIVE 对得上：rm 单个文件、git checkout -- 文件不在里面，rm -rf、git checkout -- . 在里面', !!D && !D.test('rm src/A.java') && !D.test('git checkout -- src/A.java') && D.test('rm -rf target') && D.test('git checkout -- .'));
  H.ok('手册：不再说"自动审核到 10 轮就停"', !/10 轮就停/.test(read('手册/开关一览.md')));
  H.ok('lib/pull.js 没了，安装器升级时删它', !fs.existsSync(path.join(SRCDIR, 'kit', 'lib', 'pull.js')) && /DROPPED_FILES = \[[^\]]*'lib\/pull\.js'/.test(read('install.js')));
  H.ok('使用情况的统计里没有"拉代码"那一行了', !/\['拉代码'/.test(read('kit/lib/usage.js')));
}

H.done('全量审核这一批（B1、B2、B3、A4、A3、C）');
