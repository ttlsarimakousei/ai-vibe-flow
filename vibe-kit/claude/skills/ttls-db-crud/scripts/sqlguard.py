# -*- coding: utf-8 -*-
r"""
sqlguard.py —— SQL 分类与风险分级。只用 Python 标准库，不连数据库。

这是整个 skill 的闸门。它只做一件事：看一条 SQL，说清楚
「这是什么语句、要动哪张表、有没有 WHERE、该算几级风险」。

**拿不准就往严里判。** 看不懂的语句一律 DANGEROUS，绝不因为没认出来就放行。
这个方向是刻意的：判严了最多是多问人一次，判松了是数据事故。

风险四级（沿用 ADT 的定义，规则表从它的 RiskClassifier 移植过来）：
  SAFE       建对象、数得出行数的插入
  WARN       带 WHERE 的增删改，影响面数得出来
  DANGEROUS  没有 WHERE、WHERE 恒真、改结构、看不懂的、连表的、影响面数不出来的
  FORBIDDEN  脚本硬拒，改配置才能解开
凡是写操作，不管哪一级都要人确认才执行（db.py 管）；级别只决定提醒得多重、拒不拒。

脚本层的硬拒是这里唯一靠得住的拦截。Claude Code 的权限弹窗在
bypassPermissions 这类模式下会失效，所以真正的红线必须在代码里。

词法按数据库来（dialect）：
  反斜杠转义、# 开头的注释只有 MySQL 认；别的库里 'D:\dir\' 就是一个以反斜杠结尾的字符串。
  MySQL 的 -- 后面要跟空白才是注释（a--1 是 a 减负一）；别的库里 -- 到行尾都是注释。
  不知道是哪种库（dialect 是 None）按"不是 MySQL"算。
"""
import re


def _mysql(dialect):
    return str(dialect or "").lower() == "mysql"


def _string_end(sql, i, dialect):
    """sql[i] 是一个单引号：返回这个字符串字面量结束之后的位置。"""
    n = len(sql)
    esc = _mysql(dialect)
    j = i + 1
    while j < n:
        if esc and sql[j] == "\\" and j + 1 < n:
            j += 2
            continue
        if sql[j] == "'":
            if j + 1 < n and sql[j + 1] == "'":
                j += 2
                continue
            return j + 1
        j += 1
    return n


def _line_comment_at(sql, i, dialect):
    """sql 的第 i 个字符是不是一条行注释的开头。"""
    if sql.startswith("--", i):
        if not _mysql(dialect):
            return True
        return i + 2 >= len(sql) or sql[i + 2] in " \t\r\n\x0b\x0c"
    return sql[i] == "#" and _mysql(dialect)

SAFE = "SAFE"
WARN = "WARN"
DANGEROUS = "DANGEROUS"
FORBIDDEN = "FORBIDDEN"

_ORDER = {SAFE: 0, WARN: 1, DANGEROUS: 2, FORBIDDEN: 3}

# 语句类别
SELECT = "SELECT"
INSERT = "INSERT"
UPDATE = "UPDATE"
DELETE = "DELETE"
TRUNCATE = "TRUNCATE"
DROP_TABLE = "DROP_TABLE"
DROP_SCHEMA = "DROP_SCHEMA"
ALTER_TABLE = "ALTER_TABLE"
CREATE = "CREATE"
GRANT_REVOKE = "GRANT_REVOKE"
UNKNOWN = "UNKNOWN"

WRITE_KINDS = (INSERT, UPDATE, DELETE, TRUNCATE, DROP_TABLE, DROP_SCHEMA,
               ALTER_TABLE, CREATE, GRANT_REVOKE, UNKNOWN)

# 默认阈值。和 ADT 的 SafetyConfig 对齐。连接配置里可以改（warn_above、confirm_above、hard_limit）；
# 命令行上只能收紧，见 dbconf.tighter_limits。
DEFAULT_LIMITS = {
    "warn_above": 50000,        # 影响这么多行就升到 WARN
    "confirm_above": 500000,    # 升到 DANGEROUS
    "hard_limit": 10000000,     # 超过就直接拒，不给确认的机会
}


