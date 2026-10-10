'use strict';
/*
 * ttls-db-crud：拿一个真的 JDBC 数据库（H2，MySQL 兼容模式）走完整的读写循环。
 *   建表 → 插入含中文、NULL、空串、引号的行 → 找表 → 看结构（大小写自己试、第二次走缓存）→ 按值找 → 几条查询一起跑
 *   → 两步确认的更新（行数变了不执行）→ 反向 SQL → 查询命令里塞写语句被拦
 *   → 全自动模式：留得下备份的直接做（改、删留快照和还原脚本，新增记下表和主键，建表加列记下 DROP），留不下的不做 → 驱动登记表 → 后台执行器
 * 这台电脑没有 Java、没有 Python 的话跑不了。运行环境装在各自的正式位置（见 dev/README.md），给 auto 就自己去找；
 * 也可以给一个放着便携版的目录（里面有 python/python.exe、jdk/bin/java.exe、h2.jar）。
 * 达梦、神通、Oracle、金仓、MySQL 的真库这里测不了。
 * 用法：node dev/test-dbcrud.js auto
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const RT = H.runtime(process.argv[2]);
const PY = RT.python;
const JAVA = RT.java;
const H2 = RT.h2;
if (!process.argv[2] || ![PY, JAVA, H2].every((f) => f && fs.existsSync(f))) {
  console.log('用法：node dev/test-dbcrud.js auto（到正式位置找 Python、JDK、H2），或者给一个目录（里面要有 python/python.exe、jdk/bin/java.exe、h2.jar）。现在找到的：' + JSON.stringify(RT));
  process.exit(2);
}

(async () => {
  const watch = await H.watchWindows('dbcrud-win');
  const h = H.makeHome('dbcrud');
  const DB = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts', 'db.py');
  const proj = H.makeRepo(path.join(h.work, 'shell', 'backend'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
  const data = H.tempDir('dbcrud-data');
  const url = 'jdbc:h2:file:' + data.replace(/\\/g, '/') + '/db;MODE=MySQL';
  const ini = (extra) => ['; 测试', '[main]', 'dialect = mysql', 'jdbc = ' + url, 'user = sa', 'password =', 'driver_class = org.h2.Driver'].concat(extra || []).join('\n') + '\n';
  const cfgFile = path.join(proj, '.vibe', 'db-crud.ini');
  H.write(cfgFile, ini(['driver_jar = ' + H2.replace(/\\/g, '/')]));
  const db = (args, opts) => H.run(h, PY, [DB].concat(args), Object.assign({ cwd: proj, env: Object.assign({ DBCRUD_JAVA: JAVA, DBCRUD_DAEMON: '0' }, (opts && opts.env) || {}) }, opts && opts.cwd ? { cwd: opts.cwd } : {}));
  const usage = () => (H.read(path.join(h.kit, 'state', 'tool-usage.jsonl')) || '').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const lastUse = () => usage().filter((u) => !u.incident).pop() || {};
  const ackOf = (r) => ((r.out.match(/--ack (\S+)/) || [])[1] || '');
  const sqlFile = (name, text) => { const f = path.join(proj, '.vibe', 'tmp', name); H.write(f, text); return f; };
  /** 写操作两步走完 */
  const execBoth = (sql) => { const f = sqlFile('w' + Date.now() + Math.random().toString(16).slice(2, 6) + '.sql', sql); const a = db(['exec', '--sql-file', f]); const b = db(['exec', '--sql-file', f, '--ack', ackOf(a)]); return { a, b }; };

  H.section('自检、连一下');
  const doc = db(['doctor']);
  H.ok('自检：都齐了', doc.code === 0 && /都齐了/.test(doc.out) && /✓ java/.test(doc.out) && /✓ 执行器/.test(doc.out) && /✓ vibe-kit/.test(doc.out) && /后台执行器　关着/.test(doc.out), doc.out + doc.err);
  H.ok('自检：.vibe 被 git 忽略了', /已被 git 忽略/.test(doc.out), doc.out);
  const ping = db(['conn', 'test']);
  H.ok('连上了，说了驱动是哪来的', ping.code === 0 && /连上了：main/.test(ping.out) && /驱动来自 配置里指定的/.test(ping.out), ping.out + ping.err);
  H.ok('技能目录里没有留下 __pycache__', !fs.existsSync(path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts', '__pycache__')));

  H.section('建表、插入（两步确认）');
  const c1 = execBoth('CREATE TABLE T_ORDER (ID INT PRIMARY KEY, CUSTOMER VARCHAR(50), STATUS VARCHAR(20), AMOUNT DECIMAL(10,2), CREATED TIMESTAMP, NOTE VARCHAR(200))');
  H.ok('第一步：什么都没改，给了确认串，退出码 4', c1.a.code === 4 && /--ack CREATE-T_ORDER-rows-unknown-[0-9a-f]{8}/.test(c1.a.out) && /风险    SAFE/.test(c1.a.out), c1.a.out + c1.a.err);
  H.ok('第二步：执行了', c1.b.code === 0 && /执行完成/.test(c1.b.out), c1.b.out + c1.b.err);
  H.ok('第二步只起了一次 java', lastUse().java === 1 && lastUse().cmd === 'exec', lastUse());
  execBoth("COMMENT ON COLUMN T_ORDER.STATUS IS '订单状态：待支付、已支付'");
  execBoth('CREATE TABLE TXORDER (ID INT, X VARCHAR(10))');
  const ins = execBoth("INSERT INTO T_ORDER VALUES (1, '张三', '待支付', 12.50, '2026-09-29 10:00:00', NULL), (2, '李四', '已支付', 99.00, '2026-09-29 11:00:00', ''), (3, 'O''Brien', '待支付', 5, '2026-09-28 09:30:00', '带''引号''')");
  H.ok('插入：确认串里写着 3 行', /--ack INSERT-T_ORDER-3rows-/.test(ins.a.out) && ins.b.code === 0 && /影响 3 行/.test(ins.b.out), ins.a.out + ins.b.out + ins.b.err);

  H.section('找表、看结构');
  const f1 = db(['find', '订单']);
  H.ok('按中文关键字找到了注释里带这个词的字段', f1.code === 0 && /T_ORDER\s+STATUS/.test(f1.out) && /订单状态/.test(f1.out) && /0 张表，1 个字段/.test(f1.out), f1.out + f1.err);
  const f2 = db(['find', 'order', '--tables-only']);
  H.ok('按英文关键字找到了两张表', f2.code === 0 && /2 张表/.test(f2.out) && /TXORDER/.test(f2.out), f2.out + f2.err);
  const col = db(['columns', '--table', 't_order,nothing']);
  H.ok('一次看两张表：小写的表名自己试出了大写', /库里这张表实际叫 T_ORDER/.test(col.out) && /CUSTOMER/.test(col.out) && /主键：ID/.test(col.out), col.out + col.err);
  H.ok('别的表的列没混进来（下划线是通配符）', !/\bX\b\s+CHARACTER/.test(col.out), col.out);
  H.ok('找不到的那张说清试过什么，退出码 2', col.code === 2 && /找不到表 nothing。试过的写法：\S*nothing、\S*NOTHING/.test(col.out), col.out);
  H.ok('只起了一次 java', lastUse().java === 1, lastUse());
  H.ok('大小写这个坑记进了配置', /notes =\n\s+\d{4}-\d\d-\d\d 标识符要用大写：表名按 T_ORDER 这样写/.test(H.read(cfgFile) || ''), H.read(cfgFile));
  const col2 = db(['columns', '--table', 'T_ORDER']);
  H.ok('再看一次：走本地缓存，没起 java，输出里说了', col2.code === 0 && /来自本地缓存/.test(col2.out) && /主键：ID/.test(col2.out) && lastUse().java === 0 && lastUse().cached === 1, [col2.out, lastUse()]);
  H.ok('用到这个连接时先把记过的坑摆出来', /这个连接记过的坑：/.test(col2.out), col2.out);
  const col3 = db(['columns', '--table', 'T_ORDER', '--fresh']);
  H.ok('--fresh：重新到库里查', col3.code === 0 && !/来自本地缓存/.test(col3.out) && lastUse().java === 1, [col3.out, lastUse()]);

  H.section('不写 SQL 看数据');
  const p1 = db(['peek', '--table', 't_order', '--eq', 'status=待支付', '--order', 'id desc', '--limit', '5']);
  H.ok('按中文的值找：参数绑定，值没加引号；表名、列名用的是库里的真名、加着引号', p1.code === 0 && /FROM "PUBLIC"\."T_ORDER" WHERE "STATUS" = \? ORDER BY "ID" DESC/.test(p1.out) && /O'Brien/.test(p1.out) && /张三/.test(p1.out) && !/李四/.test(p1.out) && /2 行/.test(p1.out), p1.out + p1.err);
  const p2 = db(['peek', '--table', 'T_ORDER', '--eq', 'id=3', '--cols', 'id,note']);
  H.ok('数字列按数字绑；只看两列；值里的引号原样', p2.code === 0 && /SELECT "ID", "NOTE" FROM "PUBLIC"\."T_ORDER"/.test(p2.out) && /带'引号'/.test(p2.out), p2.out + p2.err);
  const p3 = db(['peek', '--table', 'T_ORDER', '--eq', 'status=待支付', '--count']);
  H.ok('只数行数', p3.code === 0 && /COUNT\(\*\)/.test(p3.out) && /^2\s*$/m.test(p3.out), p3.out + p3.err);
  const p4 = db(['peek', '--table', 'T_ORDER', '--eq', 'nope=1']);
  H.ok('没有这一列：说清有哪些列', p4.code === 2 && /没有 nope 这一列/.test(p4.err) && /CUSTOMER/.test(p4.err), p4.out + p4.err);
  const p5 = db(['peek', '--table', 'T_ORDER', '--eq', 'note=']);
  H.ok('空串和 NULL 分得清', p5.code === 0 && /李四/.test(p5.out) && !/张三/.test(p5.out), p5.out + p5.err);

  H.section('查询');
  const q1 = db(['query', '--sql', 'SELECT COUNT(*) AS N FROM T_ORDER', '--sql', 'SELECT * FROM NO_SUCH', '--sql', 'SELECT STATUS, COUNT(*) AS C FROM T_ORDER GROUP BY STATUS ORDER BY 1']);
  H.ok('三条一起跑：错的那条只影响它自己', q1.code === 2 && /── 第 1 条/.test(q1.out) && /── 第 2 条[\s\S]*失败（SQL_ERROR）/.test(q1.out) && /── 第 3 条[\s\S]*已支付\s+1/.test(q1.out) && lastUse().java === 1, [q1.out + q1.err, lastUse()]);
  H.ok('出错的类别记进了用量（不带原话）', (lastUse().errors || []).some((e) => /^SQL_ERROR:42S02/.test(e)), lastUse());
  const qf = db(['query', '--sql-file', sqlFile('q.sql', "SELECT CUSTOMER FROM T_ORDER WHERE STATUS = '已支付';\nWITH t AS (SELECT ID FROM T_ORDER) SELECT COUNT(*) FROM t;")]);
  H.ok('文件里两条（含 WITH 开头的）', qf.code === 0 && /李四/.test(qf.out) && /── 第 2 条/.test(qf.out), qf.out + qf.err);
  for (const [name, sql] of [['删除', 'DELETE FROM T_ORDER WHERE ID = 2'], ['改结构', 'DROP TABLE TXORDER'], ['SELECT INTO', 'SELECT * INTO T2 FROM T_ORDER'], ['WITH 里藏着删除', 'WITH t AS (SELECT 1) DELETE FROM T_ORDER'], ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE DELETE FROM T_ORDER'], ['两条里有一条是写', 'SELECT 1; UPDATE T_ORDER SET NOTE = NULL']]) {
    const r = db(['query', '--sql', sql]);
    H.ok('查询命令里塞' + name + '：拦下，退出码 3，没起 java', r.code === 3 && /query 只跑查询/.test(r.err) && lastUse().java === 0, [r.out + r.err, lastUse()]);
  }
  const still = db(['peek', '--table', 'T_ORDER', '--count']);
  H.ok('数据一行没少', /^3\s*$/m.test(still.out), still.out);

  H.section('更新：两步确认，行数在事务里核对');
  const uf = sqlFile('u.sql', "UPDATE T_ORDER SET STATUS = '已取消' WHERE STATUS = '待支付'");
  const u1 = db(['exec', '--sql-file', uf]);
  H.ok('第一步：影响 2 行，带 WHERE 的更新是 WARN', u1.code === 4 && /影响面  2 行/.test(u1.out) && /风险    WARN/.test(u1.out) && /--ack UPDATE-T_ORDER-2rows-/.test(u1.out), u1.out + u1.err);
  const dry = db(['exec', '--sql-file', uf, '--dry-run']);
  H.ok('--dry-run：不给确认串', dry.code === 0 && !/--ack/.test(dry.out) && /什么都没改/.test(dry.out), dry.out);
  // 确认之后、执行之前，别人又插了一行待支付的
  execBoth("INSERT INTO T_ORDER VALUES (4, '王五', '待支付', 1, '2026-09-29 12:00:00', NULL)");
  const u2 = db(['exec', '--sql-file', uf, '--ack', ackOf(u1)]);
  H.ok('行数变了：不执行，把现在的影响面和新的确认串打出来', u2.code === 4 && /没有执行：确认的时候影响 2 行，现在是 3 行/.test(u2.out) && /--ack UPDATE-T_ORDER-3rows-/.test(u2.out) && lastUse().java === 1, [u2.out + u2.err, lastUse()]);
  H.ok('数据没动', /^3\s*$/m.test(db(['peek', '--table', 'T_ORDER', '--eq', 'status=待支付', '--count']).out));
  const bad = db(['exec', '--sql-file', uf, '--ack', 'UPDATE-T_ORDER-3行-00000000']);
  H.ok('确认串是编的：对不上，不执行', bad.code === 4 && /确认串对不上/.test(bad.err), bad.out + bad.err);
  const u3 = db(['exec', '--sql-file', uf, '--ack', ackOf(u2)]);
  H.ok('用新的确认串：执行了，影响 3 行，只起了一次 java', u3.code === 0 && /影响 3 行，已提交/.test(u3.out) && /改前快照 3 行/.test(u3.out) && lastUse().java === 1, [u3.out + u3.err, lastUse()]);
  const jdir = path.join(h.home, '.db-crud', 'journal', 'main');
  const entry = fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((n) => /-update$/.test(n)).sort().pop() : '';
  const undo = entry ? H.read(path.join(jdir, entry, 'undo.sql')) || '' : '';
  H.ok('留痕在假用户目录的 ~/.db-crud 里；反向 SQL 按主键定位、中文和引号都对', /UPDATE T_ORDER SET CUSTOMER = '张三', STATUS = '待支付'[^\n]*NOTE = NULL WHERE ID = 1;/.test(undo) && /CUSTOMER = 'O''Brien'/.test(undo) && /NOTE = '带''引号'''/.test(undo) && /WHERE ID = 4;/.test(undo), undo);
  const snap = entry ? JSON.parse(H.read(path.join(jdir, entry, 'before.json')) || '{}') : {};
  H.ok('快照取全了，记在快照文件里', snap.snapshot_complete === true && snap.row_count === 3, snap);
  const multi = db(['exec', '--sql', 'UPDATE T_ORDER SET NOTE = NULL; DELETE FROM T_ORDER']);
  H.ok('一次两条：不收', multi.code === 1 && /一次只执行一条语句/.test(multi.err), multi.out + multi.err);
  const dz = db(['exec', '--sql', 'DROP SCHEMA PUBLIC']);
  H.ok('删 schema：脚本直接拒绝，退出码 3', dz.code === 3 && /不允许执行/.test(dz.err), dz.out + dz.err);
  const alt = execBoth('ALTER TABLE T_ORDER ADD COLUMN REMARK2 VARCHAR(10)');
  const col4 = db(['columns', '--table', 'T_ORDER']);
  H.ok('通过工具改了结构：本地存的表结构作废，重新查到了新列', alt.b.code === 0 && col4.code === 0 && /REMARK2/.test(col4.out) && !/来自本地缓存/.test(col4.out), alt.b.out + alt.b.err + col4.out);

  H.section('全自动模式（用户不在）：留得下备份的直接做，留不下的留给用户');
  const lastEntry = (kind) => { const names = fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((n) => n.endsWith('-' + kind)).sort() : []; return names.length ? path.join(jdir, names.pop()) : ''; };
  const opOf = (kind) => { try { return JSON.parse(H.read(path.join(lastEntry(kind), 'op.json')) || '{}'); } catch (e) { return {}; } };
  const undoOf = (kind) => H.read(path.join(lastEntry(kind), 'undo.sql')) || '';
  const countOf = (table) => ((db(['peek', '--table', table, '--count']).out.match(/^(\d+)\s*$/m) || [])[1] || '');
  /** 全自动模式下一条写操作：第一步被拒就到此为止 */
  const autoExec = (sql, more) => { const f = sqlFile('a' + Date.now() + Math.random().toString(16).slice(2, 6) + '.sql', sql); const a = db(['exec', '--sql-file', f].concat(more || [])); const b = a.code === 4 ? db(['exec', '--sql-file', f, '--ack', ackOf(a)].concat(more || [])) : null; return { a, b }; };
  {
  H.setConfig(h, { autoMode: true });
  // 建表：记下来，还原脚本是 DROP
  const ac = autoExec('CREATE TABLE T_AUTO (ID INT PRIMARY KEY, NAME VARCHAR(20))');
  H.ok('建表：第一步说了不用等人确认', ac.a.code === 4 && /全自动模式：这条留得下备份，不用等人确认/.test(ac.a.out) && !/给人看过之后/.test(ac.a.out), ac.a.out + ac.a.err);
  H.ok('建表：执行了，还原脚本是 DROP，留痕里记着是全自动做的、在哪个项目里', ac.b && ac.b.code === 0 && /建了     TABLE T_AUTO/.test(ac.b.out) && /^DROP TABLE T_AUTO;$/m.test(undoOf('create')) && opOf('create').auto === true && path.resolve(opOf('create').project || '').toLowerCase() === path.resolve(proj).toLowerCase() && opOf('create').created.kind === 'TABLE', [ac.b && ac.b.out + ac.b.err, undoOf('create'), opOf('create')]);
  // 新增：主键写在语句里的直接记
  const ai = autoExec("INSERT INTO T_AUTO (ID, NAME) VALUES (1, '甲'), (2, '乙')");
  H.ok('新增：执行了，表和主键记下来了', ai.b && ai.b.code === 0 && /影响 2 行，已提交/.test(ai.b.out) && /新增的行  表 T_AUTO，主键 ID：1、2（语句里写明的）/.test(ai.b.out), ai.a.out + (ai.b ? ai.b.out + ai.b.err : ''));
  const insOp = opOf('insert');
  H.ok('留痕里：表、主键列、每一行的主键值；还原脚本是按主键删', insOp.inserted && insOp.inserted.table === 'T_AUTO' && insOp.inserted.pk.join() === 'ID' && JSON.stringify(insOp.inserted.ids) === '[["1"],["2"]]' && /^DELETE FROM T_AUTO WHERE ID = 1;$/m.test(undoOf('insert')) && /^DELETE FROM T_AUTO WHERE ID = 2;$/m.test(undoOf('insert')), [insOp.inserted, undoOf('insert')]);
  const insEntry = lastEntry('insert');
  const ai2 = autoExec("INSERT INTO T_AUTO VALUES (3, '丙''')");
  H.ok('新增没写列名单：按表里列的顺序认出主键', ai2.b && ai2.b.code === 0 && JSON.stringify(opOf('insert').inserted.ids) === '[["3"]]', [ai2.b && ai2.b.out + ai2.b.err, opOf('insert').inserted]);
  // 新增：主键是自增的，让驱动带回来
  autoExec('CREATE TABLE T_SEQ (ID INT AUTO_INCREMENT PRIMARY KEY, NAME VARCHAR(20))');
  const as = autoExec("INSERT INTO T_SEQ (NAME) VALUES ('x'), ('y')");
  H.ok('新增、主键是自增的：驱动把主键带回来了，照样记下', as.b && as.b.code === 0 && /主键 ID：1、2（驱动带回来的）/.test(as.b.out) && JSON.stringify(opOf('insert').inserted.ids) === '[["1"],["2"]]' && /^DELETE FROM T_SEQ WHERE ID = 2;$/m.test(undoOf('insert')), [as.a.out, as.b && as.b.out + as.b.err, opOf('insert').inserted]);
  const sel = autoExec('INSERT INTO T_AUTO (ID, NAME) SELECT ID + 10, NAME FROM T_AUTO');
  H.ok('INSERT … SELECT：主键记不下来，不给确认串，留给用户', sel.a.code === 3 && !/--ack/.test(sel.a.out) && /主键记不下来/.test(sel.a.err) && /留给用户：要改库/.test(sel.a.err) && countOf('T_AUTO') === '3', sel.a.out + sel.a.err);
  // 改、删：改前快照取得全、有主键 → 直接做
  const au = autoExec("UPDATE T_AUTO SET NAME = '改过' WHERE ID = 1");
  H.ok('改：执行了，留了改前快照，还原脚本按主键改回去', au.b && au.b.code === 0 && /影响 1 行，已提交/.test(au.b.out) && /改前快照 1 行/.test(au.b.out) && /UPDATE T_AUTO SET NAME = '甲' WHERE ID = 1;/.test(undoOf('update')) && opOf('update').auto === true, [au.b && au.b.out + au.b.err, undoOf('update')]);
  const ad = autoExec('DELETE FROM T_AUTO WHERE ID = 2');
  H.ok('删：执行了，还原脚本把删掉的行插回去', ad.b && ad.b.code === 0 && /INSERT INTO T_AUTO \(ID, NAME\) VALUES \(2, '乙'\);/.test(undoOf('delete')) && countOf('T_AUTO') === '2', [ad.b && ad.b.out + ad.b.err, undoOf('delete')]);
  const nw = autoExec('DELETE FROM T_AUTO');
  H.ok('没有 WHERE 的删除：不做，说了原因', nw.a.code === 3 && /没有 WHERE/.test(nw.a.err) && countOf('T_AUTO') === '2', nw.a.out + nw.a.err);
  const big2 = autoExec("UPDATE T_AUTO SET NAME = 'z' WHERE ID > 0", ['--snapshot-max-rows', '1']);
  H.ok('动的行数超过改前快照的上限：备份不全，不做', big2.a.code === 3 && /超过改前快照的上限 1 行/.test(big2.a.err), big2.a.out + big2.a.err);
  // 没有主键的表
  const np = autoExec('CREATE TABLE T_NOPK (ID INT, X VARCHAR(10))');
  const npi = autoExec("INSERT INTO T_NOPK VALUES (1, 'a')");
  H.ok('没有主键的表：新增不做（以后定位不到）', np.b && np.b.code === 0 && npi.a.code === 3 && /没有主键/.test(npi.a.err) && countOf('T_NOPK') === '0', npi.a.out + npi.a.err);
  // 有二进制列的表
  autoExec('CREATE TABLE T_BIN (ID INT PRIMARY KEY, DATA BLOB)');
  const bi = autoExec('INSERT INTO T_BIN (ID) VALUES (1)');
  const bu = autoExec('UPDATE T_BIN SET ID = 2 WHERE ID = 1');
  H.ok('有二进制列的表：新增照做，改不做（值写不进还原脚本）', bi.b && bi.b.code === 0 && bu.a.code === 3 && /有二进制列（DATA）/.test(bu.a.err), [bi.b && bi.b.out + bi.b.err, bu.a.out + bu.a.err]);
  // 改结构
  const aa = autoExec('ALTER TABLE T_AUTO ADD COLUMN AGE INT');
  H.ok('加列：执行了，还原脚本是删这一列', aa.b && aa.b.code === 0 && /建了     COLUMN AGE（表 T_AUTO）/.test(aa.b.out) && /^ALTER TABLE T_AUTO DROP COLUMN AGE;$/m.test(undoOf('alter_table')), [aa.b && aa.b.out + aa.b.err, undoOf('alter_table')]);
  for (const [name, sql, why] of [['删列', 'ALTER TABLE T_AUTO DROP COLUMN AGE', /只有加列、加约束留得下还原脚本/], ['删表', 'DROP TABLE T_NOPK', /结构或权限变更/], ['清空', 'TRUNCATE TABLE T_AUTO', /结构或权限变更/], ['建了就盖掉原来的', 'CREATE OR REPLACE VIEW V_AUTO AS SELECT * FROM T_AUTO', /会盖掉已有的对象/]]) {
    const r = autoExec(sql);
    H.ok(name + '：不做，留给用户', r.a.code === 3 && why.test(r.a.err) && !/--ack/.test(r.a.out), r.a.out + r.a.err);
  }
  H.ok('被拒的这些都没动库', countOf('T_AUTO') === '2' && db(['columns', '--table', 'T_AUTO', '--fresh']).out.includes('AGE') && countOf('T_NOPK') === '0', db(['columns', '--table', 'T_AUTO', '--fresh']).out);
  H.ok('查询不受影响', db(['peek', '--table', 'T_ORDER', '--count']).code === 0);
  H.ok('被拒的记进了用量（类别 BLOCKED）', usage().some((u) => (u.errors || []).includes('BLOCKED')), usage().slice(-3));
  // 全自动模式只在走 OpenSpec 流程的会话里算数：钩子留了条子说这个会话不在流程里（用户在），就照有人在的样子来
  const ticket = (auto, ageMs) => H.write(path.join(h.kit, 'state', 'tool-flow.json'), JSON.stringify({ byCwd: { [path.resolve(proj).split(path.sep).join('/').toLowerCase()]: { auto, at: Date.now() - (ageMs || 0), sid: 'test' } } }));
  ticket(false);
  const t1 = db(['exec', '--sql', 'DELETE FROM T_NOPK']);
  H.ok('条子说用户在：照有人在的样子来（给确认串，让它给人看）', t1.code === 4 && /把上面的内容给人看过之后/.test(t1.out) && !/全自动模式/.test(t1.out + t1.err), t1.out + t1.err);
  ticket(false, 5 * 60000);
  const t2 = db(['exec', '--sql', 'DELETE FROM T_NOPK']);
  H.ok('条子是五分钟前的：不认，按用户不在算', t2.code === 3 && /全自动模式（用户不在）/.test(t2.err), t2.out + t2.err);
  ticket(true);
  const t3 = db(['exec', '--sql', 'DELETE FROM T_NOPK']);
  H.ok('条子说在流程里：按用户不在算', t3.code === 3 && /全自动模式（用户不在）/.test(t3.err), t3.out + t3.err);
  fs.unlinkSync(path.join(h.kit, 'state', 'tool-flow.json'));
  H.setConfig(h, { autoMode: false });
  // 人回来了：全自动模式下新增的那两行，照还原脚本删掉
  const ui1 = db(['exec', '--undo', insEntry]);
  const ui2 = db(['exec', '--undo', insEntry, '--ack', ackOf(ui1)]);
  H.ok('新增的还原：按主键一行一行删，有一行已经没了就全部回滚', ui1.code === 4 && /语句    2 条 DELETE/.test(ui1.out) && ui2.code === 2 && /应该正好 1 行/.test(ui2.err) && countOf('T_AUTO') === '2', ui1.out + ui2.out + ui2.err);
  execBoth("INSERT INTO T_AUTO (ID, NAME) VALUES (2, '乙')");
  H.ok('有人在的时候新增：主键写在语句里的也记下来（不算全自动做的）', JSON.stringify((opOf('insert').inserted || {}).ids) === '[["2"]]' && opOf('insert').auto === false && /^DELETE FROM T_AUTO WHERE ID = 2;$/m.test(undoOf('insert')), [opOf('insert'), undoOf('insert')]);
  const ui3 = db(['exec', '--undo', insEntry]);
  const ui4 = db(['exec', '--undo', insEntry, '--ack', ackOf(ui3)]);
  H.ok('两行都在的时候再还原：删掉了', ui4.code === 0 && /还原完成：2 条语句，影响 2 行/.test(ui4.out) && countOf('T_AUTO') === '1', ui3.out + ui4.out + ui4.err);
  const ud0 = db(['exec', '--undo', lastEntry('create')]);
  H.ok('建表的还原不代做：说清要人来删', ud0.code === 1 && /还原就是把建的东西删掉/.test(ud0.err) && /DROP TABLE/.test(ud0.err), ud0.out + ud0.err);
  }
  // 手改 config.json 打开的不算（封条里没有）
  fs.writeFileSync(path.join(h.kit, 'config.json'), JSON.stringify(Object.assign(JSON.parse(H.read(path.join(h.kit, 'config.json'))), { autoMode: true })));
  const a3 = db(['exec', '--sql-file', sqlFile('n.sql', "UPDATE T_ORDER SET NOTE = 'x' WHERE ID = 1")]);
  const a4 = db(['exec', '--sql-file', path.join(proj, '.vibe', 'tmp', 'n.sql'), '--ack', ackOf(a3)]);
  H.ok('手改配置文件打开的全自动不算数：照常执行', a4.code === 0 && /已提交/.test(a4.out), a4.out + a4.err);
  H.setConfig(h, { autoMode: false });

  H.section('确认的是哪台库、执行的是哪一条、确认串只能用一次');
  const valueOf = (id, colName, opts) => { const r = db(['query', '--sql', 'SELECT ' + colName + ' AS V FROM T_ORDER WHERE ID = ' + id, '--width', '0'], opts); return ((r.out.split(/\r?\n/).find((l, i, a) => i > 1 && /^-+\s*$/.test(a[i - 1])) || '').trim()); };
  const sf = sqlFile('semi.sql', "-- 改一下备注\nUPDATE T_ORDER SET NOTE = 'semi' WHERE ID = 3; -- 结尾有分号、有注释\n");
  const s1 = db(['exec', '--sql-file', sf]);
  H.ok('影响面里写着地址和账号（光看连接名分不清是哪台库）', s1.code === 4 && /地址    jdbc:h2:file:[^\n]*用户 sa/.test(s1.out), s1.out + s1.err);
  H.ok('给人看的是分析过的那一条：没有注释、没有结尾的分号', /SQL：\r?\n\s+UPDATE T_ORDER SET NOTE = 'semi' WHERE ID = 3\r?\n/.test(s1.out) && !/结尾有分号/.test(s1.out), s1.out);
  const s2 = db(['exec', '--sql-file', sf, '--ack', ackOf(s1)]);
  H.ok('执行的也是那一条', s2.code === 0 && /影响 1 行，已提交/.test(s2.out) && valueOf(3, 'NOTE') === 'semi', [s2.out + s2.err, valueOf(3, 'NOTE')]);
  const opSemi = JSON.parse(H.read(path.join(lastEntry('update'), 'op.json')) || '{}');
  H.ok('留痕里记的是执行的那一条', opSemi.sql === "UPDATE T_ORDER SET NOTE = 'semi' WHERE ID = 3", opSemi.sql);
  const inc = sqlFile('inc.sql', 'UPDATE T_ORDER SET AMOUNT = AMOUNT + 10 WHERE ID = 3');
  const i1 = db(['exec', '--sql-file', inc]);
  const i2 = db(['exec', '--sql-file', inc, '--ack', ackOf(i1)]);
  const amount = valueOf(3, 'AMOUNT');
  const i3 = db(['exec', '--sql-file', inc, '--ack', ackOf(i1)]);
  H.ok('同一个确认串再用一次：不执行，说清这个串用过了，给一个新的', i2.code === 0 && i3.code === 4 && /确认串对不上/.test(i3.err) && /已经用过了/.test(i3.err) && /--ack UPDATE-T_ORDER-1rows-/.test(i3.out) && ackOf(i3) !== ackOf(i1), i3.out + i3.err);
  H.ok('数据只加了一次', Number(amount) === 15 && Number(valueOf(3, 'AMOUNT')) === 15, [amount, valueOf(3, 'AMOUNT')]);
  const i4 = db(['exec', '--sql-file', inc]);
  H.ok('同一条语句每次第一步给的确认串都不一样', i4.code === 4 && ackOf(i4) && ackOf(i4) !== ackOf(i1) && ackOf(i4) !== ackOf(i3), [ackOf(i1), ackOf(i3), ackOf(i4)]);
  const other = sqlFile('inc2.sql', 'UPDATE T_ORDER SET AMOUNT = AMOUNT + 10 WHERE ID = 2');
  const i5 = db(['exec', '--sql-file', other, '--ack', ackOf(i4)]);
  H.ok('拿这条语句的确认串去执行另一条：不执行', i5.code === 4 && /和确认的时候不一样了/.test(i5.err) && Number(valueOf(2, 'AMOUNT')) === 99, [i5.out + i5.err, valueOf(2, 'AMOUNT')]);
  const al = execBoth("UPDATE T_ORDER t SET t.NOTE = 'alias' WHERE t.ID = 3");
  H.ok('带别名的更新：数得出行数，能执行', al.a.code === 4 && /影响面  1 行/.test(al.a.out) && al.b.code === 0 && valueOf(3, 'NOTE') === 'alias', al.a.out + al.a.err + al.b.out + al.b.err);

  H.section('还原：照留下的反向 SQL，一样两步确认');
  const aliasEntry = lastEntry('update');
  H.ok('执行完说了怎么还原', /exec --undo/.test(al.b.out), al.b.out);
  const un1 = db(['exec', '--undo', aliasEntry]);
  H.ok('第一步：说清还原的是哪一次、几条语句，给了确认串，什么都没改', un1.code === 4 && /还原    [^\n]*那一次 UPDATE/.test(un1.out) && /语句    1 条 UPDATE/.test(un1.out) && /--ack UNDO-T_ORDER-1rows-/.test(un1.out) && valueOf(3, 'NOTE') === 'alias', un1.out + un1.err);
  const un2 = db(['exec', '--undo', aliasEntry, '--ack', ackOf(un1)]);
  H.ok('第二步：还原了', un2.code === 0 && /还原完成：1 条语句，影响 1 行/.test(un2.out) && valueOf(3, 'NOTE') === 'semi', [un2.out + un2.err, valueOf(3, 'NOTE')]);
  const un3 = db(['exec', '--undo', aliasEntry]);
  H.ok('同一次不能还原两遍', un3.code === 3 && /已经还原过了/.test(un3.err), un3.out + un3.err);
  const del = execBoth('DELETE FROM T_ORDER WHERE ID IN (1, 4)');
  H.ok('删了两行', del.b.code === 0 && /影响 2 行/.test(del.b.out) && /^2\s*$/m.test(db(['peek', '--table', 'T_ORDER', '--count']).out), del.b.out + del.b.err);
  const delEntry = lastEntry('delete');
  // 删掉的行里有一行后来又被人插回去了：还原的时候第二条插不进去（主键重复），要全部回滚
  execBoth("INSERT INTO T_ORDER (ID, CUSTOMER) VALUES (4, '别人插的')");
  const ud1 = db(['exec', '--undo', delEntry]);
  const ud2 = db(['exec', '--undo', delEntry, '--ack', ackOf(ud1)]);
  H.ok('还原到一半出错：全部回滚，第一条也没留下', ud1.code === 4 && /语句    2 条 INSERT/.test(ud1.out) && ud2.code === 2 && /已经回滚/.test(ud2.err) && /^3\s*$/m.test(db(['peek', '--table', 'T_ORDER', '--count']).out) && /^0\s*$/m.test(db(['peek', '--table', 'T_ORDER', '--eq', 'id=1', '--count']).out), ud1.out + ud2.out + ud2.err);
  execBoth('DELETE FROM T_ORDER WHERE ID = 4');
  const ud3 = db(['exec', '--undo', delEntry]);
  const ud4 = db(['exec', '--undo', delEntry, '--ack', ackOf(ud3)]);
  H.ok('挡路的那一行去掉之后再还原：两行都回来了，中文、NULL 都对', ud4.code === 0 && /影响 2 行/.test(ud4.out) && /^4\s*$/m.test(db(['peek', '--table', 'T_ORDER', '--count']).out) && valueOf(1, 'CUSTOMER') === '张三' && valueOf(4, 'NOTE') === 'NULL', [ud4.out + ud4.err, valueOf(1, 'CUSTOMER'), valueOf(4, 'NOTE')]);
  const outside = db(['exec', '--undo', path.join(proj, '.vibe')]);
  H.ok('不是留痕目录的不收', outside.code === 1 && /不是留痕目录/.test(outside.err), outside.out + outside.err);
  execBoth("UPDATE T_ORDER SET NOTE = 'auto' WHERE ID = 3");
  const autoEntry = lastEntry('update');
  H.setConfig(h, { autoMode: true });
  const una1 = db(['exec', '--undo', autoEntry]);
  const una = db(['exec', '--undo', autoEntry, '--ack', ackOf(una1)]);
  H.ok('全自动模式下还原不做（它自己不留快照，做了回不去）', una1.code === 4 && una.code === 3 && /全自动模式（用户不在）/.test(una.err) && /还原不是全自动模式下做的事/.test(una.err) && valueOf(3, 'NOTE') === 'auto', una.out + una.err);
  H.setConfig(h, { autoMode: false });
  const una2 = db(['exec', '--undo', autoEntry, '--ack', ackOf(db(['exec', '--undo', autoEntry]))]);
  H.ok('人回来之后照常还原', una2.code === 0 && valueOf(3, 'NOTE') === 'semi', una2.out + una2.err);

  H.section('禁止名单和上限写在连接配置里，命令行上只能收紧');
  H.write(cfgFile, ini(['driver_jar = ' + H2.replace(/\\/g, '/'), 'forbid = TX*, T_AUDIT', 'hard_limit = 3']));
  const fb = db(['exec', '--sql', 'DELETE FROM TXORDER WHERE ID = 1']);
  H.ok('碰到配置里禁止的表：不带参数也拦，退出码 3', fb.code === 3 && /禁止名单/.test(fb.err) && /TX\*/.test(fb.err), fb.out + fb.err);
  const hl = db(['exec', '--sql', 'UPDATE T_ORDER SET REMARK2 = NULL WHERE ID > 0', '--hard-limit', '100000']);
  H.ok('命令行上把上限放宽：不作数，照配置里的拦', hl.code === 3 && /不作数/.test(hl.err) && /超过硬上限 3/.test(hl.err), hl.out + hl.err);
  const hl2 = db(['exec', '--sql', 'UPDATE T_ORDER SET REMARK2 = NULL WHERE ID > 2', '--hard-limit', '2']);
  H.ok('命令行上收紧：作数', hl2.code === 3 && /超过硬上限 2/.test(hl2.err), hl2.out + hl2.err);
  const cl = db(['conn', 'list']);
  H.ok('列连接的时候说了不许碰什么', /不许碰 TX\*、T_AUDIT/.test(cl.out), cl.out);
  H.write(cfgFile, ini(['driver_jar = ' + H2.replace(/\\/g, '/')]));
  const big = db(['exec', '--sql', 'UPDATE T_ORDER SET REMARK2 = NULL WHERE ID > 0', '--hard-limit', '999999999']);
  H.ok('配置里没写上限：命令行上也不能放得比默认的宽', big.code === 4 && /不作数/.test(big.err), big.out + big.err);

  H.section('查出来的值看得全');
  const long = 'L' + 'abcdefghij'.repeat(12) + '尾';
  execBoth("UPDATE T_ORDER SET NOTE = '" + long + "' WHERE ID = 3");
  const w1r = db(['peek', '--table', 'T_ORDER', '--eq', 'id=3']);
  H.ok('结果只有一行、有长的值：竖着排，不截', w1r.code === 0 && /── 第 1 行/.test(w1r.out) && w1r.out.includes(long) && /^NOTE\s+L/m.test(w1r.out), w1r.out + w1r.err);
  const w2r = db(['query', '--sql', 'SELECT ID, NOTE FROM T_ORDER ORDER BY ID']);
  H.ok('行多的时候按列截，说了怎么看全', w2r.code === 0 && !w2r.out.includes(long) && /★ 有内容太长被截断了[^\n]*--width 0/.test(w2r.out), w2r.out + w2r.err);
  const w3r = db(['query', '--sql', 'SELECT ID, NOTE FROM T_ORDER ORDER BY ID', '--width', '0']);
  H.ok('--width 0：不截', w3r.code === 0 && w3r.out.includes(long) && !/被截断/.test(w3r.out), w3r.out + w3r.err);
  const w4r = db(['peek', '--table', 'T_ORDER', '--width', '200']);
  H.ok('--width 200：放宽', w4r.code === 0 && w4r.out.includes(long), w4r.out + w4r.err);

  H.section('1007 反馈：命令行丢中文、JSON 输出、文件确认');
  const nonAscii = db(['query', '--sql', "SELECT * FROM T_ORDER WHERE CUSTOMER LIKE '%张%'", '--json']);
  H.ok('非 ASCII 的 --sql 在连库前拒绝，提示原 SQL 走文件', nonAscii.code === 1 && /--sql-file/.test(nonAscii.err) && lastUse().java === 0, nonAscii.out + nonAscii.err);
  const findFile = db(['find', '--keyword-file', sqlFile('keyword.txt', '\ufeff订单\n')]);
  H.ok('中文查表关键字可走 UTF-8 文件，命令行不带中文', findFile.code === 0 && /订单状态/.test(findFile.out), findFile.out + findFile.err);
  const eqFile = db(['peek', '--table', 'T_ORDER', '--eq-file', sqlFile('eq.txt', 'CUSTOMER=张三\n'), '--count']);
  H.ok('按中文值找数据也可走参数文件', eqFile.code === 0 && /1 行/.test(eqFile.out), eqFile.out + eqFile.err);
  const emptyEq = db(['peek', '--table', 'T_ORDER', '--eq-file', sqlFile('empty-eq.txt', '\n  \n')]);
  H.ok('空的条件文件不能退化成无筛选查询', emptyEq.code === 1 && /无筛选查询/.test(emptyEq.err) && lastUse().java === 0, emptyEq.out + emptyEq.err);
  const lost = db(['query', '--sql', "SELECT COUNT(*) FROM T_ORDER WHERE CUSTOMER LIKE '%%'"]);
  H.ok('中文已经丢失变成空 LIKE，也先停下来核对', lost.code === 1 && /模式只有通配符/.test(lost.err) && lastUse().java === 0, lost.out + lost.err);
  const badFile = sqlFile('bad-encoding.sql', '');
  fs.writeFileSync(badFile, Buffer.from([0x81]));
  const badEncoding = db(['query', '--sql-file', badFile]);
  H.ok('SQL 文件坏字节不能替换后静默执行', badEncoding.code === 1 && /不能替换坏字节/.test(badEncoding.err) && lastUse().java === 0, badEncoding.out + badEncoding.err);
  const commented = db(['query', '--sql', "SELECT 1 AS N -- example LIKE '%%'", '--json']);
  H.ok('注释中的空 LIKE 不是查询条件，不误拦', commented.code === 0 && JSON.parse(commented.out).rows[0][0] === '1', commented.out + commented.err);
  const jf = sqlFile('json.sql', "SELECT CUSTOMER, STATUS FROM T_ORDER WHERE CUSTOMER = '张三'");
  const json = db(['query', '--sql-file', jf, '--json']);
  let jr = {}; try { jr = JSON.parse(json.out); } catch (e) { /* 断言展示输出 */ }
  H.ok('JSON 不混入连接备注，中文按原值返回', json.code === 0 && jr.rows && jr.rows[0][0] === '张三' && jr.truncated_cell === false && jr.truncated_rows === false, json.out + json.err);
  const cut = db(['query', '--sql', "SELECT REPEAT('x', 21000) AS V", '--json']);
  let cr = {}; try { cr = JSON.parse(cut.out); } catch (e) { /* 断言展示输出 */ }
  H.ok('JSON 明确标记单元格截断及上限', cut.code === 0 && cr.truncated_cell === true && cr.max_cell > 0, cut.out.slice(0, 150) + cut.err);
  const rowLimit = db(['query', '--sql', 'SELECT * FROM T_ORDER ORDER BY ID', '--max-rows', '1', '--json']);
  let rr = {}; try { rr = JSON.parse(rowLimit.out); } catch (e) { /* 断言展示输出 */ }
  H.ok('JSON 明确标记没有取全的行', rowLimit.code === 0 && rr.truncated_rows === true && rr.rows.length === 1, rowLimit.out + rowLimit.err);
  const many = db(['query', '--sql', 'SELECT 1 AS N', '--sql', 'SELECT * FROM NO_SUCH', '--json']);
  let mr = {}; try { mr = JSON.parse(many.out); } catch (e) { /* 断言展示输出 */ }
  H.ok('多条 JSON 查询保留每条成功、失败，不把部分结果当全成功', many.code !== 0 && mr.results && mr.results[0].ok && !mr.results[1].ok, many.out + many.err);
  const ackSql = sqlFile('ackfile.sql', "UPDATE T_ORDER SET NOTE='ack-file' WHERE ID=1");
  const pre = db(['exec', '--sql-file', ackSql]);
  const ackPath = sqlFile('ack.txt', '\ufeff' + ackOf(pre) + '\n');
  const written = db(['exec', '--sql-file', ackSql, '--ack-file', ackPath]);
  H.ok('UTF-8 BOM 文件里的确认串执行同一条写操作', pre.code === 4 && written.code === 0 && valueOf(1, 'NOTE') === 'ack-file', written.out + written.err);
  const replay = db(['exec', '--sql-file', ackSql, '--ack-file', ackPath]);
  H.ok('文件确认不能重复使用，也不能跳过重新确认', replay.code === 4 && /确认串对不上/.test(replay.err), replay.out + replay.err);
  H.write(ackPath, ackOf(pre) + '\n' + ackOf(replay));
  const multiAck = db(['exec', '--sql-file', ackSql, '--ack-file', ackPath]);
  H.ok('确认文件只能有一条串，不执行多条确认', multiAck.code === 1 && /只放一条/.test(multiAck.err) && lastUse().java === 0, multiAck.out + multiAck.err);
  execBoth("UPDATE T_ORDER SET NOTE = 'semi' WHERE ID = 3");

  H.section('peek 的条件和排序：拼进 SQL 之前先查');
  for (const [name, extra] of [['条件里夹着别的语句', ['--where', '1=1); DROP TABLE TXORDER; SELECT (1']], ['条件里有注释', ['--where', 'ID = 1 -- x']], ['条件里有写操作的关键字', ['--where', 'ID IN (SELECT ID FROM T_ORDER) OR 1 = (DELETE FROM T_ORDER)']],
    ['排序里夹着别的语句', ['--order', 'ID; TRUNCATE TABLE TXORDER']], ['排序里调函数', ['--order', 'SLEEP(10)']]]) {
    const r = db(['peek', '--table', 'T_ORDER'].concat(extra));
    H.ok(name + '：拦下，退出码 3，没起 java', r.code === 3 && /拦住了/.test(r.err) && lastUse().java === 0, [r.out + r.err, lastUse()]);
  }
  H.ok('那张表还在', db(['columns', '--table', 'TXORDER', '--fresh']).code === 0);
  const pw = db(['peek', '--table', 'T_ORDER', '--where', "AMOUNT > 10 AND CUSTOMER <> 'a;b'", '--order', 'amount desc, t.id']);
  H.ok('正常的条件和排序照常用；排序的列名换成了库里的真名', pw.code === 0 && /ORDER BY "AMOUNT" DESC, "ID"/.test(pw.out) && /李四/.test(pw.out), pw.out + pw.err);
  const po = db(['peek', '--table', 'T_ORDER', '--order', 'nope']);
  H.ok('排序的列不在这张表里：说清有哪些列', po.code === 2 && /这一项不对：nope/.test(po.err) && /CUSTOMER/.test(po.err), po.out + po.err);

  H.section('同名的表在几个 schema 里都有');
  // 这个库假装成 MySQL（库名当范围）测不了 schema：另配一个按 schema 分的连接，指着同一个库
  const cfg2 = path.join(h.root, 'by-schema.ini');
  H.write(cfg2, ['[pg]', 'dialect = kingbase', 'jdbc = ' + url, 'user = sa', 'password =', 'driver_class = org.h2.Driver', 'driver_jar = ' + H2.replace(/\\/g, '/')].join('\n') + '\n');
  const db2 = (args) => db(['--config', cfg2].concat(args));
  const exec2 = (sql) => { const a = db2(['exec', '--sql', sql]); return db2(['exec', '--sql', sql, '--ack', ackOf(a)]); };
  for (const sql of ['CREATE SCHEMA S2', 'CREATE SCHEMA S3', 'CREATE TABLE S2.T_DUP (ID INT PRIMARY KEY, A2 VARCHAR(10))', 'CREATE TABLE S3.T_DUP (ID INT PRIMARY KEY, A3 VARCHAR(10))', 'CREATE TABLE S2.T_ORDER (ID INT PRIMARY KEY, ONLY_S2 VARCHAR(10))']) exec2(sql);
  const am = db2(['columns', '--table', 'T_DUP']);
  H.ok('当前的 schema 里没有、别处有两张：不混在一起，列出来让人指定', am.code === 2 && /叫 T_DUP 的表在好几个地方都有：S2\.T_DUP、S3\.T_DUP/.test(am.out) && /--schema/.test(am.out) && !/A2|A3/.test(am.out), am.out + am.err);
  const am2 = db2(['columns', '--table', 's2.t_dup']);
  H.ok('指定了 schema：只有那一张的列；schema 和表名的大小写都自己试出来了', am2.code === 0 && /A2/.test(am2.out) && !/A3/.test(am2.out) && /主键：ID/.test(am2.out), am2.out + am2.err);
  const am3 = db2(['columns', '--table', 'T_ORDER', '--fresh']);
  H.ok('当前的 schema 里有：用当前的，别的 schema 里同名的不混进来', am3.code === 0 && /CUSTOMER/.test(am3.out) && !/ONLY_S2/.test(am3.out), am3.out + am3.err);
  const am4 = db2(['peek', '--table', 'T_DUP', '--schema', 'S3', '--count']);
  H.ok('peek 也一样', am4.code === 0 && /FROM "S3"\."T_DUP"/.test(am4.out) && db2(['peek', '--table', 'T_DUP']).code === 2, am4.out + am4.err);
  const am5 = db2(['columns', '--table', 'S2.T_ORDER']);
  const am6 = db2(['columns', '--table', 'T_ORDER']);
  H.ok('看过别的 schema 的同名表之后，再看默认的那张：拿到的还是默认的', am5.code === 0 && /ONLY_S2/.test(am5.out) && am6.code === 0 && /CUSTOMER/.test(am6.out) && !/ONLY_S2/.test(am6.out), am5.out + am6.out);
  const tb = db2(['tables']);
  H.ok('列表：没给范围只列当前 schema 的', tb.code === 0 && /T_ORDER/.test(tb.out) && !/T_DUP/.test(tb.out), tb.out + tb.err);
  for (const sql of ['DROP TABLE S2.T_DUP', 'DROP TABLE S3.T_DUP', 'DROP TABLE S2.T_ORDER']) exec2(sql);

  H.section('连接串里的口令不给人看；记过的坑人记的排前面');
  const cfg3 = path.join(h.root, 'masked.ini');
  H.write(cfg3, ['[a]', 'dialect = mysql', 'jdbc = jdbc:mysql://app:s3cr3tA@198.51.100.1:3306/x?useSSL=false&password=s3cr3tB', 'user = app', 'password = s3cr3tC', '', '[b]', 'dialect = oracle', 'jdbc = jdbc:oracle:thin:app/s3cr3tD@198.51.100.1:1521:orcl', 'user = app', 'password = s3cr3tC'].join('\n') + '\n');
  const ml = db(['--config', cfg3, 'conn', 'list']);
  H.ok('列连接：串里带的口令遮掉了', ml.code === 0 && /198\.51\.100\.1/.test(ml.out) && !/s3cr3t/.test(ml.out + ml.err), ml.out + ml.err);
  // 给这个假连接登记一个驱动（H2 的，不认 jdbc:mysql，连不上）：要的只是走到打印影响面那一步
  fs.writeFileSync(path.join(h.kit, 'drivers.json'), JSON.stringify({ version: 1, drivers: { mysql: { jar: H2, from: 'manual' } } }));
  const mp = db(['--config', cfg3, '--conn', 'a', '--timeout', '30', 'exec', '--sql', 'UPDATE T SET A = 1 WHERE ID = 1', '--dry-run']);
  fs.unlinkSync(path.join(h.kit, 'drivers.json'));
  H.ok('影响面里的地址也遮掉了；连不上、数不出行数的按高风险算', !/s3cr3t/.test(mp.out + mp.err) && /地址    jdbc:mysql:\/\/app:\*\*\*@198\.51\.100\.1:3306\/x/.test(mp.out) && /影响面  算不出来/.test(mp.out) && /风险    DANGEROUS/.test(mp.out), mp.out + mp.err);
  db(['columns', '--table', 'txorder', '--fresh']);
  db(['note', '空串写进去会变 NULL']);
  const nl = db(['note', '--list']);
  H.ok('记过的坑：人记的排在工具记的前面', nl.code === 0 && /这个连接记过的坑：\r?\n  · [\d-]+ 空串写进去会变 NULL\r?\n  · [\d-]+ 标识符要用大写/.test(nl.out), nl.out);
  H.ok('大小写的提醒一个连接只记了一条（看过好几张小写的表）', db(['columns', '--table', 't_order', '--fresh']).code === 0 && ((H.read(cfgFile) || '').match(/标识符要用大写/g) || []).length === 1, H.read(cfgFile));
  const np = db(['columns', '--table', 'TXORDER', '--fresh']);
  H.ok('没有主键的表只在输出里说，不往配置里记', /没有主键的表/.test(np.out) && !/没有主键/.test(H.read(cfgFile) || ''), [np.out, H.read(cfgFile)]);

  H.section('执行器：交过来的内容没收全就不执行');
  const cp = [path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts', 'runner'), H2].join(path.delimiter);
  const half = H.run(h, JAVA, ['-cp', cp, 'DbRunner', '--mode', 'apply', '--url', url, '--user', 'sa', '--driver-class', 'org.h2.Driver'], { input: '--@@DBCRUD-SEP@@ write\nUPDATE T_ORDER\nSET NOTE = \'half\'\n', env: { DBCRUD_PASSWORD: '' } });
  H.ok('没有结束标记（那头写到一半断了）：不执行', /"code":"INCOMPLETE"/.test(half.out) && valueOf(1, 'NOTE') !== 'half', half.out + half.err);
  const whole = H.run(h, JAVA, ['-cp', cp, 'DbRunner', '--mode', 'query', '--url', url, '--user', 'sa', '--driver-class', 'org.h2.Driver'], { input: 'SELECT COUNT(*) AS N FROM T_ORDER\n--@@DBCRUD-END@@\n', env: { DBCRUD_PASSWORD: '' } });
  H.ok('有结束标记：照常', /"ok":true/.test(whole.out) && /"rows":\[\["4"\]\]/.test(whole.out), whole.out + whole.err);
  // 提交之前再对一遍实际动了多少行：数的时候 1 行，真动的时候 4 行（数完之后有人插进来符合条件的行），回滚
  const runner = (mode, extra, input) => H.run(h, JAVA, ['-cp', cp, 'DbRunner', '--mode', mode, '--url', url, '--user', 'sa', '--driver-class', 'org.h2.Driver'].concat(extra), { input, env: { DBCRUD_PASSWORD: '' } });
  const notes = () => [1, 2, 3, 4].map((id) => valueOf(id, 'NOTE'));
  const more = runner('apply', ['--expect-count', '1'], "--@@DBCRUD-SEP@@ count\nSELECT 1\n--@@DBCRUD-SEP@@ write\nUPDATE T_ORDER SET NOTE = 'more'\n--@@DBCRUD-END@@\n");
  H.ok('真执行时动的行比确认的多：回滚，一行都没改', /"code":"AFFECTED_MORE"/.test(more.out) && !notes().includes('more'), [more.out + more.err, notes()]);
  const over = runner('apply', ['--max-affected', '2'], "--@@DBCRUD-SEP@@ write\nUPDATE T_ORDER SET NOTE = 'over'\n--@@DBCRUD-END@@\n");
  H.ok('行数数不出来的语句：执行完到了硬上限，回滚', /"code":"OVER_LIMIT"/.test(over.out) && !notes().includes('over'), [over.out + over.err, notes()]);

  H.section('init：只配开发环境的（交给套件的探索）');
  const app = H.makeRepo(path.join(h.work, 'initproj'), { 'pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>\n',
    'src/main/resources/application.yml': 'spring:\n  profiles:\n    active: dev\n',
    'src/main/resources/application-dev.yml': 'spring:\n  datasource:\n    url: jdbc:mysql://127.0.0.1:1/devdb?useSSL=false\n    username: dev_rw\n    password: Dev#2026\n',
    'src/main/resources/application-prod.yml': 'spring:\n  datasource:\n    url: jdbc:mysql://10.9.9.9:3306/coredb\n    username: prod_rw\n    password: prodpw\n' });
  const dv = db(['discover'], { cwd: app });
  H.ok('discover：两处都列出来，各是哪个环境说清了，口令不打出来', dv.code === 0 && /devdb[\s\S]*开发环境的，init 会配进来/.test(dv.out) && /coredb[\s\S]*不配：是生产环境的配置/.test(dv.out) && /不要自己往连接配置里加/.test(dv.out) && !/Dev#2026|prodpw/.test(dv.out), dv.out + dv.err);
  const it = db(['init'], { cwd: app });
  const made = H.read(path.join(app, '.vibe', 'db-crud.ini')) || '';
  H.ok('init：只把开发环境的写进了配置', it.code === 0 && /jdbc:mysql:\/\/127\.0\.0\.1:1\/devdb/.test(made) && !/coredb|10\.9\.9\.9/.test(made), it.out + it.err + made);
  H.ok('口令里的 # 没被截断', /password = Dev#2026/.test(made), made);
  H.ok('没配进来的说了是哪个、为什么，说了不要自己去配', /没配进来的 1 个/.test(it.out) && /coredb[^\n]*是生产环境的配置/.test(it.out) && /不要自己往连接配置里加/.test(it.out) && !/prodpw|Dev#2026/.test(it.out), it.out);
  H.ok('试连了（这里连不上），没有把口令打出来', /试连/.test(it.out) && /0 个连通，1 个没连上/.test(it.out), it.out);
  H.write(path.join(app, '.vibe', 'db-crud.ini'), made.replace('user = dev_rw', 'user = dev_rw\nschema = MYAPP'));
  const it2 = db(['init'], { cwd: app });
  H.ok('再跑一次：是并进去，人加的那一行还在', it2.code === 0 && /schema = MYAPP/.test(H.read(path.join(app, '.vibe', 'db-crud.ini')) || ''), it2.out + it2.err);

  H.section('配置文件的名字、位置');
  fs.renameSync(cfgFile, path.join(proj, '.vibe', 'urai-db-crud.ini'));
  const l1 = db(['conn', 'list']);
  H.ok('以前的名字 urai-db-crud.ini 照样认', l1.code === 0 && /urai-db-crud\.ini/.test(l1.out) && /main/.test(l1.out), l1.out + l1.err);
  H.write(cfgFile, ini(['driver_jar = ' + H2.replace(/\\/g, '/')]).replace('[main]', '[newer]'));
  const l2 = db(['conn', 'list']);
  H.ok('两个都在：用最近改过的那一份', /db-crud\.ini/.test(l2.out) && !/urai-db-crud\.ini/.test(l2.out) && /newer/.test(l2.out), l2.out);
  fs.unlinkSync(path.join(proj, '.vibe', 'urai-db-crud.ini'));
  H.write(cfgFile, ini(['driver_jar = ' + H2.replace(/\\/g, '/')]));
  const up = db(['conn', 'list'], { cwd: path.join(h.work, 'shell') });
  H.ok('人在壳子上：往下找到后端的配置', up.code === 0 && /backend/.test(up.out), up.out + up.err);

  H.section('驱动：不随包带，从登记表里取');
  H.ok('技能目录里没有 jar', !JSON.stringify(fs.readdirSync(path.join(h.cfg, 'skills', 'ttls-db-crud'), { recursive: true })).includes('.jar'));
  H.write(cfgFile, ini());
  try { fs.unlinkSync(path.join(proj, '.vibe', 'db-crud.env.json')); } catch (e) { /* 没有 */ }
  const n0 = usage().filter((u) => u.incident === 'no-driver').length;
  const nd = db(['conn', 'test']);
  H.ok('没有驱动：说清找过哪里、怎么办（命令和配置页）', nd.code === 1 && /找不到MySQL的 JDBC 驱动 jar/.test(nd.err) && /drivers\.js" auto --only mysql/.test(nd.err) && /数据库驱动/.test(nd.err), nd.out + nd.err);
  H.ok('记了一条"找不到驱动"（给套件收）', usage().filter((u) => u.incident === 'no-driver').length === n0 + 1, usage().slice(-3));
  fs.writeFileSync(path.join(h.kit, 'drivers.json'), JSON.stringify({ version: 1, drivers: { mysql: { jar: H2, from: 'manual' } } }));
  const rd = db(['conn', 'test']);
  H.ok('登记了之后：用登记的那个', rd.code === 0 && /驱动来自 配置页里登记的/.test(rd.out), rd.out + rd.err);
  fs.mkdirSync(path.join(proj, 'lib'), { recursive: true });
  fs.copyFileSync(H2, path.join(proj, 'lib', 'mysql-connector-j-9.9.9.jar'));
  const pl = db(['conn', 'test']);
  H.ok('项目自己 lib 里的排在登记的前面', pl.code === 0 && /驱动来自 项目的 lib/.test(pl.out), pl.out + pl.err);
  fs.rmSync(path.join(proj, 'lib'), { recursive: true, force: true });

  H.section('用量：只记工具的事');
  const all = H.read(path.join(h.kit, 'state', 'tool-usage.jsonl')) || '';
  H.ok('用量里有命令、耗时、起了几次 java', usage().some((u) => u.tool === 'ttls-db-crud' && u.cmd === 'peek' && u.ms > 0 && u.java === 1 && u.dialect === 'mysql'), usage().slice(0, 3));
  H.ok('用量里没有 SQL、数据、连接串', !/张三|待支付|jdbc:|SELECT|T_ORDER/i.test(all), all.slice(0, 600));

  H.section('后台执行器（开关，默认关）');
  const on = { env: { DBCRUD_DAEMON: '1' } };
  const d1 = db(['peek', '--table', 'T_ORDER', '--count'], on);
  const d2 = db(['peek', '--table', 'T_ORDER', '--eq', 'id=1'], on);
  const d3 = db(['columns', '--table', 'T_ORDER', '--fresh'], on);
  H.ok('打开之后照样查得到', d1.code === 0 && /^4\s*$/m.test(d1.out) && d2.code === 0 && /张三/.test(d2.out) && d3.code === 0 && /主键：ID/.test(d3.out), d1.out + d1.err + d2.out + d2.err + d3.out + d3.err);
  H.ok('后面的命令没有再起 java', lastUse().daemon === 1 && lastUse().java === 0, lastUse());
  H.ok('后面的命令比起 java 快', d2.ms < still.ms, [d2.ms, still.ms]);
  const ds = db(['daemon', 'status'], on);
  H.ok('看得到留着一个', ds.code === 0 && /✓ 端口 \d+/.test(ds.out) && /留着 1 条连接/.test(ds.out), ds.out + ds.err);
  const state = path.join(h.home, '.db-crud', 'daemon');
  const tokenFile = fs.readdirSync(state).find((n) => /\.json$/.test(n));
  const st = JSON.parse(H.read(path.join(state, tokenFile)));
  // 口令牌不对的请求
  const wrong = await new Promise((resolve) => { const s = require('net').connect(st.port, '127.0.0.1', () => { s.write('TOKEN nope\nARG mode status\nINPUT\n--@@DBCRUD-END@@\n'); }); let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => resolve(b)); s.on('error', () => resolve('')); });
  H.ok('口令牌不对：拒绝', /BAD_TOKEN/.test(wrong), wrong);
  H.ok('状态文件里写着它认得握手', st.hello === 1, st);
  const w1 = db(['exec', '--sql-file', sqlFile('d.sql', "UPDATE T_ORDER SET NOTE = 'd' WHERE ID = 2")], on);
  const w2 = db(['exec', '--sql-file', path.join(proj, '.vibe', 'tmp', 'd.sql'), '--ack', ackOf(w1)], on);
  H.ok('写操作走后台执行器也一样两步', w1.code === 4 && w2.code === 0 && /影响 1 行，已提交/.test(w2.out), w1.out + w2.out + w2.err);

  // 状态文件是残留的、那个端口被别的程序占了：先握手，对面答不上来，请求（里面有数据库口令、SQL）不发给它
  // 状态文件是残留的、那个端口被别的程序占了：先握手，对面答不上来，请求（里面有数据库口令、SQL）不发给它。
  // 先让原来那个执行器停掉（这个库是文件库，同时只能有一个进程开着），再放一份指着假端口的状态文件
  const stPath = path.join(state, tokenFile);
  await new Promise((resolve) => { const s = require('net').connect(st.port, '127.0.0.1', () => { s.write('TOKEN ' + st.token + '\nARG mode stop\nINPUT\n--@@DBCRUD-END@@\n'); }); s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve); });
  for (let i = 0; i < 40 && fs.existsSync(stPath); i++) await H.sleep(100);
  H.ok('执行器停的时候把自己的状态文件删了', !fs.existsSync(stPath));
  await H.sleep(500);
  const got = [];
  const fake = require('net').createServer((c) => { c.on('data', (d) => got.push(String(d))); c.on('error', () => {}); });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;
  fs.writeFileSync(stPath, JSON.stringify(Object.assign({}, st, { port: fakePort })));
  const hs = db(['peek', '--table', 'T_ORDER', '--eq', 'id=2'], on);
  await H.sleep(300);
  H.ok('端口被别的程序占了：握手对不上，什么都没交给它，这一次照样查得到', hs.code === 0 && /李四/.test(hs.out) && got.join('').startsWith('HELLO ') && !/TOKEN|ARG|INPUT|SELECT/.test(got.join('')), [hs.out + hs.err, got]);
  await new Promise((resolve) => fake.close(resolve));
  const st2 = JSON.parse(H.read(stPath) || '{}');
  H.ok('另起了一个执行器，状态文件换成了它的', st2.port && st2.port !== fakePort && st2.token && st2.token !== st.token, st2);

  // 写操作交出去之后没等到回话：不重发。以前会另起一个执行器再发一遍、再退回老办法发第三遍
  const viaDaemon = (sql) => { const a = db(['exec', '--sql', sql], on); return db(['exec', '--sql', sql, '--ack', ackOf(a)], on); };
  viaDaemon('CREATE ALIAS IF NOT EXISTS SLOWLY FOR "java.lang.Thread.sleep(long)"');
  const before = Number(valueOf(2, 'AMOUNT', on));
  const slow = sqlFile('slow.sql', 'UPDATE T_ORDER SET AMOUNT = AMOUNT + 1 WHERE ID = 2 AND SLOWLY(1500) IS NULL');
  const sl1 = db(['exec', '--sql-file', slow], on);
  const sl2 = db(['--timeout', '2', 'exec', '--sql-file', slow, '--ack', ackOf(sl1)], on);
  H.ok('没等到回话：说结果不明，不说"数据没有变"', sl1.code === 4 && sl2.code === 2 && /结果不明/.test(sl2.err) && /不要直接重跑/.test(sl2.err) && !/数据没有变/.test(sl2.err), sl1.out + sl1.err + sl2.out + sl2.err);
  await H.sleep(7000);
  H.ok('那条写操作只执行了一次', before > 0 && Number(valueOf(2, 'AMOUNT', on)) === before + 1, [before, valueOf(2, 'AMOUNT', on)]);
  const stop = db(['daemon', 'stop'], on);
  H.ok('停掉', stop.code === 0 && /停了 1 个/.test(stop.out), stop.out + stop.err);
  await H.sleep(800);
  H.ok('状态文件没了', !fs.readdirSync(state).some((n) => /\.json$/.test(n)), fs.readdirSync(state));
  const after = db(['peek', '--table', 'T_ORDER', '--eq', 'id=2']);
  H.ok('关着的时候照旧起 java，改的数据在', after.code === 0 && /\bd\b/.test(after.out) && lastUse().java === 1 && lastUse().daemon === 0, [after.out, lastUse()]);

  H.section('不连库就能定的判断（冒烟靶场 dev/testbed/ttls-db-crud/smoke，从 urai-db-crud 搬来的）');
  // 假连接指着 198.51.100.1（文档用的保留地址，永远连不上）：分类、配置读取、连库之前就该拦下的
  const smoke = JSON.parse(H.read(path.join(__dirname, 'testbed', 'ttls-db-crud', 'smoke', 'expected.json')));
  const bed = path.join(h.root, 'bed');
  H.copyDir(path.join(__dirname, 'testbed'), path.join(bed, 'testbed'));
  // 靶场的用例是按"驱动都有"写的（以前随包带着）：这里给假连接用到的两种数据库各登记一个（不会真去连）
  fs.writeFileSync(path.join(h.kit, 'drivers.json'), JSON.stringify({ version: 1, drivers: { mysql: { jar: H2, from: 'manual' }, dm: { jar: H2, from: 'manual' } } }));
  const mapArg = (a) => (a === 'python' ? PY : /^skills\/ttls-db-crud\//.test(a) ? path.join(h.cfg, a) : /^testbed\/ttls-db-crud\//.test(a) ? path.join(bed, a) : a);
  for (const c of smoke.checks) {
    const [exe, ...rest] = c.cmd.map(mapArg);
    const r = H.run(h, exe, rest, { cwd: bed, env: { DBCRUD_JAVA: JAVA, DBCRUD_DAEMON: '0', SMOKE_NEVER_SET: undefined } });
    const text = c.stream === 'stderr' ? r.err : c.stream === 'stdout' ? r.out : r.out + r.err;
    const miss = (c.expect_contains || []).filter((s) => !text.includes(s));
    const extra = (c.expect_not_contains || []).filter((s) => (r.out + r.err).includes(s));
    H.ok(c.name, r.code === (c.expect_exit || 0) && !miss.length && !extra.length, '退出码 ' + r.code + '（应该是 ' + (c.expect_exit || 0) + '）' + (miss.length ? '；缺：' + miss.join('、') : '') + (extra.length ? '；不该有：' + extra.join('、') : '') + '\n' + (r.out + r.err).slice(0, 1200));
  }
  H.ok('靶场里没有被写进东西（扫描只看不写）', !fs.existsSync(path.join(bed, 'testbed', 'ttls-db-crud', 'smoke', 'fake-project', '.vibe')));

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('ttls-db-crud（H2）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
