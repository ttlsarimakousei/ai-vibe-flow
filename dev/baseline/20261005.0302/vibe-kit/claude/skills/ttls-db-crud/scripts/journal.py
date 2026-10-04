# -*- coding: utf-8 -*-
"""
journal.py —— 写操作留痕：改前快照、操作日志、反向 SQL。只用 Python 标准库。

落盘位置固定在用户目录 ~/.db-crud/journal/ 下，**刻意不放进被操作的项目里**：
快照里装的是真实业务数据，放进项目目录早晚会被 git 提交上去。

一次写操作留下一个目录：
  ~/.db-crud/journal/<连接名>/<时间>-<类型>/
      op.json      这次干了什么：SQL、判定、影响行数、结果
      before.json  改之前那些行长什么样（由 Java 那头在同一个事务里导出）
      undo.sql     反向 SQL，**只生成不执行**

为什么不自动回滚：ADT 的自动 undo 有一批毛病（失败了记成已撤、无主键的
UPDATE 匹配 0 行仍报成功），做成「看起来撤回了其实没撤」比不做更糟。
这一版只把反向 SQL 摆出来给人看，要不要执行、怎么执行由人决定。
"""
import datetime
import json
import os
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# JDBC 类型码里属于数字的那些（java.sql.Types）
_NUMERIC_TYPES = {-7, -6, -5, 2, 3, 4, 5, 6, 7, 8, 16}          # BIT/TINYINT/BIGINT/NUMERIC/DECIMAL/INT/SMALLINT/FLOAT/REAL/DOUBLE/BOOLEAN
_DATE_TYPES = {91}                                              # DATE
_TIME_TYPES = {92}                                              # TIME
_TIMESTAMP_TYPES = {93, 2014}                                   # TIMESTAMP, TIMESTAMP_WITH_TIMEZONE
_BINARY_TYPES = {-2, -3, -4, 2004}                              # BINARY/VARBINARY/LONGVARBINARY/BLOB


def journal_root():
    return pathlib.Path.home() / ".db-crud" / "journal"


def new_entry_dir(conn_name, kind):
    """给这次写操作开一个目录。名字带时间，天然按时间排序。"""
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    safe_conn = re.sub(r"[^\w.-]", "_", conn_name)
    d = journal_root() / safe_conn / ("%s-%s" % (stamp, kind.lower()))
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path, payload):
    path = pathlib.Path(path)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _read_json(path):
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_op(entry_dir, payload):
    return write_json(entry_dir / "op.json", payload)


def load_op(entry_dir):
    """那一次干了什么。读不出来返回 None。"""
    return _read_json(pathlib.Path(entry_dir) / "op.json")


def load_undone(entry_dir):
    """那一次还原过没有。还原过返回当时记下的内容，没有返回 None。"""
    return _read_json(pathlib.Path(entry_dir) / "undone.json")


# ============================================================ 确认串的登记
#
# 第一步给出确认串的时候登记，第二步用掉。一个串只能用一次：
# 同一条命令（带着同一个 --ack）因为超时、忘了已经做过而再跑一遍，不会再执行一遍。
# 登记的是"确认的是什么"的指纹，不是 SQL 本身。

PENDING_TTL = 24 * 3600         # 全自动模式下第一步做完、人回来再确认，可能隔了大半天
PENDING_MAX = 300


def _pending_path():
    return pathlib.Path.home() / ".db-crud" / "pending-acks.json"


def _pending_load():
    data = _read_json(_pending_path()) or {}
    items = data.get("acks")
    if not isinstance(items, dict):
        items = {}
    now = datetime.datetime.now().timestamp()
    return {k: v for k, v in items.items()
            if isinstance(v, dict) and 0 <= now - float(v.get("at") or 0) <= PENDING_TTL}