class Stmt(object):
    """一条语句的分析结果。"""

    def __init__(self, raw, dialect=None):
        self.raw = raw                  # 去掉了注释和结尾分号的语句。分析的、给人看的、交给数据库执行的都是它
        self.dialect = dialect
        self.kind = UNKNOWN
        self.table = None               # 主要目标表，可能带 schema 前缀（引号去掉了，给人看、比禁止名单用）
        self.table_sql = None           # 目标表在 SQL 里的原样写法（带着引号）：拼数行数、取快照的 SQL 用它
        self.alias = None               # 表后面的别名（UPDATE T_ORDER t SET …）
        self.alias_sql = None
        self.multi_table = False        # 连表的写法（UPDATE a JOIN b、DELETE t FROM a t JOIN b）：影响面照单表的办法数不出来
        self.upsert = False             # INSERT … ON DUPLICATE KEY UPDATE / ON CONFLICT … DO UPDATE：会覆盖已有的行
        self.where = None               # WHERE 之后那一段（不含 WHERE 本身）
        self.has_where = False
        self.where_trivial = False      # WHERE 1=1 这种等于没写
        self.parse_note = None          # 没看懂的话，说明卡在哪
        self.identifiers = []           # 语句里出现过的所有标识符，用来比禁止名单

    def __repr__(self):
        return "<Stmt %s table=%s where=%s>" % (self.kind, self.table, self.has_where)


# ============================================================ 词法

def strip_comments(sql, dialect=None):
    """
    去掉注释，但保留字符串字面量里的内容。

    MySQL 的可执行注释 /*! ... */ 里的东西是会真的执行的，
    不能当注释去掉 —— 遇到就原样留下，后面按看不懂处理（判 DANGEROUS）。
    """
    out = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        # 单引号字符串：'' 是转义；反斜杠转义只有 MySQL 认
        if c == "'":
            j = _string_end(sql, i, dialect)
            out.append(sql[i:j])
            i = j
            continue
        # 双引号 / 反引号标识符
        if c in '"`':
            q = c
            j = i + 1
            while j < n and sql[j] != q:
                j += 1
            j = min(j + 1, n)
            out.append(sql[i:j])
            i = j
            continue
        # 行注释
        if _line_comment_at(sql, i, dialect):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            out.append(" ")
            i = j
            continue
        # 块注释
        if sql.startswith("/*", i):
            if sql.startswith("/*!", i):
                # 可执行注释，原样保留
                j = sql.find("*/", i)
                j = n if j < 0 else j + 2
                out.append(sql[i:j])
                i = j
                continue
            j = sql.find("*/", i)
            j = n if j < 0 else j + 2
            out.append(" ")
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def split_statements(sql, dialect=None):
    """按顶层分号切分。字符串和标识符里的分号不算。"""
    parts = []
    cur = []
    i = 0
    n = len(sql)
    depth = 0
    while i < n:
        c = sql[i]
        if c == "'":
            j = _string_end(sql, i, dialect)
            cur.append(sql[i:j])
            i = j
            continue
        if c in '"`':
            q = c
            j = i + 1
            while j < n and sql[j] != q:
                j += 1
            j = min(j + 1, n)
            cur.append(sql[i:j])
            i = j
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif c == ";" and depth == 0:
            parts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def _mask_literals(sql, dialect=None):
    """
    把字符串字面量换成等长的占位符，方便用正则找关键字而不会踩到
    字面量里的 'WHERE' 之类。下标和原文一一对应。
    """
    chars = list(sql)
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            j = _string_end(sql, i, dialect)
            for k in range(i, min(j, n)):
                chars[k] = "\x01"
            i = j
            continue
        if c in '"`':
            q = c
            j = i + 1
            while j < n and sql[j] != q:
                j += 1
            j = min(j + 1, n)
            # 标识符保留原样：要靠它认表名
            i = j
            continue
        i += 1
    return "".join(chars)


# ============================================================ 分析

