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

H.done('查库、redis 的保护（D 批）');
