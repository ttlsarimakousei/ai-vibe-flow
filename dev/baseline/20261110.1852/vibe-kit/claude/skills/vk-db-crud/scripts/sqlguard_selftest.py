# -*- coding: utf-8 -*-
"""
sqlguard_selftest.py —— 分类器自测。不连数据库，纯离线，随包分发。

前 14 条移植自 ADT 的 RiskClassifierTest，用来保证规则搬过来没走样；
后面是它没覆盖、但真实 SQL 里会遇到的情况（注释、字面量、子查询、多语句等）。

跑法：python sqlguard_selftest.py
全过打印「全部通过」并退 0；有不过的逐条列出来并退 1。
"""
import sys

# 不在技能目录里留 __pycache__：安装器靠逐个文件比对来判断技能有没有被改过
sys.dont_write_bytecode = True
import pathlib

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import sqlguard as g                                             # noqa: E402

FORBIDDEN = ("prod_*", "*.audit_*")

CASES = []


def case(name, sql, expect_level, rows=-1, forbidden=FORBIDDEN, readonly=False, dialect=None, **kw):
    CASES.append({
        "name": name, "sql": sql, "level": expect_level, "rows": rows,
        "forbidden": forbidden, "readonly": readonly, "dialect": dialect, "extra": kw,
    })


def worst(risks):
    """一段里有多条语句时，整段按最危险的那条算。"""
    order = {g.SAFE: 0, g.WARN: 1, g.DANGEROUS: 2, g.FORBIDDEN: 3}
    return max(risks, key=lambda r: order[r.level]) if risks else None


# ---------------------------------------------------- 从 ADT 移植的 14 条
case("SELECT 是安全的", "SELECT * FROM users", g.SAFE)
case("小批量 INSERT 是安全的", "INSERT INTO users(name) VALUES ('a')", g.SAFE, rows=1)
case("带 WHERE 的 UPDATE 算 WARN", "UPDATE users SET name='x' WHERE id=1", g.WARN, rows=1)
case("不带 WHERE 的 UPDATE 危险", "UPDATE users SET name='x'", g.DANGEROUS)
case("WHERE 1=1 等于没写", "DELETE FROM users WHERE 1=1", g.DANGEROUS)
case("TRUNCATE 危险", "TRUNCATE TABLE logs", g.DANGEROUS)
case("DROP TABLE 危险", "DROP TABLE users", g.DANGEROUS)
case("DROP DATABASE 直接禁", "DROP DATABASE myapp", g.FORBIDDEN)
case("命中禁止名单", "DELETE FROM prod_orders WHERE id=1", g.FORBIDDEN, rows=1)
case("超过硬上限直接禁", "DELETE FROM logs WHERE day < '2020-01-01'", g.FORBIDDEN, rows=20_000_000)
case("影响行数过 warn 线", "UPDATE users SET active=0 WHERE created_at < '2020-01-01'", g.WARN, rows=60_000)
case("影响行数过 confirm 线", "UPDATE users SET active=0 WHERE created_at < '2020-01-01'",
     g.DANGEROUS, rows=600_000)
case("看不懂的语句判危险", "MERGE INTO target USING src ON x WHEN MATCHED THEN UPDATE SET y=1", g.DANGEROUS)
case("ALTER TABLE 危险", "ALTER TABLE users ADD COLUMN age INT", g.DANGEROUS)

# ---------------------------------------------------- 注释与字面量：最容易判错的地方
case("行注释里的 WHERE 不算数", "DELETE FROM t -- WHERE id=1\n", g.DANGEROUS)
case("块注释里的 WHERE 不算数", "DELETE FROM t /* WHERE id=1 */", g.DANGEROUS)
case("井号注释里的 WHERE 不算数（MySQL）", "DELETE FROM t # WHERE id=1\n", g.DANGEROUS, dialect="mysql")
case("字符串里的 WHERE 不算数", "UPDATE t SET note='WHERE id=1'", g.DANGEROUS)
case("字符串里的分号不切句", "UPDATE t SET note='a;b' WHERE id=1", g.WARN, rows=1)
case("MySQL 可执行注释判危险", "SELECT * FROM t /*!50000 UNION SELECT 1 */", g.DANGEROUS)
case("被注释挡住的真 WHERE 仍要认出来",
     "DELETE FROM t /* 说明 */ WHERE id = 5", g.WARN, rows=1)