_KIND_PATTERNS = (
    (re.compile(r"^\s*SELECT\b", re.I), SELECT),
    (re.compile(r"^\s*WITH\b", re.I), UNKNOWN),          # CTE 开头的可能是写，保守处理
    (re.compile(r"^\s*INSERT\b", re.I), INSERT),
    (re.compile(r"^\s*UPDATE\b", re.I), UPDATE),
    (re.compile(r"^\s*DELETE\b", re.I), DELETE),
    (re.compile(r"^\s*TRUNCATE\b", re.I), TRUNCATE),
    (re.compile(r"^\s*DROP\s+(DATABASE|SCHEMA)\b", re.I), DROP_SCHEMA),
    (re.compile(r"^\s*DROP\s+TABLE\b", re.I), DROP_TABLE),
    (re.compile(r"^\s*DROP\b", re.I), DROP_TABLE),        # DROP INDEX/VIEW 等，同等对待
    (re.compile(r"^\s*ALTER\s+TABLE\b", re.I), ALTER_TABLE),
    (re.compile(r"^\s*ALTER\b", re.I), ALTER_TABLE),
    (re.compile(r"^\s*CREATE\b", re.I), CREATE),
    (re.compile(r"^\s*(GRANT|REVOKE)\b", re.I), GRANT_REVOKE),
)

# 表名：可带 schema 前缀，可带引号
_IDENT = r'(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_一-龥][\w$#一-龥]*)'
_QUALIFIED = r"(?:%s\s*\.\s*)?%s" % (_IDENT, _IDENT)

# 表名后面跟着的词是这些，就不是别名
_NOT_ALIAS = ("SET", "WHERE", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "STRAIGHT_JOIN",
              "ORDER", "LIMIT", "RETURNING", "PARTITION", "FROM", "ON", "AS", "VALUES", "SELECT", "OUTPUT", "WITH")
_ALIAS = r"(?:\s+(?:AS\s+)?(%s))?" % _IDENT

_TABLE_PATTERNS = {
    UPDATE: re.compile(r"^\s*UPDATE\s+(?:ONLY\s+)?(%s)%s" % (_QUALIFIED, _ALIAS), re.I),
    DELETE: re.compile(r"^\s*DELETE\s+FROM\s+(?:ONLY\s+)?(%s)%s" % (_QUALIFIED, _ALIAS), re.I),
    INSERT: re.compile(r"\bINSERT\s+(?:IGNORE\s+)?INTO\s+(%s)" % _QUALIFIED, re.I),
    TRUNCATE: re.compile(r"\bTRUNCATE\s+(?:TABLE\s+)?(%s)" % _QUALIFIED, re.I),
    DROP_TABLE: re.compile(r"\bDROP\s+\w+\s+(?:IF\s+EXISTS\s+)?(%s)" % _QUALIFIED, re.I),
    DROP_SCHEMA: re.compile(r"\bDROP\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(%s)" % _QUALIFIED, re.I),
    ALTER_TABLE: re.compile(r"\bALTER\s+TABLE\s+(%s)" % _QUALIFIED, re.I),
    CREATE: re.compile(r"\bCREATE\s+(?:\w+\s+)*?(?:TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(%s)" % _QUALIFIED, re.I),
}

# WHERE 之后到这些关键字为止
_WHERE_END = re.compile(r"\b(ORDER\s+BY|GROUP\s+BY|LIMIT|RETURNING|FETCH\s+FIRST|FETCH\s+NEXT)\b", re.I)

# 等于没写的 WHERE
_TRIVIAL_WHERE = re.compile(r"^\s*\(?\s*(1\s*=\s*1|TRUE|'1'\s*=\s*'1')\s*\)?\s*$", re.I)


def analyze(sql_text, dialect=None):
    """
    分析一段 SQL（可能含多条语句），返回 Stmt 列表。
    多条语句里只要有一条危险，整段就按最危险的那条算。
    dialect 是连接配置里的数据库种类：注释、字符串的写法各家不一样，见文件开头。
    """
    cleaned = strip_comments(sql_text, dialect)
    out = []
    for raw in split_statements(cleaned, dialect):
        out.append(_analyze_one(raw, dialect))
    return out


def _top_level_has(masked, start, end, pattern):
    """masked[start:end] 里、括号最外层，有没有 pattern。"""
    depth = 0
    buf = []
    for ch in masked[start:end]:
        if ch == "(":
            depth += 1
            buf.append(" ")
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(" ")
        else:
            buf.append(ch if depth == 0 else " ")
    return re.search(pattern, "".join(buf), re.I) is not None