def _pending_save(items):
    p = _pending_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    if len(items) > PENDING_MAX:
        keep = sorted(items.items(), key=lambda kv: kv[1].get("at", 0), reverse=True)[:PENDING_MAX]
        items = dict(keep)
    tmp = p.with_name("%s.%d.tmp" % (p.name, os.getpid()))
    tmp.write_text(json.dumps({"version": 1, "acks": items}, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(p))


def pending_put(token, fingerprint):
    """登记一个刚给出去的确认串。登记不上（目录写不了）就抛 OSError：没登记的串第二步不认，得让人知道。"""
    items = _pending_load()
    items[str(token)] = {"fp": str(fingerprint), "at": datetime.datetime.now().timestamp()}
    _pending_save(items)


def pending_take(token, fingerprint):
    """
    第二步：这个确认串登记过、确认的东西没变，就把它取走。返回 (行不行, 不行的原因)。
    取走是在执行之前：执行到一半被结束的，这个串也不能再用，要重新走第一步。
    """
    items = _pending_load()
    rec = items.get(str(token))
    if rec is None:
        return False, "这个串没有登记过，或者已经用过了（一个确认串只能用一次），或者放了超过一天"
    if rec.get("fp") != str(fingerprint):
        return False, "SQL、影响面或者连接和确认的时候不一样了"
    del items[str(token)]
    try:
        _pending_save(items)
    except OSError:
        return False, "确认串的登记文件写不了（%s），没法记下这个串已经用过" % _pending_path()
    return True, ""


def load_snapshot(entry_dir):
    p = entry_dir / "before.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


# ============================================================ 字面量

def quote_literal(value, jdbc_type, dialect):
    """
    把一个值渲染成能放进 SQL 的字面量。

    NULL 和空串必须分得清 —— 这是还原数据最容易出错的地方，
    所以快照里 NULL 存的是 JSON 的 null，空串存的是 ""。
    """
    if value is None:
        return "NULL"
    if jdbc_type in _BINARY_TYPES:
        return None                       # 二进制没法用字面量表示，调用方要据此放弃
    s = str(value)
    if jdbc_type in _NUMERIC_TYPES:
        # 数字原样放。万一驱动给回来的不是纯数字，退回按字符串处理，宁可多一层引号
        if re.match(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$", s.strip()):
            return s.strip()
        return _quoted(s)
    if jdbc_type in _DATE_TYPES or jdbc_type in _TIMESTAMP_TYPES or jdbc_type in _TIME_TYPES:
        return _temporal_literal(s, jdbc_type, dialect)
    return _quoted(s)


def _quoted(s):
    return "'" + s.replace("'", "''") + "'"


def _temporal_literal(s, jdbc_type, dialect):
    """
    时间字面量。达梦和 Oracle 直接拿字符串比日期会依赖会话的 NLS 设置，
    所以显式套 TO_DATE / TO_TIMESTAMP，反向 SQL 才是能直接跑的。
    """
    text = s.strip()
    if dialect in ("dm", "oracle"):
        if jdbc_type in _DATE_TYPES:
            # 只有日期的也可能带时分秒，统一按完整格式
            core = text.split(".")[0].split("+")[0].strip()
            return "TO_DATE('%s','YYYY-MM-DD HH24:MI:SS')" % core if " " in core \
                else "TO_DATE('%s','YYYY-MM-DD')" % core
        core = text.split("+")[0].strip()
        return "TO_TIMESTAMP('%s','YYYY-MM-DD HH24:MI:SS.FF')" % core
    # MySQL / 神通 / 金仓 直接用字符串字面量就行
    return _quoted(text)


# ============================================================ 反向 SQL

# 拿来当列名时必须加引号的词（各家的保留字里常被拿来当列名的那些）
_RESERVED = set("""
    ALL ALTER AND AS ASC BETWEEN BY CASE CHECK COLUMN COMMENT CONDITION CONNECT CREATE DEFAULT DELETE DESC DISTINCT
    DIV DROP ELSE END EXISTS FOR FOREIGN FROM GRANT GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN KEY KEYS LEFT
    LEVEL LIKE LIMIT LOCK MOD MODE NOT NULL NUMBER OF OFFSET ON OPTION OR ORDER OUTER PRIMARY PUBLIC RANGE RANK READ
    REFERENCES RESOURCE RIGHT ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE START SYNONYM SYSDATE TABLE THEN TO
    TRIGGER UID UNION UNIQUE UPDATE USAGE USER USING VALUES VIEW WHEN WHERE WITH WRITE XOR
""".split())


def quote_name(name, dialect):
    """
    列名放进 SQL：普通的名字原样写；是保留字的（desc、order、user）、带特殊字符的加引号。
    名字是从结果集里拿的，就是库里存的那个写法，加了引号也对得上。
    """
    s = str(name)
    if re.match(r"^[A-Za-z_][A-Za-z0-9_$#]*$", s) and s.upper() not in _RESERVED:
        return s
    if dialect == "mysql":
        return "`" + s.replace("`", "``") + "`"
    return '"' + s.replace('"', '""') + '"'


def build_undo_sql(stmt_kind, table, snapshot, pk_columns, dialect):
    """
    根据改前快照生成反向 SQL。返回 (sql 文本, 说明列表)。

    DELETE 的反向是把删掉的行插回去；
    UPDATE 的反向是按主键把每行改回原值。
    两者都要求快照是完整的 —— 快照没取全就等于还原不回去，这里会直接说出来。
    table 照原来那条 SQL 里的写法给（带着引号的照样带着）。
    """
    notes = []
    if snapshot is None:
        return None, ["没有改前快照，生成不了反向 SQL"]

    cols = snapshot.get("columns", [])
    rows = snapshot.get("rows", [])
    if not cols:
        return None, ["快照里没有列信息"]

    names = [c["name"] for c in cols]
    types = {c["name"]: c.get("jdbc_type", 12) for c in cols}
    q = {n: quote_name(n, dialect) for n in names}
    # 主键的列名是从元数据里拿的，大小写可能和结果集里的不一样（金仓）：按不分大小写对
    pk_lower = {str(p).lower() for p in (pk_columns or [])}

    # 两个字段都要看：snapshot_complete 是 Java 那头明写的，truncated_rows 是取数时的实况。
    # 任何一个说没取全，就必须说出来 —— 默认当成取全了，会生成一份
    # 「只还原一部分」的反向 SQL，那比没有反向 SQL 更危险。
    if snapshot.get("snapshot_complete") is False or snapshot.get("truncated_rows"):
        notes.append("★ 快照没有取全（%s 行封顶），下面的反向 SQL 只覆盖取到的那部分，"
                     "照它执行不会把数据完全还原"
                     % snapshot.get("snapshot_max_rows", "未知"))
    elif "snapshot_complete" not in snapshot:
        notes.append("★ 这份快照没有记录「是否取全」，是旧版本留下的，"
                     "还原前请自己核对行数")
    if snapshot.get("has_binary"):
        notes.append("★ 这张表有二进制列，它的值没法写进 SQL，反向 SQL 会漏掉这些列")

    if not rows:
        return None, notes + ["改前一行都没匹配上，本来就没有东西要还原"]

    lines = []
    if stmt_kind == "DELETE":
        collist = ", ".join(q[n] for n in names)
        for row in rows:
            vals = []
            bad = False
            for i, name in enumerate(names):
                lit = quote_literal(row[i], types[name], dialect)
                if lit is None:
                    bad = True
                    break
                vals.append(lit)
            if bad:
                lines.append("-- 这一行含二进制列，还原不了：%s" % _row_key_desc(names, row, pk_columns))
                continue
            lines.append("INSERT INTO %s (%s) VALUES (%s);" % (table, collist, ", ".join(vals)))

    elif stmt_kind == "UPDATE":
        key_cols = [n for n in names if n.lower() in pk_lower]
        if len(key_cols) != len(pk_lower):
            key_cols = []                   # 主键的列在快照里不全：不能只按其中几列定位
        if not key_cols:
            # 没有主键：改过之后这些行已经不是快照里的样子了，拿快照里的值当条件一行都对不上
            return None, notes + ["★ 这张表没有主键（或者主键取不到），改过的行定位不到，生成不了反向 SQL。"
                                  "改之前的样子在 before.json 里，要还原得由人对着它来写"]
        for row in rows:
            sets = []
            wheres = []
            bad = False
            for i, name in enumerate(names):
                lit = quote_literal(row[i], types[name], dialect)
                if lit is None:
                    bad = True
                    break
                if name in key_cols:
                    wheres.append("%s = %s" % (q[name], lit) if lit != "NULL" else "%s IS NULL" % q[name])
                else:
                    sets.append("%s = %s" % (q[name], lit))
            if bad:
                lines.append("-- 这一行含二进制列，还原不了：%s" % _row_key_desc(names, row, key_cols))
                continue
            if not sets:
                continue
            lines.append("UPDATE %s SET %s WHERE %s;" % (table, ", ".join(sets), " AND ".join(wheres)))
    else:
        return None, notes + ["%s 这类语句没有「改前的样子」可以还原（结构变更、清空表等）" % stmt_kind]

    if not lines:
        return None, notes + ["没有生成出任何反向语句"]
    return "\n".join(lines), notes


def _row_key_desc(names, row, key_cols):
    parts = []
    for i, name in enumerate(names):
        if name in (key_cols or []):
            parts.append("%s=%s" % (name, row[i]))
    return "、".join(parts) if parts else "(无法描述)"


def write_undo(entry_dir, undo_sql, notes, header):
    """反向 SQL 写成文件。开头写清楚它是什么、怎么用、有什么前提。"""
    path = entry_dir / "undo.sql"
    lines = ["-- " + h for h in header.splitlines()]
    lines.append("--")
    lines.append("-- 这是反向 SQL，生成的时候没有执行。")
    lines.append("-- 要还原：db.py --conn <连接名> exec --undo <这个目录>，一样先看影响面、要人确认。")
    lines.append("-- 执行前务必自己看一遍，并确认这期间没有别人改过这些行。")
    for n in notes:
        lines.append("-- " + n)
    lines.append("")
    if undo_sql:
        lines.append(undo_sql)
    else:
        lines.append("-- （没有可用的反向 SQL，原因见上）")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def relative_to_home(p):
    """打印路径时短一点，看着清爽。"""
    try:
        return "~" + os.sep + str(pathlib.Path(p).relative_to(pathlib.Path.home()))
    except ValueError:
        return str(p)
