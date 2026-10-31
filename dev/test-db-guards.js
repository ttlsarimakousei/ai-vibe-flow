'use strict';
/*
 * 查库、redis 的几道保护（2026-10-30，docs/feedback-20261030.md 的 D 批，来源 Codex 三轮审核）：
 *   D1 一个确认串只能执行一次：两个进程读到同一份登记，以前各取到一次（Codex C01、F11）
 * 用法：node dev/test-db-guards.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）。要本机装着 Python（dev/README.md"运行环境"）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const RT = H.runtime('auto');
const json = (t) => { try { return JSON.parse(String(t || '').trim().split(/\r?\n/).pop()); } catch (e) { return null; } };

H.section('D1 确认串只能用一次：第二个进程读到的是取走之前的登记，也取不到');
if (!RT.python) console.log('  （没找到 Python，跳过）');
else {
  const h = H.makeHome('tdg-d1', FROM);
  const dir = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts');
  const script = path.join(h.root, 'd1.py');
  H.write(script, [
    'import sys, json',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, sys.argv[1])',
    'import journal',
    "journal.pending_put('vk-test-token', 'vk-fp')",
    'before = journal._pending_load()',
    "first = journal.pending_take('vk-test-token', 'vk-fp')",
    '# 模拟另一个进程：它读登记文件时，第一个进程还没写回，读到的是取走之前的那一份',
    'journal._pending_load = lambda: dict(before)',
    "second = journal.pending_take('vk-test-token', 'vk-fp')",
    "print(json.dumps({'first': first[0], 'second': second[0], 'why': second[1]}, ensure_ascii=False))",
  ].join('\n') + '\n');
  const r = H.run(h, RT.python, ['-B', script, dir], { cwd: h.root });
  const o = json(r.out) || {};
  H.ok('第一个进程取到了', o.first === true, r.out + r.err);
  H.ok('第二个进程读到旧登记也取不到（一个确认串最多执行一次）', o.second === false && /另一个进程用了/.test(o.why || ''), o);
}

H.section('D2 提交那一步出错（库那边已经提交、回话丢了）：报"结果不明"，不说"已经回滚"');
if (!RT.java || !RT.h2) console.log('  （没找到 Java 或 H2 的驱动，跳过）');
else {
  const h = H.makeHome('tdg-d2', FROM);
  const runner = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts', 'runner');
  const work = path.join(h.root, 'd2');
  // 用 H2 当真库，连接外面包一层代理：commit() 先真提交，再抛"连接断开"——就是"已经提交、回话丢了"
  H.write(path.join(work, 'VkCommitLost.java'), [
    'import java.io.*; import java.lang.reflect.*; import java.sql.*; import java.util.*;',
    'public class VkCommitLost {',
    '  public static void main(String[] a) throws Exception {',
    '    Class.forName("org.h2.Driver");',
    '    final Connection real = DriverManager.getConnection("jdbc:h2:mem:vk;DB_CLOSE_DELAY=-1", "sa", "");',
    '    real.createStatement().execute("create table t(id int primary key, v int)");',
    '    real.createStatement().execute("insert into t values (1, 1)");',
    '    real.setAutoCommit(false);',
    '    Connection conn = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] { Connection.class }, new InvocationHandler() {',
    '      public Object invoke(Object p, Method m, Object[] args) throws Throwable {',
    '        if (m.getName().equals("commit")) { real.commit(); throw new SQLException("simulated: connection reset after commit"); }',
    '        try { return m.invoke(real, args); } catch (InvocationTargetException e) { throw e.getCause(); }',
    '      }',
    '    });',
    '    ByteArrayOutputStream bos = new ByteArrayOutputStream();',
    '    PrintStream ps = new PrintStream(bos, true, "UTF-8");',
    '    Class<?> k = Class.forName("DbRunner");',
    '    Constructor<?> c = k.getDeclaredConstructor(PrintStream.class, String.class, String.class); c.setAccessible(true);',
    '    Object r = c.newInstance(ps, "", "");',
    '    Method apply = k.getDeclaredMethod("doApply", Connection.class, Map.class, List.class); apply.setAccessible(true);',
    '    List<String[]> segs = new ArrayList<String[]>(); segs.add(new String[] { "write", "update t set v = 2 where id = 1" });',
    '    apply.invoke(r, conn, new HashMap<String, String>(), segs);',
    '    ResultSet rs = real.createStatement().executeQuery("select v from t where id = 1"); rs.next();',
    '    System.out.println("VALUE " + rs.getInt(1));',
    '    System.out.println(new String(bos.toByteArray(), "UTF-8").trim());',
    '  }',
    '}',
  ].join('\n') + '\n');
  const javac = path.join(path.dirname(RT.java), 'javac.exe');
  const cp = [work, runner, RT.h2].join(path.delimiter);
  const comp = H.run(h, javac, ['-encoding', 'UTF-8', '-cp', [runner, RT.h2].join(path.delimiter), '-d', work, path.join(work, 'VkCommitLost.java')], { timeout: 120000 });
  H.ok('测试用的类编译通过', comp.code === 0, comp.out + comp.err);
  const r = H.run(h, RT.java, ['-cp', cp, 'VkCommitLost'], { timeout: 120000 });
  const lines = (r.out || '').trim().split(/\r?\n/);
  const value = Number(((lines.find((l) => /^VALUE /.test(l)) || '').split(' ')[1]));
  const o = json(lines.filter((l) => /^\{/.test(l)).pop()) || {};
  H.ok('库里其实已经改了（模拟的就是提交成功、回话丢了）', value === 2, r.out + r.err);
  H.ok('执行器报 UNKNOWN_OUTCOME，不报 SQL_ERROR', o.ok === false && o.code === 'UNKNOWN_OUTCOME', o);
}

H.section('C9（P33）公共目录里几个版本的驱动：按版本号挑最新的，不按字典序');
if (!RT.python) console.log('  （没找到 Python，跳过）');
else {
  const h = H.makeHome('tdg-p33', FROM);
  const dir = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts');
  const jars = path.join(h.root, 'drivers');
  for (const v of ['8.1.2.9', '8.1.3.62', '8.1.3.140']) H.write(path.join(jars, 'DmJdbcDriver18-' + v + '.jar'), 'x');
  const r = H.run(h, RT.python, ['-B', '-c', 'import sys, re, pathlib; sys.path.insert(0, sys.argv[1]); import dbconf; print(dbconf._scan_for_jar(pathlib.Path(sys.argv[2]), [re.compile(r"DmJdbcDriver", re.I)]))', dir, jars], { cwd: h.root });
  H.ok('8.1.3.62、8.1.3.140、8.1.2.9 里挑 8.1.3.140', /8\.1\.3\.140\.jar\s*$/.test(r.out.trim()), r.out + r.err);
}

H.section('D4 redis 改值保留过期时间：一条 SET 带上 KEEPTTL；老版本 redis 不认就退回 PX；PTTL 为 0 也不能变成永久');
{
  const h = H.makeHome('tdg-d4', FROM);
  const client = path.join(h.cfg, 'skills', 'ttls-redis', 'scripts', 'redis.js');
  const script = path.join(h.root, 'redis-set.js');
  // 假 redis：PTTL 回测试给的值；mode=old 时 SET … KEEPTTL 回语法错误（Redis 6 以前的行为）；记下收到的每一条命令
  H.write(script, [
    "const net = require('net'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');",
    'const client = ' + JSON.stringify(client) + ';',
    'const { Parser } = require(client);',
    "const PTTL = Number(process.argv[2]); const OLD = process.argv[3] === 'old'; const sent = [];",
    'const server = net.createServer((s) => { const p = new Parser(); s.on("data", (b) => { p.push(b); for (const row of p.out.splice(0)) { const a = row.map((v) => (Buffer.isBuffer(v) ? v.toString() : String(v))); sent.push(a);',
    "  if (a[0] === 'PTTL') s.write(':' + PTTL + '\\r\\n'); else if (a[0] === 'SET' && OLD && a.includes('KEEPTTL')) s.write('-ERR syntax error\\r\\n'); else s.write('+OK\\r\\n'); } }); });",
    "server.listen(0, '127.0.0.1', () => { const port = server.address().port; const dir = path.join(__dirname, 'proj-' + PTTL + (OLD ? '-old' : ''));",
    "  fs.mkdirSync(path.join(dir, '.vibe'), { recursive: true }); fs.writeFileSync(path.join(dir, '.vibe', 'redis.json'), JSON.stringify({ connections: { dev: { host: '127.0.0.1', port, db: 0 } } }));",
    "  const p = spawn(process.execPath, [client, '--project', dir, 'set', 'vk-key', 'v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';",
    "  p.stdout.on('data', (c) => { out += c; }); p.on('exit', (code) => server.close(() => { const sets = sent.filter((a) => a[0] === 'SET'); let ok = false; try { ok = !!JSON.parse(out).ok; } catch (e) { ok = false; } console.log(JSON.stringify({ code, ok, sets })); })); });",
  ].join('\n') + '\n');
  const run = (pttl, mode) => json(H.node(h, script, [String(pttl), mode || ''], { cwd: h.root, timeout: 60000 }).out) || {};
  const a = run(0);
  const last = (o) => (o.sets || [])[(o.sets || []).length - 1] || [];
  H.ok('PTTL 为 0（马上过期）：SET 带 KEEPTTL，不变成永久', a.ok && last(a).includes('KEEPTTL'), a);
  const b = run(30000, 'old');
  H.ok('老版本 redis 不认 KEEPTTL：退回 SET … PX 剩下的毫秒数', b.ok && (b.sets || []).length === 2 && last(b).includes('PX') && last(b).includes('30000'), b);
  const c = run(0, 'old');
  H.ok('老版本、PTTL 为 0：PX 至少 1 毫秒，不变成永久', c.ok && last(c).includes('PX') && last(c).includes('1'), c);
  const d = run(-1);
  H.ok('原来就没有过期时间：照原样只 SET', d.ok && (d.sets || []).length === 1 && last(d).length === 3, d);
}

H.section('D3 驱动登记表：两个进程同时登记，后写的不盖掉先写的（Codex C10）');
{
  const h = H.makeHome('tdg-d3', FROM);
  // 一个最小的 MySQL 驱动 jar（只有驱动类和清单，不压缩）
  const jar = path.join(h.root, 'mysql-connector-j-8.0.33.jar');
  const entries = { 'com/mysql/cj/jdbc/Driver.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0]), 'META-INF/MANIFEST.MF': Buffer.from('Implementation-Version: 8.0.33\n') };
  const locals = []; const centrals = []; let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name); const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    locals.push(l, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42); centrals.push(c, n); off += l.length + n.length + data.length;
  }
  const central = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(off, 16);
  H.write(jar, Buffer.concat([...locals, central, end]));
  // 这个进程（像配置页）读了登记表、还没写回时，另一个进程（像后台探索）登记 MySQL 驱动；这个进程再把它改的写回去
  const script = path.join(h.root, 'd3.js');
  H.write(script, [
    "const fs = require('fs'), { spawn } = require('child_process');",
    'const D = require(' + JSON.stringify(path.join(h.kit, 'lib', 'drivers.js')) + ');',
    'const SS = require(' + JSON.stringify(path.join(h.kit, 'lib', 'state-store.js')) + ');',
    "const lock = SS.acquire(D.REGISTRY + '.lock', { waitMs: 2000 });",
    'const stale = D.readRegistry();',
    "const child = spawn(process.execPath, ['-e', 'require(' + JSON.stringify(" + JSON.stringify(path.join(h.kit, 'lib', 'drivers.js')) + ") + ').use(' + JSON.stringify(" + JSON.stringify(jar) + ") + \")\"], { windowsHide: true, stdio: 'ignore' });",
    'setTimeout(() => {',
    "  stale.dm = { jar: 'C:/x/DmJdbcDriver18.jar', from: 'manual', version: '8.1.3.140' };",
    "  fs.writeFileSync(D.REGISTRY, JSON.stringify({ version: 2, drivers: stale, removed: {} }));",
    '  if (lock) lock.release();',
    "  child.on('exit', () => console.log(JSON.stringify(Object.keys(D.readRegistry()).sort())));",
    '  if (child.exitCode !== null) console.log(JSON.stringify(Object.keys(D.readRegistry()).sort()));',
    '}, 2500);',
  ].join('\n') + '\n');
  const r = H.node(h, script, [], { cwd: h.root, timeout: 60000 });
  const keys = json(r.out) || [];
  H.ok('两边登记的都在（达梦、MySQL）', keys.includes('dm') && keys.includes('mysql'), r.out + r.err);
}

H.section('D7 改库的确认写明连接从哪来：没分环境的 application.yml 要说明（审核 P30）');
if (!RT.python) console.log('  （没找到 Python，跳过）');
else {
  const h = H.makeHome('tdg-d7', FROM);
  const dir = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts');
  const script = path.join(h.root, 'd7.py');
  H.write(script, [
    'import sys',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, sys.argv[1])',
    'import db',
    'class St: kind = "UPDATE"; table = "t_user"; raw = "update t_user set a = 1 where id = 1"',
    'class Rk: level = "低"; reasons = []',
    'base = {"name": "dev", "dialect": "mysql", "jdbc": "jdbc:mysql://10.0.0.5:3306/app", "user": "app"}',
    'for src in ["src/main/resources/application.yml:12", "src/main/resources/application-dev.yml:8", ""]:',
    '    c = dict(base); c["source"] = src; c["_config_path"] = "D:/p/.vibe/db-crud.ini"',
    '    db._show_plan(c, St, 1, Rk)',
    '    print("=====")',
  ].join('\n') + '\n');
  const r = H.run(h, RT.python, ['-B', script, dir], { cwd: h.root });
  const parts = r.out.split('=====');
  const line = (t) => (/来源\s+(.*)/.exec(t || '') || [])[1] || '';
  H.ok('来自没分环境的 application.yml：写明是公共配置、要核对地址', /application\.yml:12（没分环境的公共配置/.test(line(parts[0])), r.out + r.err);
  H.ok('来自 application-dev.yml：只写文件，不加提醒', /application-dev\.yml:8$/.test(line(parts[1]).trim()), parts[1]);
  H.ok('手工配的：写明配置文件', /手工配的（D:\/p\/\.vibe\/db-crud\.ini）/.test(line(parts[2])), parts[2]);
  H.ok('地址照旧在', /地址\s+.*10\.0\.0\.5/.test(parts[0] || ''), parts[0]);
}

H.section('D5 驱动连不上自己换：按登记的顺序换下一个，换成功的记进连接配置；口令不对、SQL 错、pom 写明版本的不换（问题表第 21 条）');
if (!RT.python || !RT.java || !RT.h2) console.log('  （没找到 Python、Java 或 H2 的驱动，跳过）');
else {
  const h = H.makeHome('tdg-d5', FROM);
  const scripts = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts');
  const DB = path.join(scripts, 'db.py');
  // 登记表：默认的是一个坏的（里面没有驱动，DriverManager 认不出这个地址），第二个版本是能用的（H2，拿它当库）
  const store = path.join(h.root, 'drivers');
  const bad = path.join(store, 'mysql-connector-j-9.9.9.jar');
  const bad2 = path.join(store, 'mysql-connector-j-9.9.8.jar');
  const good = path.join(store, 'mysql-connector-j-8.0.33.jar');
  const zip = (file) => { const data = Buffer.from('Manifest-Version: 1.0\n'); const n = Buffer.from('META-INF/MANIFEST.MF'); const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26); const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(46 + n.length, 12); e.writeUInt32LE(30 + n.length + data.length, 16); H.write(file, Buffer.concat([l, n, data, c, n, e])); };
  zip(bad); zip(bad2);
  fs.mkdirSync(store, { recursive: true }); fs.copyFileSync(RT.h2, good);
  const reg = (list) => H.write(path.join(h.kit, 'drivers.json'), JSON.stringify({ version: 2, drivers: { mysql: Object.assign({}, list[0], { versions: list }) }, removed: {} }));
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
  const ini = path.join(proj, '.vibe', 'db-crud.ini');
  const conf = ['; 测试用的库', '[main]', 'dialect = mysql', 'jdbc = jdbc:h2:mem:vk5;MODE=MySQL', 'user = sa', 'password =', '', '[other]', 'dialect = mysql', 'jdbc = jdbc:h2:mem:vk6', 'user = sa', 'password =', ''].join('\n');
  const db = (args) => H.run(h, RT.python, ['-B', DB].concat(args), { cwd: proj, env: { DBCRUD_JAVA: RT.java, DBCRUD_DAEMON: '0', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120000 });
  reg([{ jar: bad, version: '9.9.9' }, { jar: good, version: '8.0.33' }]);
  H.write(ini, conf);
  const r1 = db(['--conn', 'main', 'query', '--sql', 'SELECT 1 AS N']);
  H.ok('默认的驱动建不了连接：换成登记的下一个，查出来了', r1.code === 0 && /换成登记的 mysql-connector-j-8\.0\.33\.jar 后能建连接了/.test(r1.err), r1.out + r1.err);
  const after = H.read(ini) || '';
  const main = after.split('[other]')[0];
  H.ok('换成功的记进这条连接：driver_jar、driver_auto 和一行说明，原来的几行都在', /driver_jar = .*mysql-connector-j-8\.0\.33\.jar/.test(main) && /driver_auto = yes/.test(main) && /连不上时套件换过来的驱动/.test(main) && /password =/.test(main) && /; 测试用的库/.test(after), after);
  H.ok('别的连接不动', !/driver_jar/.test(after.split('[other]')[1] || ''), after);
  const r2 = db(['--conn', 'main', 'query', '--sql', 'SELECT 2 AS N']);
  H.ok('下次直接用记下的，不再换', r2.code === 0 && !/换成登记的/.test(r2.err), r2.out + r2.err);
  const r3 = db(['--conn', 'main', 'query', '--sql', 'SELECT * FROM NO_SUCH_TABLE']);
  H.ok('SQL 本身的错：不换驱动', r3.code !== 0 && !/换成登记的|都试过了/.test(r3.err), r3.err);
  // 登记的都不行：报错里列出试过哪几个
  reg([{ jar: bad, version: '9.9.9' }, { jar: bad2, version: '9.9.8' }]);
  H.write(ini, conf);
  const r4 = db(['--conn', 'main', 'query', '--sql', 'SELECT 1 AS N']);
  H.ok('登记的都建不了连接：报错，列出试过的', r4.code !== 0 && /登记的驱动都试过了.*mysql-connector-j-9\.9\.9\.jar.*mysql-connector-j-9\.9\.8\.jar/.test(r4.err) && !/driver_jar/.test(H.read(ini) || ''), r4.err);
  // pom 写明了驱动版本：只能用那个版本，不换
  reg([{ jar: bad, version: '9.9.9' }, { jar: good, version: '8.0.33' }]);
  H.write(path.join(proj, 'pom.xml'), '<project><dependencies><dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId><version>9.9.9</version></dependency></dependencies></project>\n');
  H.write(ini, conf);
  const r5 = db(['--conn', 'main', 'query', '--sql', 'SELECT 1 AS N']);
  H.ok('pom 写明了驱动版本：不拿别的版本代替', r5.code !== 0 && !/换成登记的/.test(r5.err) && !/driver_jar/.test(H.read(ini) || ''), r5.err);
  // 口令不对、网络不通不算驱动的问题
  const k = H.run(h, RT.python, ['-B', '-c', [
    'import sys, json; sys.path.insert(0, sys.argv[1]); import db',
    'cases = [{"code": "CONNECT_FAILED", "error": "Access denied for user", "sql_state": "28000"}, {"code": "CONNECT_FAILED", "error": "Connection refused: connect"},',
    ' {"code": "SQL_ERROR", "error": "Table not found"}, {"code": "DRIVER_FAILED", "error": "UnsupportedClassVersionError"}, {"code": "CONNECT_FAILED", "error": "ORA-28040: No matching authentication protocol"},',
    ' {"code": "CONNECT_FAILED", "error": "Communications link failure. The last packet sent successfully to the server was 0 milliseconds ago."},',
    ' {"code": "CONNECT_FAILED", "error": "The TCP/IP connection to the host db01, port 1433 has failed."}, {"code": "CONNECT_FAILED", "error": "IO Error: The Network Adapter could not establish the connection"},',
    ' {"code": "CONNECT_FAILED", "error": "网络通信异常"}, {"code": "CONNECT_FAILED", "error": "[KingbaseES] 用户 x 登录失败"}, {"code": "CONNECT_FAILED", "error": "某厂商没见过的说法 E1234"},',
    ' {"code": "CONNECT_FAILED", "error": "Unable to load authentication plugin \'caching_sha2_password\'."}, {"code": "CONNECT_FAILED", "error": "Communications link failure: javax.net.ssl.SSLHandshakeException: No appropriate protocol"}]',
    'print(json.dumps([db._driver_problem(c) for c in cases]))',
  ].join('\n'), scripts], { cwd: h.root });
  H.ok('口令不对、连不通、SQL 错不换；驱动加载不了、协议对不上的换', (json(k.out) || []).slice(0, 5).join() === 'false,false,false,true,true', k.out + k.err);
  H.ok('复审 D-R7：MySQL、SQL Server、Oracle、达梦连不上，金仓口令错，没见过的说法：都不换（以前认不出的一律当驱动问题）', (json(k.out) || []).slice(5, 11).join() === 'false,false,false,false,false,false', k.out + k.err);
  H.ok('复审 D-R7：认证插件不支持、SSL 握手协议对不上：换', (json(k.out) || []).slice(11).join() === 'true,true', k.out + k.err);
}

H.done('查库、redis 的保护（D 批）');