def _analyze_one(raw, dialect=None):
    st = Stmt(raw, dialect)
    masked = _mask_literals(raw, dialect)

    if "/*!" in raw:
        st.kind = UNKNOWN
        st.parse_note = "含 MySQL 可执行注释 /*! */，里面的内容会被真的执行，无法静态判断"
        return st

    for pat, kind in _KIND_PATTERNS:
        if pat.search(masked):
            st.kind = kind
            break
    else:
        st.kind = UNKNOWN
        head = raw.strip().split()[:3]
        st.parse_note = "认不出这是什么语句：%s..." % " ".join(head)

    if st.kind == UNKNOWN and not st.parse_note:
        st.parse_note = "语句类型不明"

    # 目标表
    pat = _TABLE_PATTERNS.get(st.kind)
    if pat:
        m = pat.search(masked)
        if m:
            st.table = _clean_ident(m.group(1))
            st.table_sql = " ".join(raw[m.start(1):m.end(1)].split())
            if st.kind in (UPDATE, DELETE) and m.lastindex and m.lastindex >= 2 and m.group(2):
                a = _clean_ident(m.group(2))
                if a.upper() not in _NOT_ALIAS:
                    st.alias = a
                    st.alias_sql = raw[m.start(2):m.end(2)].strip()
        elif st.kind in (UPDATE, DELETE, INSERT, TRUNCATE, ALTER_TABLE, DROP_TABLE):
            st.parse_note = "认不出目标表名"

    # 连表的写法：UPDATE a JOIN b … SET、UPDATE a, b SET、DELETE … USING、DELETE t FROM a t JOIN b
    if st.kind == UPDATE and st.table:
        s = re.search(r"\bSET\b", masked, re.I)
        head_end = s.start() if s else len(masked)
        if _top_level_has(masked, m.end(1), head_end, r"\bJOIN\b|,"):
            st.multi_table = True
        if s and _top_level_has(masked, s.end(), len(masked), r"\bFROM\b"):
            st.multi_table = True           # UPDATE … SET … FROM 别的表（金仓、PG 的写法）
    elif st.kind == DELETE and st.table:
        w0 = _where_at(masked)
        if _top_level_has(masked, m.end(1), w0 if w0 >= 0 else len(masked), r"\bJOIN\b|\bUSING\b|,"):
            st.multi_table = True
    if st.multi_table:
        st.parse_note = "连了别的表的写法，影响面照单表的办法数不出来"

    # 会覆盖已有的行的插入
    if st.kind == INSERT and _top_level_has(masked, 0, len(masked), r"\bON\s+DUPLICATE\s+KEY\s+UPDATE\b|\bON\s+CONFLICT\b"):
        st.upsert = True

    # WHERE
    if st.kind in (UPDATE, DELETE, SELECT):
        w = _find_where(masked, raw)
        if w is not None:
            st.has_where = True
            st.where = w
            st.where_trivial = bool(_TRIVIAL_WHERE.match(w))

    st.identifiers = _collect_identifiers(masked)
    return st