# ---------------------------------------------------- WHERE 边界
case("子查询里的 WHERE 不能当作外层的",
     "DELETE FROM t WHERE id IN (SELECT id FROM s WHERE flag=1)", g.WARN, rows=1)
case("只有子查询有 WHERE，外层没有 —— 必须判危险",
     "UPDATE t SET a = (SELECT MAX(x) FROM s WHERE y=1)", g.DANGEROUS)
case("外层 WHERE 藏在子查询后面，仍要认出来",
     "UPDATE t SET a = (SELECT MAX(x) FROM s WHERE y=1) WHERE id = 9", g.WARN, rows=1)
case("嵌两层括号的子查询 WHERE 也不算外层",
     "DELETE FROM t WHERE id IN (SELECT id FROM s WHERE x IN (SELECT y FROM u WHERE z=1))",
     g.WARN, rows=1)
case("WHERE 后面跟 ORDER BY 要截断", "UPDATE t SET a=1 WHERE b=2 ORDER BY c", g.WARN, rows=1)
case("列名里含 where 不误判", "UPDATE t SET where_col=1", g.DANGEROUS)
case("WHERE TRUE 等于没写", "DELETE FROM t WHERE TRUE", g.DANGEROUS)

# ---------------------------------------------------- 禁止名单
case("带 schema 前缀也要命中", "SELECT * FROM app.audit_log", g.FORBIDDEN)
case("子查询里碰到禁止对象也要拦",
     "SELECT * FROM users WHERE id IN (SELECT uid FROM prod_sessions)", g.FORBIDDEN)
case("没命中就不拦", "SELECT * FROM production_notes", g.SAFE)

# ---------------------------------------------------- 只读连接
case("只读连接拒绝写", "UPDATE t SET a=1 WHERE id=1", g.FORBIDDEN, rows=1, readonly=True)
case("只读连接照常查", "SELECT * FROM t", g.SAFE, readonly=True)

# ---------------------------------------------------- INSERT 的行数
case("多行 INSERT 数得出行数", "INSERT INTO t(a) VALUES (1),(2),(3)", g.SAFE)
case("INSERT ... SELECT 估不出行数，要确认",
     "INSERT INTO t(a) SELECT x FROM s", g.WARN)
case("VALUES 里的括号不算行", "INSERT INTO t(a) VALUES (CONCAT('a','b'))", g.SAFE)

# ---------------------------------------------------- 各家数据库的注释、转义不一样
case("达梦：字符串以反斜杠结尾，后面的 WHERE 照样认",
     "UPDATE t SET PATH = 'D:\\upload\\' WHERE ID = 5", g.WARN, rows=1, dialect="dm")
case("MySQL：反斜杠是转义，引号没结束，WHERE 在字符串里",
     "UPDATE t SET note = 'it\\'s WHERE x=1'", g.DANGEROUS, dialect="mysql")
case("MySQL：-- 后面没有空白不是注释", "DELETE FROM t WHERE id = 5 --1", g.WARN, rows=1, dialect="mysql")
case("Oracle：-- 后面没有空白也是注释", "DELETE FROM t --WHERE id = 5", g.DANGEROUS, dialect="oracle")
case("不是 MySQL 的库里 # 不是注释", "UPDATE T#1 SET a = 1 WHERE id = 1", g.WARN, rows=1, dialect="dm")

# ---------------------------------------------------- 影响面数不出来的：按高风险
case("带 WHERE，但会动多少行数不出来", "UPDATE t SET a=1 WHERE id=1", g.DANGEROUS, rows=-1)
case("连了别的表的 UPDATE", "UPDATE a JOIN b ON a.id = b.id SET a.x = 1 WHERE b.y = 1", g.DANGEROUS, rows=1, dialect="mysql")
case("UPDATE … SET … FROM 别的表", "UPDATE a SET x = b.x FROM b WHERE a.id = b.id", g.DANGEROUS, rows=1, dialect="kingbase")
case("DELETE t FROM … JOIN：认不出表", "DELETE t FROM T_ORDER t JOIN x ON x.id = t.id WHERE x.f = 1", g.DANGEROUS, rows=1, dialect="mysql")
case("键撞上就改已有的行：不按只是插入算",
     "INSERT INTO t(a, b) VALUES (1, 2) ON DUPLICATE KEY UPDATE b = VALUES(b)", g.WARN, dialect="mysql")