def _where_at(masked):
    """括号最外层的 WHERE 在哪。没有返回 -1。"""
    depth = 0
    i = 0
    n = len(masked)
    while i < n:
        c = masked[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and (c in "wW") and re.match(r"WHERE\b", masked[i:i + 6], re.I):
            # 前一个字符必须是分界，免得踩到 xxxWHERE
            if not (i > 0 and (masked[i - 1].isalnum() or masked[i - 1] == "_")):
                return i
        i += 1
    return -1


def _find_where(masked, raw):
    """
    在括号最外层找 WHERE，返回它后面那一段原文。到最外层的 ORDER BY / GROUP BY / LIMIT 为止：
    子查询里的 GROUP BY（WHERE ID NOT IN (SELECT MIN(ID) … GROUP BY CODE)）不算，算了就把条件截成半截。
    """
    i = _where_at(masked)
    if i < 0:
        return None
    rest_masked = masked[i + 5:]
    rest_raw = raw[i + 5:]
    end = len(rest_raw)
    for m in _WHERE_END.finditer(rest_masked):
        before = rest_masked[:m.start()]
        if before.count("(") <= before.count(")"):
            end = m.start()
            break
    return rest_raw[:end].strip()


def _clean_ident(s):
    return s.strip().strip('"`[]').replace('"', "").replace("`", "")


def _collect_identifiers(masked):
    """
    收集语句里出现的所有标识符（含 schema.table 形式的两段）。
    禁止名单拿它逐个比 —— 只看主表会漏掉子查询里碰到的表。
    """
    found = set()
    for m in re.finditer(_QUALIFIED, masked):
        tok = _clean_ident(m.group(0))
        if tok:
            found.add(tok)
            if "." in tok:
                found.add(tok.split(".")[-1].strip())
    return sorted(found)


# ============================================================ 风险分级

class Risk(object):
    def __init__(self, level, reasons, stmt, rows=-1):
        self.level = level
        self.reasons = reasons
        self.stmt = stmt
        self.rows = rows

    @property
    def blocked(self):
        return self.level == FORBIDDEN


def glob_to_regex(glob):
    """禁止名单用的 glob：* 任意多个字符，? 一个字符，其余按字面。大小写不敏感。"""
    out = ["^"]
    for ch in glob:
        if ch == "*":
            out.append(".*")
        elif ch == "?":
            out.append(".")
        else:
            out.append(re.escape(ch))
    out.append("$")
    return re.compile("".join(out), re.I)


def classify(stmt, rows=-1, forbidden=(), readonly=False, limits=None):
    """
    给一条语句定风险。rows 是预扫出来的影响行数，-1 表示不知道。

    规则表移植自 ADT 的 RiskClassifier，它那 14 条测试用例也一并搬到了
    testbed/urai-db-crud/smoke 里，用来保证移植没走样。
    """
    lim = dict(DEFAULT_LIMITS)
    if limits:
        lim.update({k: v for k, v in limits.items() if v is not None})

    reasons = []
    level = SAFE

    def up(new_level, why):
        nonlocal level
        reasons.append(why)
        if _ORDER[new_level] > _ORDER[level]:
            level = new_level

    # ---- 按语句类型定底 ----
    k = stmt.kind
    if k == SELECT:
        level = SAFE
        reasons.append("只读查询")
    elif k == INSERT:
        level = SAFE
        n = estimate_insert_rows(stmt)
        if n is not None:
            reasons.append("插入 %d 行" % n)
            if rows is None or rows < 0:
                rows = n
        else:
            # INSERT ... SELECT 这类，插多少行只有跑了才知道，不能当小操作放行
            up(WARN, "插入的行数估不出来（多半是 INSERT ... SELECT），执行前先确认")
        if stmt.upsert:
            up(WARN, "键撞上的时候会改掉已有的行，被改的行改之前是什么样留不下来，还原不了")
    elif k in (UPDATE, DELETE):
        if not stmt.has_where:
            up(DANGEROUS, "%s 没有 WHERE，会动全表" % k)
        elif stmt.where_trivial:
            up(DANGEROUS, "WHERE 条件恒真（%s），等于没写" % stmt.where)
        else:
            up(WARN, "%s 带 WHERE" % k)
        # 影响面数不出来的（连了别的表、认不出表、数的时候出错）：不知道会动多少行，按高风险算
        if stmt.multi_table:
            up(DANGEROUS, "连了别的表，会动多少行数不出来，改之前的样子也留不下来")
        elif not stmt.table:
            up(DANGEROUS, stmt.parse_note or "认不出要动哪张表")
        elif rows is None or rows < 0:
            up(DANGEROUS, "会动多少行数不出来")
    elif k == CREATE:
        up(SAFE, "建对象，不动已有数据")
    elif k in (TRUNCATE, DROP_TABLE, ALTER_TABLE, GRANT_REVOKE):
        up(DANGEROUS, "%s 属于结构或权限变更，改前快照救不回来" % k)
    elif k == DROP_SCHEMA:
        up(FORBIDDEN, "删库删 schema，本工具一律不做")
    else:
        up(DANGEROUS, stmt.parse_note or "看不懂这条语句，按最严处理")

    # ---- 只读连接 ----
    if readonly and k in WRITE_KINDS:
        up(FORBIDDEN, "这个连接在配置里标了 readonly，不接受任何写操作")

    # ---- 禁止名单 ----
    if forbidden:
        pats = [(g, glob_to_regex(g)) for g in forbidden]
        for ident in stmt.identifiers:
            for g, rx in pats:
                if rx.match(ident):
                    up(FORBIDDEN, "碰到了禁止名单里的对象：%s 命中规则 %s" % (ident, g))
                    break

    # ---- 影响面 ----
    if rows is not None and rows >= 0 and k in (UPDATE, DELETE, INSERT):
        if rows >= lim["hard_limit"]:
            up(FORBIDDEN, "影响 %d 行，超过硬上限 %d，确认也不给做" % (rows, lim["hard_limit"]))
        elif rows >= lim["confirm_above"]:
            up(DANGEROUS, "影响 %d 行，超过 %d" % (rows, lim["confirm_above"]))
        elif rows >= lim["warn_above"]:
            up(WARN, "影响 %d 行，超过 %d" % (rows, lim["warn_above"]))

    return Risk(level, reasons, stmt, rows)


# ============================================================ 能不能当查询跑

# 查询命令（query）只许跑查询。以前不查：有的驱动（Oracle、达梦）用查询的接口也能执行写语句，
# 改结构的语句还会自己提交 —— 等于绕过了确认。
_READ_HEAD = re.compile(r"^\s*(SHOW|DESC|DESCRIBE|EXPLAIN)\b", re.I)
_WRITE_WORD = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|INTO|CALL|EXEC|EXECUTE)\b", re.I)


def _top_level(masked):
    """只留括号深度为 0 的部分（子查询、函数参数里的抹成空格）。"""
    out = []
    depth = 0
    for ch in masked:
        if ch == "(":
            depth += 1
            out.append(" ")
        elif ch == ")":
            depth = max(0, depth - 1)
            out.append(" ")
        else:
            out.append(ch if depth == 0 else " ")
    return "".join(out)


def readonly_problem(stmt):
    """
    这条语句能不能当查询跑。能返回 None，不能返回一句原因。

    SELECT：顶层不能有 INTO（SELECT ... INTO 会建表、MySQL 的 INTO OUTFILE 会往服务器上写文件）。
    WITH 开头的：里面不能有任何写的关键字。
    SHOW / DESC / EXPLAIN：可以；EXPLAIN ANALYZE 会真的执行那条语句，不行。
    别的一律不行。拿不准就往严里判，和风险分级一个方向。
    """
    raw = stmt.raw
    masked = _mask_literals(raw, stmt.dialect)
    if "/*!" in raw:
        return "含 MySQL 可执行注释 /*! */，里面的内容会被真的执行"
    if stmt.kind == SELECT:
        top = _top_level(masked)
        m = re.search(r"\bINTO\b", top, re.I)
        if m:
            return "SELECT ... INTO 会往库里或者服务器上写东西，不是单纯的查询"
        if re.search(r"\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b", top, re.I):
            return "SELECT ... FOR UPDATE 会把查到的行锁住，别的会话要等它。只是查的话去掉这一段"
        return None
    if re.match(r"^\s*WITH\b", masked, re.I):
        m = _WRITE_WORD.search(masked)
        if m:
            return "WITH 开头的语句里有 %s，不是单纯的查询" % m.group(1).upper()
        return None
    if _READ_HEAD.match(masked):
        if re.search(r"\bANALYZE\b", masked, re.I):
            return "EXPLAIN ANALYZE 会真的执行那条语句"
        return None
    return "这是 %s，不是查询" % (stmt.kind if stmt.kind != UNKNOWN else "认不出来的语句")


def fragment_problem(text, what, dialect=None):
    """
    peek 的 --where、--order 是原样拼进 SQL 的：拼之前查一遍。没问题返回 None，有问题返回一句原因。
      不许有分号、注释（拼进去之后后面的内容就不是原来的意思了）；括号要配对；
      不许有写操作的关键字；order 只许写"列名 [ASC|DESC] [NULLS FIRST|LAST]"，用逗号隔开。
    连接串里开了 allowMultiQueries 的 MySQL，分号后面的语句是真的会执行的。
    """
    s = str(text or "")
    masked = _mask_literals(s, dialect)
    bare = re.sub("\x01+", "''", masked)
    if ";" in bare:
        return "%s 里不能有分号" % what
    if "--" in bare or "/*" in bare or "*/" in bare or (_mysql(dialect) and "#" in bare):
        return "%s 里不能有注释" % what
    if bare.count("(") != bare.count(")"):
        return "%s 里的括号不配对" % what
    m = _WRITE_WORD.search(bare)
    if m:
        return "%s 里有 %s，这不是查询的条件" % (what, m.group(1).upper())
    if what == "--order":
        item = r"\s*%s\s*(?:\s(?:ASC|DESC))?\s*(?:\sNULLS\s+(?:FIRST|LAST))?\s*" % _QUALIFIED
        if not re.match(r"^%s(?:,%s)*$" % (item, item), bare, re.I):
            return "--order 只写列名，后面可以跟 ASC / DESC，几列用逗号隔开"
    return None