case("ON CONFLICT … DO UPDATE 同理", "INSERT INTO t(a, b) VALUES (1, 2) ON CONFLICT (a) DO UPDATE SET b = 2", g.WARN, dialect="kingbase")

# ---------------------------------------------------- 达梦 / 神通 会遇到的写法
case("达梦双引号标识符", 'UPDATE "SYSDBA"."T_ORDER" SET "NAME"=\'x\' WHERE "ID"=1', g.WARN, rows=1)
case("神通的 RETURNING 要截断", "DELETE FROM t WHERE id=1 RETURNING *", g.WARN, rows=1)
case("Oracle 系的 FROM DUAL", "SELECT 1 FROM DUAL", g.SAFE)


def run():
    failures = []
    for c in CASES:
        stmts = g.analyze(c["sql"], c["dialect"])
        risks = [g.classify(s, rows=c["rows"], forbidden=c["forbidden"], readonly=c["readonly"])
                 for s in stmts]
        r = worst(risks)
        got = r.level if r else "(没解析出语句)"
        if got != c["level"]:
            failures.append((c["name"], c["sql"], c["level"], got,
                             "；".join(r.reasons) if r else ""))

    # 额外检查几个推导出来的辅助语句
    extra = []
    s = g.analyze("DELETE FROM t_order WHERE status = 'X' AND id > 100")[0]
    if g.count_sql_for(s) != "SELECT COUNT(*) FROM t_order WHERE status = 'X' AND id > 100":
        extra.append("count 改写不对：%s" % g.count_sql_for(s))
    if g.before_image_sql_for(s) != "SELECT * FROM t_order WHERE status = 'X' AND id > 100":
        extra.append("快照 SQL 不对：%s" % g.before_image_sql_for(s))
    s2 = g.analyze("UPDATE t SET a=1")[0]
    if g.count_sql_for(s2) != "SELECT COUNT(*) FROM t":
        extra.append("无 WHERE 的 count 改写不对：%s" % g.count_sql_for(s2))
    if g.before_image_sql_for(g.analyze("INSERT INTO t VALUES (1)")[0]) is not None:
        extra.append("INSERT 不该有改前快照")

    # 多语句：整段按最危险的算
    multi = g.analyze("SELECT 1; DROP TABLE users")
    if len(multi) != 2:
        extra.append("多语句没切开，切成了 %d 条" % len(multi))
    mr = worst([g.classify(s, forbidden=FORBIDDEN) for s in multi])
    if mr.level != g.DANGEROUS:
        extra.append("多语句应按最危险的算，结果是 %s" % mr.level)

    checks = 6

    def same(what, got, want):
        nonlocal checks
        checks += 1
        if got != want:
            extra.append("%s：期望 %r，实得 %r" % (what, want, got))

    # 分析完的语句就是要执行的语句：结尾的分号、注释都不在里面
    s3 = g.analyze("UPDATE T_ORDER SET STATUS = 2 WHERE ID = 5; -- 说明\n", "oracle")
    same("结尾的分号和注释不进要执行的语句", [x.raw for x in s3], ["UPDATE T_ORDER SET STATUS = 2 WHERE ID = 5"])
    # 别名
    s4 = g.analyze("UPDATE T_ORDER t SET t.STATUS = 2 WHERE t.ID = 100", "dm")[0]
    same("带别名：数行数的 SQL", g.count_sql_for(s4), "SELECT COUNT(*) FROM T_ORDER t WHERE t.ID = 100")
    same("带别名：快照的 SQL", g.before_image_sql_for(s4), "SELECT t.* FROM T_ORDER t WHERE t.ID = 100")
    s5 = g.analyze("DELETE FROM T_ORDER AS o WHERE o.ID = 1", "mysql")[0]
    same("AS 别名", (s5.table, s5.alias), ("T_ORDER", "o"))
    same("SET 不是别名", g.analyze("UPDATE T_ORDER SET A = 1 WHERE ID = 1")[0].alias, None)
    s9 = g.analyze('UPDATE "App"."Order" SET "Desc" = 1 WHERE "Id" = 5', "kingbase")[0]
    same("带引号的表名：给人看的去掉引号", s9.table, "App.Order")
    same("带引号的表名：拼出来的 SQL 照原样写", g.count_sql_for(s9), 'SELECT COUNT(*) FROM "App"."Order" WHERE "Id" = 5')
    # 子查询里的 GROUP BY / ORDER BY 不截断外层的条件
    s6 = g.analyze("DELETE FROM T WHERE ROWID NOT IN (SELECT MIN(ROWID) FROM T GROUP BY CODE)", "dm")[0]
    same("子查询里的 GROUP BY 不算", g.count_sql_for(s6), "SELECT COUNT(*) FROM T WHERE ROWID NOT IN (SELECT MIN(ROWID) FROM T GROUP BY CODE)")
    s7 = g.analyze("DELETE FROM T WHERE ID IN (SELECT ID FROM S ORDER BY X LIMIT 3) ORDER BY ID LIMIT 5", "mysql")[0]
    same("外层的 ORDER BY 才截断", s7.where, "ID IN (SELECT ID FROM S ORDER BY X LIMIT 3)")
    # 连表的数不出影响面
    same("连表的不拼数行数的 SQL", g.count_sql_for(g.analyze("UPDATE a JOIN b ON a.id = b.id SET a.x = 1 WHERE b.y = 1", "mysql")[0]), None)
    # MySQL 的 --1
    s8 = g.analyze("UPDATE t SET a = 1 WHERE id = 5 --1", "mysql")[0]
    same("MySQL 的 --1 留在条件里", s8.where, "id = 5 --1")
    # 插入的行数
    same("ON DUPLICATE 后面的 VALUES(b) 不算一行",
         g.estimate_insert_rows(g.analyze("INSERT INTO t(a, b) VALUES (1, 2), (3, 4) ON DUPLICATE KEY UPDATE b = VALUES(b)", "mysql")[0]), 2)
    # 查询命令里不许有的
    rp = lambda sql, d=None: g.readonly_problem(g.analyze(sql, d)[0])          # noqa: E731
    same("普通查询可以", rp("SELECT * FROM t WHERE a = 'INSERT INTO x'"), None)
    same("SELECT … FOR UPDATE 不行", rp("SELECT * FROM t WHERE id = 1 FOR UPDATE") is not None, True)
    same("SELECT … INTO 不行", rp("SELECT * INTO t2 FROM t") is not None, True)
    same("WITH 里有 DELETE 不行", rp("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x") is not None, True)
    same("EXPLAIN ANALYZE 不行", rp("EXPLAIN ANALYZE SELECT 1") is not None, True)
    same("CALL 不行", rp("CALL p()") is not None, True)
    # peek 的 --where、--order
    fp = g.fragment_problem
    same("条件：普通的可以", fp("STATUS = '待支付' AND AMOUNT > 10", "--where", "mysql"), None)
    same("条件：字符串里的分号不算", fp("NOTE = 'a;b'", "--where", "mysql"), None)
    same("条件：分号不行", fp("1=1); DROP TABLE T_BAK; SELECT (1", "--where", "mysql") is not None, True)
    same("条件：注释不行", fp("ID = 1 -- x", "--where", "dm") is not None, True)
    same("条件：括号不配对不行", fp("ID IN (1, 2", "--where") is not None, True)
    same("条件：写操作的关键字不行", fp("ID IN (SELECT ID FROM T) OR 1 = (DELETE FROM T)", "--where") is not None, True)
    same("排序：列名加 DESC 可以", fp("CREATED DESC, t.ID", "--order"), None)
    same("排序：塞别的不行", fp("ID; TRUNCATE T_LOG", "--order") is not None, True)
    same("排序：函数调用不行", fp("SLEEP(10)", "--order") is not None, True)

    total = len(CASES) + checks
    bad = len(failures) + len(extra)
    if not bad:
        print("全部通过：%d 项" % total)
        return 0

    print("不通过 %d / %d" % (bad, total))
    for name, sql, want, got, why in failures:
        print("  FAIL %s" % name)
        print("       SQL  %s" % sql.replace("\n", "\\n"))
        print("       期望 %s，实得 %s（%s）" % (want, got, why))
    for e in extra:
        print("  FAIL %s" % e)
    return 1


if __name__ == "__main__":
    sys.exit(run())