def rows_in_token(token):
    """
    从确认串里取出确认时的影响行数。新串用 3rows / rows-unknown，兼容旧版中文串。
    返回 (认得出, 行数)：行数是整数，或者 None（串里写的是"行数未知"）。认不出返回 (False, None)。
    """
    m = re.search(r"-(\d+)(?:rows|行)-[0-9a-f]{8}$", str(token or ""))
    if m:
        return True, int(m.group(1))
    if re.search(r"-(?:rows-unknown|行数未知)-[0-9a-f]{8}$", str(token or "")):
        return True, None
    return False, None


# 改结构的语句：执行之后这张表的结构缓存要作废
STRUCTURE_KINDS = (TRUNCATE, DROP_TABLE, DROP_SCHEMA, ALTER_TABLE, CREATE, UNKNOWN)


# ============================================================ 由 SQL 推导辅助语句

def estimate_insert_rows(stmt):
    """
    数 INSERT ... VALUES (...), (...) 里有几组括号，就是要插几行。
    INSERT ... SELECT 这类没有 VALUES，返回 None 表示估不出来。
    """
    if stmt.kind != INSERT:
        return None
    masked = _mask_literals(stmt.raw, stmt.dialect)
    m = re.search(r"\bVALUES\b", masked, re.I)
    if not m:
        return None
    # 数到 ON DUPLICATE KEY UPDATE / ON CONFLICT 为止：后面的 VALUES(b) 不是一行数据
    tail = masked[m.end():]
    stop = re.search(r"\bON\s+(DUPLICATE\s+KEY\s+UPDATE|CONFLICT)\b", tail, re.I)
    if stop:
        tail = tail[:stop.start()]
    depth = 0
    rows = 0
    for ch in tail:
        if ch == "(":
            if depth == 0:
                rows += 1
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
    return rows or None


def count_sql_for(stmt):
    """
    把一条 UPDATE/DELETE 改写成 SELECT COUNT(*)，用来预估影响面。
    改写不了就返回 None —— 上层会当作「影响面未知」，按更严的级别处理。
    """
    if stmt.kind not in (UPDATE, DELETE) or not stmt.table or stmt.multi_table:
        return None
    src = _source_of(stmt)
    if not stmt.has_where:
        return "SELECT COUNT(*) FROM %s" % src
    return "SELECT COUNT(*) FROM %s WHERE %s" % (src, stmt.where)


def _source_of(stmt):
    """
    FROM 后面那一段：表名，带别名的把别名带上（条件里写的是 t.ID，少了别名就是语法错）。
    表名照 SQL 里的原样写（"Order"、`desc` 这种带引号的，去了引号就是另一个名字或者语法错）。
    """
    table = stmt.table_sql or stmt.table
    return "%s %s" % (table, stmt.alias_sql or stmt.alias) if stmt.alias else table


def before_image_sql_for(stmt):
    """
    改前快照：把要被改动的行原样捞出来。
    DELETE 和 UPDATE 都是 SELECT * 加同样的 WHERE。
    INSERT 没有「改前」可言，返回 None。
    """
    if stmt.kind not in (UPDATE, DELETE) or not stmt.table or stmt.multi_table:
        return None
    src = _source_of(stmt)
    star = "%s.*" % (stmt.alias_sql or stmt.alias) if stmt.alias else "*"
    if not stmt.has_where:
        return "SELECT %s FROM %s" % (star, src)
    return "SELECT %s FROM %s WHERE %s" % (star, src, stmt.where)
