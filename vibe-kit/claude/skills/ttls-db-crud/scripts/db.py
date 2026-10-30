# -*- coding: utf-8 -*-
"""
db.py —— ttls-db-crud 技能的入口。只用 Python 标准库。

它自己不连数据库：拼好参数，拉起 runner/DbRunner.class（只依赖 java.sql 的小程序），
把结果 JSON 读回来，整理成人和 Claude 都看得懂的文本。

默认每次调用都是一个新进程，跑完就退。不常驻、不开端口、不注册任何服务。
（后台执行器是个开关，默认关，见 daemon.py。）

  python db.py conn list
  python db.py conn test    --conn dev-dm
  python db.py tables       --conn dev-dm [--schema SYSDBA]
  python db.py find 订单     --conn dev-dm
  python db.py columns      --conn dev-dm --table T_ORDER,T_ORDER_ITEM
  python db.py peek         --conn dev-dm --table T_ORDER --eq STATUS=待支付 --limit 5
  python db.py query        --conn dev-dm --sql "SELECT ..." [--sql "SELECT ..."] [--max-rows 200]
  python db.py exec         --conn dev-dm --sql-file u.sql [--ack ASCII确认串 | --ack-file 文件]

口令从不出现在命令行上：由本脚本解析后，经子进程的环境变量交给 Java。

一条命令尽量只起一次 java：看表结构、试大小写、取主键在一次里做完；
写操作的核对行数、留快照、执行、提交、取主键也在一次里做完。
"""
import os
import sys

# 字节码缓存写到 ~/.db-crud/pycache/，不写进技能目录：安装器靠逐个文件比对来判断技能有没有被改过。
# 不留缓存的话每条命令都要把标准库和技能的模块重新编译一遍（0.2—0.3 秒）。
# Claude Code 给命令行设了 PYTHONDONTWRITEBYTECODE=1，这里要盖掉。
# 放在别的 import 前面：在它前面载入的模块用不上缓存。只用 os、sys，这两个起 Python 时已经载入了。
# 源文件改了（装了新版）缓存自己作废：Python 按源文件的修改时间和大小核对，对不上就重新编译。
# 找不到用户目录（expanduser 原样返回 ~）、Python 3.8 以前（没有 pycache_prefix），照旧不写缓存
_PYCACHE = os.path.join(os.path.expanduser("~"), ".db-crud", "pycache")
if hasattr(sys, "pycache_prefix") and os.path.isabs(_PYCACHE):
    sys.pycache_prefix = _PYCACHE
    sys.dont_write_bytecode = False
else:
    sys.dont_write_bytecode = True

import argparse                                                  # noqa: E402
import datetime                                                  # noqa: E402
import hashlib                                                   # noqa: E402
import json                                                      # noqa: E402
import pathlib                                                   # noqa: E402
import re                                                        # noqa: E402
import subprocess                                                # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")   # 不设的话 Windows 上错误信息里的中文全是乱码

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dbconf                                                    # noqa: E402
import journal                                                   # noqa: E402
import sqlguard                                                  # noqa: E402
import notes as notesmod                                         # noqa: E402
import vibe                                                      # noqa: E402
import discover                                                  # noqa: E402
import metacache                                                 # noqa: E402
import stats                                                     # noqa: E402
import daemon                                                    # noqa: E402

SKILL = "ttls-db-crud"
RUNNER_DIR = HERE / "runner"
RUNNER_CLASS = "DbRunner"
SEP = "--@@DBCRUD-SEP@@"
# 交给执行器的内容以这一行结束。执行器没看到它就不执行：
# 这边写到一半被结束（超时、用户按了 Esc）时，执行器那头收到的可能是半截 SQL
END = "--@@DBCRUD-END@@"

# 每格最多显示多少个字符。--width 可以改，0 是不截
DEFAULT_WIDTH = 40
# 表、字段的注释比数据要紧，多留一些
META_WIDTH = 80
# 结果只有这么几行、又有内容被截的时候，改成一列一行地竖着排，不截
VERTICAL_ROWS = 3

# 这个进程跑一条命令就退，用不着优化到最快的编译：只开第一层编译、用最简单的回收器，起得快
JVM_FLAGS = ("-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-Xshare:auto", "-XX:-UsePerfData")

EXIT_OK = 0
EXIT_USAGE = 1          # 参数或配置不对
EXIT_FAILED = 2         # 跑到了数据库那头，但失败了
EXIT_BLOCKED = 3        # 被安全规则拦住
EXIT_NEED_ACK = 4       # 要人确认才能继续，不是错误

# 这次调用的探测缓存。找 java、翻 Maven 仓库找驱动都不便宜，
# 探一次写进 .vibe/db-crud.env.json，后面的调用直接读。
ENV = None

# 这次用的配置文件。记坑要写回它。
CFG_PATH = None

# 这次调用的用量
RUN = None


# ============================================================ 调 runner

def run_runner(conn, mode, project_root, sql_segments=None, extra_args=(), timeout=120, labeled=None):
    """
    拉起一次 DbRunner，返回它输出的 JSON。

    sql_segments：要传给 runner 的 SQL 段落，用分隔行拼起来走标准输入（老的几种模式）。
    labeled：[(标签, 内容)]，每段带标签（新的几种模式）。
    走标准输入而不是命令行，是因为 Windows 命令行有长度上限，
    而且 SQL 里的引号、换行、中文经 shell 转义之后很容易坏。
    """
    if not (RUNNER_DIR / (RUNNER_CLASS + ".class")).is_file():
        stats.incident("runner", "执行器的 class 文件不在", str(RUNNER_DIR / (RUNNER_CLASS + ".class")), mode, project_root)
        raise dbconf.ConfError(
            "执行器还没编译：%s\n"
            "在有 JDK 的机器上跑一次：javac --release 8 -encoding UTF-8 -d %s %s"
            % (RUNNER_DIR / (RUNNER_CLASS + ".class"), RUNNER_DIR, RUNNER_DIR / "DbRunner.java")
        )

    try:
        java = dbconf.find_java(ENV)
    except dbconf.ConfError:
        stats.incident("no-java", "找不到 java", "", mode, project_root)
        raise
    try:
        jar, jar_from = dbconf.find_driver_jar(conn, project_root, env=ENV)
    except dbconf.ConfError:
        stats.incident("no-driver", "找不到%s的驱动" % dbconf.driver_info(conn)["name"],
                       "数据库：%s" % dbconf.driver_key(conn), mode, project_root)
        raise
    classpath = os.pathsep.join([str(RUNNER_DIR), jar])

    password = dbconf.resolve_password(conn)

    args = ["--mode", mode, "--url", conn["jdbc"]]
    if conn.get("user"):
        args += ["--user", conn["user"]]
    if conn.get("driver_class"):
        args += ["--driver-class", conn["driver_class"]]
    args += list(extra_args)

    stdin_data = ""
    if labeled:
        stdin_data = "\n".join("%s %s\n%s" % (SEP, label, text) for label, text in labeled)
    elif sql_segments:
        stdin_data = ("\n%s\n" % SEP).join(sql_segments)

    if RUN is not None:
        RUN.dialect = conn["dialect"]

    result = None
    if daemon.enabled():
        daemon_args = list(args)
        if conn.get("_config_path") and conn.get("_config_stamp"):
            daemon_args += ["--config-file", conn["_config_path"], "--config-stamp", conn["_config_stamp"]]
        result = daemon.request(java, classpath, RUNNER_CLASS, daemon_args, stdin_data, password, timeout, JVM_FLAGS)
        if result is not None and RUN is not None:
            RUN.launched(via_daemon=True)
    if result is None:
        result = _one_shot(java, classpath, args, stdin_data + "\n" + END + "\n", password, timeout, mode, project_root)

    _scrub(result, conn, password)
    if not result.get("ok") and RUN is not None:
        RUN.error(result.get("code"), result.get("sql_state"), result.get("vendor_code"))
    if result.get("code") == "RUNNER_ERROR":
        stats.incident("runner", "执行器内部出错", str(result.get("error", ""))[:300], mode, project_root)
    result["_driver_jar"] = jar
    result["_driver_from"] = jar_from
    return result


def _scrub(result, conn, password):
    """
    报错的话里不能带着口令出去：驱动、数据库的报错有时会把整个连接串原样带上，
    连接串里写着口令的（//用户:口令@、?password=）就漏了。连接串换成遮过的，口令本身也抹掉。
    """
    def clean(text):
        s = str(text)
        raw = conn.get("jdbc") or ""
        if raw and raw in s:
            s = s.replace(raw, dbconf.mask_url(raw))
        s = dbconf.mask_url(s) if "jdbc:" in s else s
        if password and len(password) >= 4 and password in s:
            s = s.replace(password, "***")
        return s

    if isinstance(result.get("error"), str):
        result["error"] = clean(result["error"])
    for one in result.get("results") or []:
        if isinstance(one, dict) and isinstance(one.get("error"), str):
            one["error"] = clean(one["error"])


def _one_shot(java, classpath, args, stdin_data, password, timeout, mode, project_root):
    cmd = [java] + list(JVM_FLAGS) + ["-Dfile.encoding=UTF-8", "-cp", classpath, RUNNER_CLASS] + args
    env = dict(os.environ)
    env["DBCRUD_PASSWORD"] = password           # 只走环境变量，不走命令行
    if RUN is not None:
        RUN.launched()
    try:
        proc = subprocess.run(
            cmd,
            input=stdin_data.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            timeout=timeout,
            **vibe.no_window()
        )
    except subprocess.TimeoutExpired:
        # 超时就杀进程。没提交的事务会随连接断开由数据库回滚。
        return {"ok": False, "code": "TIMEOUT",
                "error": "超过 %d 秒还没跑完，已经掐断。没有提交的写操作会被数据库回滚。" % timeout}
    except OSError as e:
        stats.incident("no-java", "java 起不来", str(e)[:200], mode, project_root)
        return {"ok": False, "code": "NO_JAVA", "error": "java 起不来：%s（%s）" % (e, java)}

    stdout = proc.stdout.decode("utf-8", errors="replace").strip()
    stderr = proc.stderr.decode("utf-8", errors="replace").strip()

    if not stdout:
        # JVM 不认某个启动参数（很老的、很新的 JDK）：去掉参数再来一次
        if "Unrecognized" in stderr or "Could not create the Java Virtual Machine" in stderr:
            return _plain_shot(java, classpath, args, stdin_data, env, timeout, mode, project_root)
        return _no_output(java, proc.returncode, stderr, mode, project_root)
    return _parse_output(stdout, mode, project_root)


def _no_output(java, code, stderr, mode, project_root):
    if "UnsupportedClassVersionError" in stderr:
        # 这个 java 太老。缓存里记着它的话去掉，下次重新找
        if ENV is not None:
            ENV.drop_java()
        return {"ok": False, "code": "OLD_JAVA",
                "error": "这个 java 太老，跑不了执行器（要 JDK 8 及以上）：%s\n"
                         "在 vibe-kit 配置页的「本机环境」里配一个 JDK 8 以上的，或者设环境变量 DBCRUD_JAVA 指到新的 java.exe。" % java}
    stats.incident("runner", "执行器没有任何输出", "退出码 %d。%s" % (code, stderr[:600]), mode, project_root)
    return {"ok": False, "code": "NO_OUTPUT",
            "error": "执行器没有任何输出。退出码 %d。%s" % (code, stderr[:800])}


def _plain_shot(java, classpath, args, stdin_data, env, timeout, mode, project_root):
    cmd = [java, "-Dfile.encoding=UTF-8", "-cp", classpath, RUNNER_CLASS] + args
    if RUN is not None:
        RUN.launched()
    try:
        proc = subprocess.run(cmd, input=stdin_data.encode("utf-8"), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env, timeout=timeout, **vibe.no_window())
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "TIMEOUT",
                "error": "超过 %d 秒还没跑完，已经掐断。没有提交的写操作会被数据库回滚。" % timeout}
    stdout = proc.stdout.decode("utf-8", errors="replace").strip()
    stderr = proc.stderr.decode("utf-8", errors="replace").strip()
    if not stdout:
        return _no_output(java, proc.returncode, stderr, mode, project_root)
    return _parse_output(stdout, mode, project_root)


def _parse_output(stdout, mode, project_root):
    # runner 只输出一行 JSON；万一驱动往 stdout 打了东西，取最后一行
    last = stdout.splitlines()[-1]
    try:
        return json.loads(last)
    except json.JSONDecodeError:
        stats.incident("runner", "执行器的输出不是 JSON", "输出有 %d 个字符" % len(stdout), mode, project_root)
        return {"ok": False, "code": "BAD_OUTPUT",
                "error": "执行器的输出不是 JSON：%s" % stdout[:800]}


# ============================================================ 结果排版

def dwidth(s):
    """
    字符串在等宽终端里占几格。中文、日文、全角标点占两格，
    直接用 len() 排版会错位 —— 这个工具的表名和注释多半是中文。
    """
    import unicodedata
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def dljust(s, width):
    pad = width - dwidth(s)
    return s + " " * pad if pad > 0 else s


def _cell(v):
    if v is None:
        return "NULL"                         # 和空串区分开，这在还原数据时很要紧
    return str(v).replace("\n", "\\n").replace("\r", "")


def print_rows(result, max_col_width=DEFAULT_WIDTH, hint=True):
    """
    把结果集排成文本表格。宽的内容按列截断，截断了要说出来、说怎么看全。
    max_col_width 是 0 就不截。结果只有两三行、又有内容会被截的：改成竖着排（一列一行），不截 ——
    查一条配置、一段 JSON、一个报错的时候，要的就是那个完整的值。
    """
    cols = [c["name"] for c in result.get("columns", [])]
    rows = result.get("rows", [])
    if not cols:
        print("(没有列)")
        return
    if not rows:
        print("(0 行)")
        return

    limit = max_col_width if max_col_width and max_col_width > 0 else 0
    raw = [[_cell(v) for v in row] for row in rows]
    too_long = limit and any(len(s) > limit for row in raw for s in row)
    vertical = bool(too_long) and len(rows) <= VERTICAL_ROWS
    clipped = False

    if vertical:
        w = max(dwidth(c) for c in cols)
        for n, row in enumerate(raw):
            print("── 第 %d 行" % (n + 1))
            for i, s in enumerate(row):
                if i < len(cols):
                    print("%s  %s" % (dljust(cols[i], w), s))
    else:
        cells = []
        for row in raw:
            out = []
            for s in row:
                if limit and len(s) > limit:
                    s = s[:limit - 1] + "…"
                    clipped = True
                out.append(s)
            cells.append(out)

        widths = [dwidth(c) for c in cols]
        for row in cells:
            for i, s in enumerate(row):
                if i < len(widths):
                    widths[i] = max(widths[i], dwidth(s))

        sep = "  "
        print(sep.join(dljust(c, widths[i]) for i, c in enumerate(cols)))
        print(sep.join("-" * w for w in widths))
        for row in cells:
            print(sep.join(dljust(s, widths[i]) for i, s in enumerate(row)))

    notes = ["%d 行" % result.get("row_count", len(rows))]
    if result.get("truncated_rows"):
        notes.append("★ 还有更多行没取，这只是前一段")
    if clipped:
        notes.append("★ 有内容太长被截断了（每格 %d 个字符）。要看全：%s"
                     % (limit, "同一条命令加 --width 0（不截），或者 --width 200 这样放宽" if hint else "单独查那一个值"))
    if result.get("truncated_cell"):
        notes.append("★ 有的值特别长（超过 %d 个字符），只取了前面一段" % result.get("max_cell", MAX_CELL))
    if result.get("has_binary"):
        notes.append("★ 有二进制列，显示成占位符")
    if "elapsed_ms" in result:
        notes.append("%d ms" % result["elapsed_ms"])
    print()
    print("　".join(notes))


# 执行器那头每格最多取多少个字符。再长的（大段的日志、整篇文章）只取前面这么多，结果里会说
MAX_CELL = 20000


def width_args(args):
    """--width 转成 (每格显示多少, 给执行器的参数)。"""
    w = getattr(args, "width", None)
    w = DEFAULT_WIDTH if w is None else max(0, int(w))
    return w, ["--max-cell", str(MAX_CELL)]


def die(result, conn=None):
    """把 runner 的失败打成人话，返回退出码。"""
    code = result.get("code", "UNKNOWN")
    print("失败（%s）：%s" % (code, result.get("error", "")), file=sys.stderr)
    if result.get("sql_state"):
        print("SQLSTATE %s，厂商错误码 %s" % (result["sql_state"], result.get("vendor_code")), file=sys.stderr)
    if str(result.get("sql_state") or "") == "42S22" or (conn and conn.get("dialect") == "oracle" and str(result.get("vendor_code")) == "904"):
        print("先用 columns --fresh 重新读取 涉及的表或视图，核对 schema、真实字段、别名作用域及双引号大小写；用最小只读查询确认。不要重复盲试原 SQL。上报仍只含错误码和次数，原语句及结构在本机核对。", file=sys.stderr)
    if conn is not None:
        _connect_hint(conn, result)
    return EXIT_FAILED


def _connect_hint(conn, result):
    """连不上的时候：说清用的是哪个驱动、口令不对该怎么办。口令在配置文件里，不让模型去翻。"""
    err = str(result.get("error", ""))
    low = err.lower()
    state = str(result.get("sql_state") or "")
    if result.get("_driver_jar"):
        print("用的驱动：%s（%s）" % (result["_driver_jar"], result.get("_driver_from")), file=sys.stderr)
    if conn["dialect"] == "oracle" and ("ora-28040" in low or "ora-12505" in low or "ora-12514" in low
                                        or "no matching authentication" in low or "unsupported" in low):
        print("Oracle 的驱动和库的版本要对得上：连 11g 用 ojdbc6 一带的，连 19c 以上用 ojdbc8 / ojdbc11。"
              "换驱动：在 vibe-kit 配置页的「数据库驱动」里选，或者把 jar 的路径写进这个连接的 driver_jar。",
              file=sys.stderr)
    if ("access denied" in low or "password" in low or "口令" in err or "密码" in err
            or state == "28000" or "ora-01017" in low):
        print("像是账号或者口令不对。口令写在连接配置里：告诉用户去改配置里 [%s] 那一段的 password，"
              "你不要自己打开那个文件（里面有口令）。" % conn["name"], file=sys.stderr)


def meta_scope_args(conn, schema):
    """
    MySQL 把库名放在 catalog 上，其它几家放在 schema 上。
    这是 JDBC 元数据接口的老差异，在这里抹平，免得使用者去记。
    （老的 meta 模式用；大小写由调用方自己试。）
    """
    s = schema or conn.get("schema") or ""
    c = conn.get("catalog") or ""
    args = []
    if conn["dialect"] == "mysql":
        args += ["--catalog", c or s] if (c or s) else []
    else:
        if s:
            args += ["--schema", s]
        if c:
            args += ["--catalog", c]
    return args


def scope_args(conn, schema):
    """
    新的几种模式用：表在库里的范围。和 meta_scope_args 的区别是大小写交给执行器去试 ——
    schema 会跟着表名一起试（原样、全大写、全小写），配置里写死的 catalog 不试。
    什么范围都没给的时候，执行器只在当前登录的 schema / 库里找；那里没有才到别处找，
    别处有好几张同名的就报出来让人指定，不把它们的列混在一起。
    """
    s = schema or conn.get("schema") or ""
    c = conn.get("catalog") or ""
    args = []
    if conn["dialect"] == "mysql":
        args += ["--schema-as-catalog", "true"]
        if s:
            args += ["--schema", s]
        elif c:
            args += ["--catalog", c]
    else:
        if s:
            args += ["--schema", s]
        if c:
            args += ["--catalog", c]
    return args


# ============================================================ 各子命令

def cmd_conn_list(args, conns, cfg_path):
    print("配置文件：%s" % cfg_path)
    print()
    for name in sorted(conns):
        c = conns[name]
        info = dbconf.DIALECT_INFO[c["dialect"]]
        flags = []
        if c["readonly"]:
            flags.append("只读")
        if not c["password_raw"].strip():
            flags.append("无口令")
        if c.get("source"):
            flags.append("自动探索到的，来自 " + c["source"])
        if c.get("forbid"):
            flags.append("不许碰 " + "、".join(c["forbid"]))
        print("  %s %s %s%s" % (dljust(name, 16), dljust(info["name"], 8), dbconf.mask_url(c["jdbc"]),
                                ("　[" + "，".join(flags) + "]") if flags else ""))
    print()
    print("用 --conn <名字> 指定要操作哪一个。")
    return EXIT_OK


def cmd_conn_test(args, conn, project_root):
    r = run_runner(conn, "ping", project_root, timeout=args.timeout)
    if not r.get("ok"):
        return die(r, conn)
    print("连上了：%s" % conn["name"])
    print("  数据库  %s %s" % (r.get("product"), r.get("product_version")))
    print("  驱动    %s %s" % (r.get("driver"), r.get("driver_version")))
    print("  驱动来自 %s：%s" % (r.get("_driver_from"), r.get("_driver_jar")))
    print("  登录用户 %s" % r.get("user"))
    print("  当前 schema %s　catalog %s" % (r.get("schema"), r.get("catalog")))
    if conn["readonly"]:
        print("  这个连接标了 readonly，写操作会被脚本拒绝")
    return EXIT_OK


def cmd_tables(args, conn, project_root):
    extra = ["--meta", "tables"] + meta_scope_args(conn, args.schema)
    if args.pattern:
        extra += ["--pattern", args.pattern]
    r = run_runner(conn, "meta", project_root, extra_args=extra, timeout=args.timeout)
    if not r.get("ok"):
        return die(r, conn)
    # DatabaseMetaData 返回的列很多，这里只留有用的几列
    keep = ["TABLE_SCHEM", "TABLE_CAT", "TABLE_NAME", "TABLE_TYPE", "REMARKS"]
    _print_subset(r, keep)
    if not r.get("row_count") and not args.schema and not conn.get("schema"):
        print("一张表都没列出来。多半是没指定 schema：加 --schema <SCHEMA>，或者按关键字找：db.py --conn %s find <关键字>"
              % conn["name"])
    return EXIT_OK


def _note(conn, text, once=None):
    """记一条坑。悄悄失败 —— 记不上不该影响正事。"""
    if CFG_PATH is None:
        return
    try:
        notesmod.add(CFG_PATH, conn["name"], text, once=once)
    except (OSError, ValueError):
        pass


def show_notes(conn, show_all=False):
    """用到某个连接时，先把它记过的坑摆出来。"""
    text = notesmod.render(conn.get("notes") or [], conn_name=conn["name"], show_all=show_all)
    if text:
        print(text)
        print()


def _case_note(conn, t):
    """库里实际的写法和问的不一样：说一声，顺手记一条坑（一个连接只记一条，不一张表记一条）。"""
    if t.get("variant") in ("upper", "lower"):
        asked = t.get("asked", "").split(".")[-1]
        print("（库里这张表实际叫 %s，按你给的 %s 查不到）" % (t.get("table"), asked))
        kind = "标识符要用%s" % ("大写" if t.get("variant") == "upper" else "小写")
        _note(conn, "%s：表名按 %s 这样写，%s 查不到" % (kind, t.get("table"), asked), once=kind)


def _tried_text(t):
    tried = t.get("tried") or []
    return "试过的写法：%s。" % "、".join(tried) if tried else "大小写几种写法都试过了。"


def _ambiguous(t, conn, asked):
    """同名的表在好几个 schema / 库里都有：列出来，让人指定。"""
    where = t.get("ambiguous") or []
    print("叫 %s 的表在好几个地方都有：%s。" % (asked, "、".join(where)))
    print("当前登录的 schema / 库里没有这张表，不知道你要的是哪一张：加 --schema <名字> 指定，"
          "或者把表名写成 <名字>.%s。" % asked.split(".")[-1])


def cmd_peek(args, conn, project_root):
    """
    看看这张表里有什么。最常做的事，不该还要先写一个 SQL 文件。
    等值条件用 --eq 列名=值（可以写好几个），值不用加引号。
    """
    show_notes(conn)
    schema = args.schema or conn.get("schema") or ""
    labeled = []
    for item in args.eq or []:
        if "=" not in item:
            print("--eq 要写成 列名=值，这个不对：%s" % item, file=sys.stderr)
            return EXIT_USAGE
        col, val = item.split("=", 1)
        labeled.append(("eq:" + col.strip(), val))
    # --where、--order 是原样拼进 SQL 的：拼之前查一遍，不许夹带别的语句
    for what, text in (("--where", args.where), ("--order", args.order)):
        why = sqlguard.fragment_problem(text, what, conn["dialect"]) if text else None
        if why:
            print("拦住了：%s。" % why, file=sys.stderr)
            print("peek 只用来看一张表里的数据。条件复杂的用 query 写完整的查询；要改数据用 exec。", file=sys.stderr)
            return EXIT_BLOCKED
    if args.where:
        labeled.append(("where", args.where))
    if args.order:
        labeled.append(("order", args.order))
    if args.cols:
        labeled.append(("cols", args.cols))
    if not labeled:
        labeled.append(("none", ""))
    width, cell = width_args(args)
    extra = ["--table", args.table, "--max-rows", str(args.limit)] + cell + scope_args(conn, schema)
    if args.count:
        extra += ["--count-only", "true"]
    r = run_runner(conn, "peek", project_root, labeled=labeled, extra_args=extra, timeout=args.timeout)
    if not r.get("ok"):
        return die(r, conn)
    if r.get("ambiguous"):
        _ambiguous(r, conn, args.table)
        return EXIT_FAILED
    if not r.get("found"):
        # 表都找不到就别再拼 SQL 去跑了 —— 跑出来只会是一句数据库原话，
        # 说的还是「无效的表名」，对人没有任何新信息。
        print("找不到表 %s%s。%s"
              % (("%s." % schema) if schema else "", args.table, _tried_text(r)))
        print("按关键字找：db.py --conn %s find <关键字>；列出这个 schema 下所有的表：db.py --conn %s tables%s"
              % (conn["name"], conn["name"], (" --schema %s" % schema) if schema else ""))
        return EXIT_FAILED
    _case_note(conn, r)
    print("SQL：%s" % r.get("sql"))
    if r.get("binds"):
        print("其中 ? 依次是：%s" % "；".join(r["binds"]))
    print_rows(r, width)
    return EXIT_OK


def cmd_note(args, conn, project_root):
    """把踩过的坑记进配置，下次用这个连接就能看见。"""
    if args.list or not args.text:
        show_notes(conn, show_all=True)
        if not conn.get("notes"):
            print("这个连接还没记过什么。")
        return EXIT_OK
    ok, msg = notesmod.add(CFG_PATH, conn["name"], " ".join(args.text))
    if ok:
        print("记下了（连接 %s）：%s" % (conn["name"], msg))
    else:
        print("没记：%s" % msg)
    return EXIT_OK


def _age_text(seconds):
    if seconds < 90:
        return "刚存的"
    if seconds < 5400:
        return "%d 分钟前存的" % round(seconds / 60.0)
    return "%d 小时前存的" % round(seconds / 3600.0)


def cmd_columns(args, conn, project_root):
    """看表结构。一次可以看几张表（逗号隔开）；看过的存在本地，再看不用连库。"""
    show_notes(conn)
    schema = args.schema or conn.get("schema") or ""
    names = [t.strip() for t in args.table.split(",") if t.strip()]
    if not names:
        print("--table 要给表名", file=sys.stderr)
        return EXIT_USAGE

    got = {}
    missing = []
    for n in names:
        hit = None if args.fresh else metacache.get(project_root, conn["name"], schema, n)
        if hit:
            got[n] = hit
            if RUN is not None:
                RUN.cached += 1
        else:
            missing.append(n)

    if missing:
        r = run_runner(conn, "describe", project_root,
                       extra_args=["--tables", ",".join(missing)] + scope_args(conn, schema),
                       timeout=args.timeout)
        if not r.get("ok"):
            return die(r, conn)
        for t in r.get("tables", []):
            got[t.get("asked")] = t
            metacache.put(project_root, conn["name"], schema, t.get("asked"), t)

    code = EXIT_OK
    for i, n in enumerate(names):
        t = got.get(n)
        if i:
            print()
        if t and t.get("ambiguous"):
            _ambiguous(t, conn, n)
            code = EXIT_FAILED
            continue
        if not t or not t.get("found"):
            print("找不到表 %s。%s" % (n, _tried_text(t or {})))
            print("按关键字找：db.py --conn %s find <关键字>" % conn["name"])
            code = EXIT_FAILED
            continue
        where = ("%s.%s" % (t["schema"], t["table"])) if t.get("schema") else t["table"]
        if len(names) > 1 or t.get("age") is not None:
            print("【%s】%s" % (where, ("　来自本地缓存，%s；库里的表结构改过的话加 --fresh 重新查" % _age_text(t["age"]))
                               if t.get("age") is not None else ""))
        if t.get("age") is None:
            _case_note(conn, t)
        keep = ["COLUMN_NAME", "TYPE_NAME", "COLUMN_SIZE", "DECIMAL_DIGITS", "IS_NULLABLE",
                "COLUMN_DEF", "REMARKS"]
        _print_subset(t.get("columns") or {}, keep)
        pk = t.get("primary_keys") or []
        print()
        print("主键：%s" % ("、".join(pk) if pk else "（没有主键）"))
        if not pk:
            # 只在这里说，不往连接配置里记：一张表记一条的话，人记的那几条会被挤得显示不出来
            print("★ 没有主键的表，改数据之后很难精确还原：改之前先想清楚怎么还原。")
    return code


def cmd_find(args, conn, project_root):
    """按关键字找表和字段：表名、注释、列名、列的注释里带这个词的都列出来。"""
    show_notes(conn)
    kw = " ".join(args.keyword).strip()
    if not kw:
        print("要给关键字", file=sys.stderr)
        return EXIT_USAGE
    extra = scope_args(conn, args.schema) + ["--max-hits", str(args.limit)]
    if args.tables_only:
        extra += ["--tables-only", "true"]
    r = run_runner(conn, "find", project_root, labeled=[("keyword", kw)], extra_args=extra, timeout=args.timeout)
    if not r.get("ok"):
        return die(r, conn)
    tables = r.get("tables") or []
    cols = r.get("columns") or []
    print("在 %s 里找「%s」：%d 张表，%d 个字段。（看了 %d 张表、%d 个字段，%d ms）"
          % (r.get("scope") or "当前库", kw, len(tables), len(cols),
             r.get("tables_scanned", 0), r.get("columns_scanned", 0), r.get("elapsed_ms", 0)))
    if tables:
        print()
        print_rows({"columns": [{"name": n} for n in ("所在", "表", "类型", "注释")], "rows": tables,
                    "row_count": len(tables)}, META_WIDTH, hint=False)
    if cols:
        print()
        print_rows({"columns": [{"name": n} for n in ("所在", "表", "字段", "类型", "长度", "注释")], "rows": cols,
                    "row_count": len(cols)}, META_WIDTH, hint=False)
    if r.get("truncated"):
        print()
        print("★ 没看完（到了时间或者条数的上限）。关键字写具体些，或者加 --schema 缩小范围、加 --tables-only 只找表。")
    if not tables and not cols:
        print("没找到。注释里找不到的话，可能是这个库没开注释查询（Oracle 要 remarksReporting，MySQL 要 useInformationSchema）；"
              "换成表名、字段名里的英文词再找。")
    return EXIT_OK


def cmd_query(args, conn, project_root):
    """只读查询。可以一次给几条（几个 --sql，或者文件里用分号隔开），一次连库跑完。"""
    if not args.json:
        show_notes(conn)
    texts = read_sqls(args)
    stmts = []
    for t in texts:
        stmts.extend(sqlguard.analyze(t, conn["dialect"]))
    if not stmts:
        print("没有 SQL", file=sys.stderr)
        return EXIT_USAGE
    for s in stmts:
        why = sqlguard.readonly_problem(s)
        if why:
            print("拦住了：query 只跑查询。%s。" % why, file=sys.stderr)
            print("  " + " ".join(s.raw.split())[:120], file=sys.stderr)
            print("要改数据、改结构用 exec（会先算影响面、要人确认）。", file=sys.stderr)
            return EXIT_BLOCKED

    width, cell = width_args(args)
    if len(stmts) == 1:
        r = run_runner(conn, "query", project_root, sql_segments=[stmts[0].raw],
                       extra_args=["--max-rows", str(args.max_rows)] + cell, timeout=args.timeout)
        if not r.get("ok"):
            return die(r, conn)
        if args.json:
            print(json.dumps(r, ensure_ascii=False))
        else:
            print_rows(r, width)
        return EXIT_OK

    r = run_runner(conn, "multi", project_root, sql_segments=[s.raw for s in stmts],
                   extra_args=["--max-rows", str(args.max_rows)] + cell, timeout=args.timeout)
    if not r.get("ok"):
        return die(r, conn)
    if args.json:
        print(json.dumps(r, ensure_ascii=False))
        return EXIT_FAILED if any(not one.get("ok") for one in r.get("results", [])) else EXIT_OK
    code = EXIT_OK
    for i, (s, one) in enumerate(zip(stmts, r.get("results", []))):
        if i:
            print()
        print("── 第 %d 条：%s" % (i + 1, " ".join(s.raw.split())[:100]))
        if not one.get("ok"):
            print("失败（%s）：%s" % (one.get("code"), one.get("error", "")))
            if one.get("sql_state"):
                print("SQLSTATE %s，厂商错误码 %s" % (one["sql_state"], one.get("vendor_code")))
            if RUN is not None:
                RUN.error(one.get("code"), one.get("sql_state"), one.get("vendor_code"))
            code = EXIT_FAILED
            continue
        print_rows(one, width)
    return code


def _kit_tool():
    """
    套件的探索工具和 node。没装套件、没有 node 返回 (None, None)：那时用这里自带的扫描。
    扫项目、分环境交给套件做：它认得全（按 profile 分段的配置、多数据源的名字、默认激活的环境），
    后台自动探索用的也是它，两边的结论不会不一样。
    """
    k = vibe.kit_dir()
    if k is None:
        return None, None
    t = k / "tools" / "onboard.js"
    if not t.is_file():
        return None, None
    import shutil
    node = shutil.which("node")
    return (str(t), node) if node else (None, None)


def _kit_run(tool, node, cmd, project_root, extra=(), timeout=120):
    """跑套件的探索工具，拿回它那一行 JSON。跑不成返回 None。"""
    try:
        p = subprocess.run([node, tool, cmd, "--dir", str(project_root), "--json"] + list(extra),
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, **vibe.no_window())
    except (OSError, subprocess.SubprocessError):
        return None
    lines = p.stdout.decode("utf-8", errors="replace").strip().splitlines()
    if not lines:
        return None
    try:
        r = json.loads(lines[-1])
    except ValueError:
        return None
    return r if isinstance(r, dict) and r.get("ok") else None


NOT_DEV_RULE = "不是开发环境的不会配进来，你也不要自己往连接配置里加：要查那些库，告诉用户，由用户来配。"


def _dialect_name(d):
    info = dbconf.DIALECT_INFO.get(d or "")
    return info["name"] if info else ""


def cmd_discover(args, project_root):
    """只扫不写：这个项目用到了哪些数据库、配置在哪、各是哪个环境的。"""
    items = None
    tool, node = _kit_tool()
    if tool:
        r = _kit_run(tool, node, "scan", project_root)
        if r is not None:
            items = [{"url": x.get("url", ""), "source": x.get("source", ""), "line": x.get("line", 0),
                      "user": x.get("user", ""), "dialect": x.get("dialect", ""),
                      "password": "是加密的" if x.get("encrypted") else "有" if x.get("hasPassword") else "没找到",
                      "unresolved": x.get("unresolved"), "why": x.get("why", "")}
                     for x in r.get("db") or []]
    if items is None:
        items = [{"url": dbconf.mask_url(f.url), "source": f.source, "line": f.line, "user": f.user or "",
                  "dialect": f.dialect or "",
                  "password": "有" if f.password_usable else "没找到" if not f.password else "用不了（加密的，或者是占位符）",
                  "unresolved": f.unresolved, "why": f.why}
                 for f in discover.scan(project_root)]
    if not items:
        print("在 %s 下没找到数据库配置。" % project_root)
        return EXIT_OK
    print("在 %s 下找到 %d 处：" % (project_root, len(items)))
    print()
    skipped = 0
    for x in items:
        if x["unresolved"]:
            state = "跳过：连接串里有没展开的占位符"
        elif not x["dialect"]:
            state = "跳过：不支持这种数据库"
        elif x["why"]:
            state = "不配：%s" % x["why"]
            skipped += 1
        else:
            state = "开发环境的，init 会配进来"
        print("  %s" % x["url"])
        print("    %s:%s　%s　用户 %s　口令 %s" % (x["source"], x["line"], _dialect_name(x["dialect"]) or "不认识的数据库",
                                                 x["user"] or "没找到", x["password"]))
        print("    %s" % state)
    print()
    print("把开发环境的配进来并逐个试连：db.py init")
    if skipped:
        print(NOT_DEV_RULE)
    return EXIT_OK


def cmd_init(args, project_root):
    """
    扫项目、把**开发环境**的库配进来、逐个试连。

    被操作的项目自己就存着连接信息（Spring Boot 的 application.yml、
    老项目的 jdbc.properties、Druid 的 XML），没道理让人再手打一遍。
    测试、生产环境的不配：这个命令模型自己会跑，配进来就等于把生产库交到了它手上。
    """
    tool, node = _kit_tool()
    if tool:
        code = _init_by_kit(args, project_root, tool, node)
        if code is not None:
            return code
        print("套件的探索没跑成，改用技能自带的扫描。")
    return _init_standalone(args, project_root)


def _init_by_kit(args, project_root, tool, node):
    """交给套件的探索去做（和后台自动探索是同一套）。已有的配置是并进去，人改过的不动。跑不成返回 None。"""
    import time
    print("在 %s 下找数据库配置（只配开发环境的）……" % project_root)
    results = None
    for _ in range(5):
        r = _kit_run(tool, node, "run", project_root, ["--force"], timeout=180)
        if r is None:
            return None
        results = r.get("results") or []
        if results:
            break
        time.sleep(2)                   # 后台正在探索这个项目（锁着）：等它一下
    if not results:
        print("这个目录下没有能探索的项目，或者后台正在探索：过一会儿再跑一次。")
        return EXIT_OK

    files = []
    not_dev = []
    for x in results:
        if x.get("error"):
            print("  ✗ %s：探索出错（%s）" % (x.get("root"), x["error"]))
            continue
        for f in x.get("dbFiles") or []:
            files.append((pathlib.Path(f["file"]), list(f.get("names") or [])))
        not_dev += [n for n in (x.get("notDev") or []) if n.get("kind") == "db"]
        for d in x.get("drivers") or []:
            print("  顺手登记了驱动：%s" % d)

    print()
    total = sum(len(names) for _, names in files)
    if not total:
        print("没找到开发环境的数据库配置。")
    targets = []
    for path, names in files:
        try:
            conns = dbconf._parse(path)
        except dbconf.ConfError as e:
            print("  读回配置失败：%s" % e, file=sys.stderr)
            continue
        print("%s 里有 %d 个连接：" % (path, len(names)))
        for name in names:
            c = conns.get(name)
            if c is None:
                continue
            print("  %s %s %s" % (dljust(name, 14), dljust(_dialect_name(c["dialect"]), 8), dbconf.short_url(c["jdbc"])[:72]))
            if c.get("source"):
                print("    来自 %s" % c["source"])
            targets.append((name, c, str(path.parent.parent)))
    if not_dev:
        print()
        print("没配进来的 %d 个：" % len(not_dev))
        for n in not_dev[:12]:
            print("  · %s（%s，%s）" % (n.get("url"), n.get("source"), n.get("why")))
        print(NOT_DEV_RULE)
    if not targets:
        if not not_dev:
            path, made = vibe.write_sample_config(project_root)
            if made:
                print("已生成一份空白样例，由用户手工填：%s" % path)
        _warn_if_not_ignored(project_root)
        return EXIT_OK
    _try_all(targets, len(files))
    _warn_if_not_ignored(project_root)
    return EXIT_OK


def _try_all(targets, n_files):
    """逐个试连，让人当场知道哪个能用。targets: [(连接名, 连接, 项目根)]"""
    print()
    print("试连……")
    ok_count = 0
    for name, conn, root in targets:
        try:
            r = run_runner(conn, "ping", root, timeout=20)
        except dbconf.ConfError as e:
            print("  ✗ %s　%s" % (name, str(e).splitlines()[0]))
            continue
        if r.get("ok"):
            ok_count += 1
            print("  ✓ %s　%s %s" % (name, r.get("product"), r.get("product_version", "")[:40]))
        else:
            err = str(r.get("error", ""))
            print("  ✗ %s　%s" % (name, err[:110]))
            _hint_after_failure(conn, root, err)

    print()
    print("%d 个连通，%d 个没连上。" % (ok_count, len(targets) - ok_count))
    if n_files > 1:
        print("注意：配置分在 %d 个项目下。在哪个项目目录里开 Claude Code，"
              "用的就是哪一份。" % n_files)
    if ok_count < len(targets):
        print("没连上的多半是：库没起、地址是别的机器、或者口令在项目配置里是加密的。")
        print("要改连接配置的，告诉用户去改（文件里有口令，你不要自己打开）。")


def _init_standalone(args, project_root):
    """没装套件时：用技能自带的扫描。认环境的办法简单，所以往严里判，看不出是开发环境的不配。"""
    existing = [p for p in [vibe.existing_config(project_root)] + dbconf.configs_below(project_root)
                if p.is_file()]
    if existing and not args.force:
        for p in existing:
            print("配置已经存在：%s" % p)
        print("要重新扫描并覆盖，加 --force。")
        return EXIT_OK

    print("在 %s 下找数据库配置（只配开发环境的）……" % project_root)
    found = discover.scan(project_root)

    usable = [f for f in found if f.dialect and not f.unresolved and f.dev_only]
    not_dev = [f for f in found if f.dialect and not f.unresolved and not f.dev_only]
    skipped = [f for f in found if not f.dialect or f.unresolved]

    def tell_rest():
        if not_dev:
            print()
            print("没配进来的 %d 个：" % len(not_dev))
            for f in not_dev[:12]:
                print("  · %s（%s:%d，%s）" % (dbconf.short_url(f.url), f.source, f.line, f.why))
            print(NOT_DEV_RULE)
        if skipped:
            print()
            print("另有 %d 处用不了：" % len(skipped))
            for f in skipped[:8]:
                why = "连接串里有没展开的占位符" if f.unresolved else "不认识的数据库类型"
                print("  · %s:%d　%s　（%s）" % (f.source, f.line, dbconf.mask_url(f.url)[:70], why))

    if not usable:
        print()
        print("没找到开发环境的数据库配置。")
        tell_rest()
        if not not_dev:
            path, made = vibe.write_sample_config(project_root)
            if made:
                print("已生成一份空白样例，由用户手工填：%s" % path)
        _warn_if_not_ignored(project_root)
        return EXIT_OK

    # 按「这份配置属于哪个项目」分组：壳子套后端时，.vibe 要落在后端下面，
    # 不能落在壳子上 —— 否则下次在后端目录里开 Claude Code 就找不到了。
    groups = {}
    for f in usable:
        owner = discover.owning_project_root(f, project_root)
        groups.setdefault(str(owner), []).append(f)

    targets = []
    print()
    for owner, items in groups.items():
        text, used_here = discover.to_ini(items)
        vibe.ensure_dir(owner)
        target = vibe.existing_config(owner)
        target.write_text(text, encoding="utf-8", newline="\n")
        print("%s 里写了 %d 个连接：" % (target, len(used_here)))
        try:
            conns = dbconf._parse(target)
        except dbconf.ConfError as e:
            print("  读回配置失败：%s" % e, file=sys.stderr)
            continue
        for name, f in used_here.items():
            print("  %s %s %s" % (dljust(name, 14), dljust(_dialect_name(f.dialect), 8), dbconf.short_url(f.url)[:72]))
            print("    来自 %s:%d%s" % (f.source, f.line, "" if f.password_usable else "　[没找到能直接用的口令]"))
            if name in conns:
                targets.append((name, conns[name], owner))
    tell_rest()
    _try_all(targets, len(groups))
    _warn_if_not_ignored(project_root)
    return EXIT_OK


def _hint_after_failure(conn, project_root, err):
    """
    连不上时给一条能直接照做的下一步，而不是让人去猜。

    最常见的情况是：项目配置里的库名是开发服务器上的，本机根本没有那个库。
    这时候把这台服务器上实际有哪些库列出来，改一个词就能连上。
    """
    low = err.lower()
    wrong_db = ("unknown database" in low or "does not exist" in low
                or "不存在" in err or "invalid database" in low)
    if not wrong_db:
        if "access denied" in low or "password" in low or "口令" in err:
            print("      像是账号或者口令不对。告诉用户去改连接配置里 [%s] 那一段的 password"
                  "（文件里有口令，你不要自己打开）。" % conn["name"])
        elif "communications link" in low or "网络" in err or "connection refused" in low:
            print("      连不上这个地址。库可能没起，或者地址是别的机器。")
        return

    # 去掉连接串里的库名，再问一次这台服务器上有什么库
    probe = dict(conn)
    probe["jdbc"] = _strip_database(conn["jdbc"], conn["dialect"])
    probe["catalog"] = ""
    if probe["jdbc"] == conn["jdbc"]:
        return
    sql = {"mysql": "SHOW DATABASES",
           "kingbase": "SELECT datname FROM sys_database WHERE datistemplate = false"}.get(
        conn["dialect"])
    if not sql:
        return
    try:
        r = run_runner(probe, "query", project_root, sql_segments=[sql],
                       extra_args=["--max-rows", "50"], timeout=20)
    except dbconf.ConfError:
        return
    if not r.get("ok"):
        return
    names = [row[0] for row in r.get("rows", []) if row and row[0]]
    skip = {"information_schema", "performance_schema", "mysql", "sys"}
    names = [n for n in names if n.lower() not in skip]
    if names:
        print("      这台服务器上实际有：%s" % "、".join(names[:12]))
        print("      连接配置里 [%s] 那一段的 jdbc 串末尾的库名改对就能连上：告诉用户去改。" % conn["name"])


def _strip_database(url, dialect):
    """把 JDBC 串里的库名去掉，用来问「这台服务器上有哪些库」。"""
    if dialect == "mysql":
        return re.sub(r"(jdbc:mysql://[^/]+)/[^?]*", r"\1/", url, count=1)
    if dialect == "kingbase":
        return re.sub(r"(jdbc:kingbase8?://[^/]+)/[^?]*", r"\1/", url, count=1)
    return url


def _warn_if_not_ignored(project_root):
    if vibe.is_git_ignored(project_root) is False:
        print()
        print("⚠ %s 没有被 git 忽略。这里面有账号口令，"
              "把 .vibe/ 加进项目的 .gitignore。" % vibe.vibe_dir(project_root))


def cmd_doctor(args, project_root):
    """
    自检：把这台机器上还缺什么一次说清楚。

    拷到一台新电脑之后先跑这个 —— 比一条条命令去撞报错快得多。
    """
    ok = True

    def line(good, label, detail=""):
        nonlocal ok
        if not good:
            ok = False
        print("  %s %s%s" % ("✓" if good else "✗", label, ("　" + detail) if detail else ""))

    print("%s 自检" % SKILL)
    print()
    print("跑得起来吗")
    line(True, "Python", "%d.%d.%d" % sys.version_info[:3])

    try:
        java = dbconf.find_java(ENV)
        v = subprocess.run([java, "-version"], capture_output=True, **vibe.no_window())
        ver = (v.stderr or v.stdout).decode("utf-8", "replace").splitlines()
        line(True, "java", "%s　%s" % (ver[0].strip() if ver else "", java))
    except (dbconf.ConfError, OSError) as e:
        line(False, "java", str(e).splitlines()[0])

    cls = RUNNER_DIR / (RUNNER_CLASS + ".class")
    line(cls.is_file(), "执行器", str(cls) if cls.is_file()
         else "缺 %s，用 javac --release 8 编一次" % cls.name)

    kit = vibe.kit_dir()
    if kit is None:
        print("  · vibe-kit　没找到（技能是单独拷出来用的）：驱动要写在连接配置的 driver_jar 里，或者放进 ~/.db-crud/drivers/")
    else:
        print("  ✓ vibe-kit　%s" % kit)
        print("  · 后台执行器　%s" % ("开着（连接留着，几分钟不用自己退）" if daemon.enabled()
                                 else "关着（每条命令起一次 java；要快可以在配置页打开）"))

    print()
    print("配置")
    conns = {}
    vdir = vibe.vibe_dir(project_root)
    ignored = vibe.is_git_ignored(project_root)
    if ignored is False:
        print("  ⚠ %s 没有被 git 忽略。这里面会有账号口令，"
              "把 .vibe/ 加进项目的 .gitignore" % vdir)
    elif ignored is True:
        print("  ✓ %s 已被 git 忽略" % vdir)
    try:
        cfg_path, conns = dbconf.load(project_root, args.config)
        line(True, "连接配置", "%s，%d 个连接" % (cfg_path, len(conns)))
    except dbconf.ConfError as e:
        line(False, "连接配置", str(e).splitlines()[0])

    try:
        jd = journal.journal_root()
        jd.mkdir(parents=True, exist_ok=True)
        probe = jd / ".probe"
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
        line(True, "留痕目录可写", str(jd))
    except OSError as e:
        line(False, "留痕目录可写", str(e))

    if conns:
        print()
        print("每个连接的驱动")
        for name in sorted(conns):
            c = conns[name]
            try:
                jar, src = dbconf.find_driver_jar(c, project_root, env=ENV)
                line(True, "%s（%s）" % (name, dbconf.DIALECT_INFO[c["dialect"]]["name"]),
                     "%s：%s" % (src, os.path.basename(jar)))
            except dbconf.ConfError:
                line(False, "%s（%s）" % (name, dbconf.DIALECT_INFO[c["dialect"]]["name"]),
                     "找不到驱动 jar")
            # 口令只提醒不判失败：可以等真要用这个连接的时候再设。
            # 明文口令不提醒 —— 内网开发库本来就这么配。
            pw = c["password_raw"].strip()
            m = re.match(r"^\$\{ENV:(.+)\}$", pw)
            if m and os.environ.get(m.group(1)) is None:
                print("  ⚠ └ 口令　环境变量 %s 现在没有值（setx 之后要重开 Claude Code）" % m.group(1))

    saved = ENV.save() if ENV is not None else None
    if saved:
        print()
        print("探测结果已写入 %s，下次直接读，不用重新找。" % saved)

    print()
    if ok:
        print("都齐了。下一步：db.py --conn <名字> conn test")
    else:
        tool = dbconf.drivers_tool()
        print("上面打 ✗ 的补齐之后再用。")
        if tool:
            print("缺驱动：node \"%s\" auto（到 Maven 本地仓库里找），或者在 vibe-kit 配置页的「数据库驱动」里选。" % tool)
        print("别的怎么补，见 references/连接配置.md")
    return EXIT_OK if ok else EXIT_USAGE


def _where_line(conn):
    """这是哪台库、用的哪个账号。确认的人要看得出来 —— 光看连接名分不清开发库和别的库。"""
    return "%s　用户 %s" % (dbconf.short_url(conn["jdbc"]), conn.get("user") or "（没写）")


_SHARED_CONF = re.compile(r"(?i)^(application|bootstrap)\.(ya?ml|properties)$|^jdbc\.properties$")


def _source_line(conn):
    """
    这条连接是从哪来的（审核 P30，用户 2026-10-30 定的）：没分环境的 application.yml 照旧当开发库用，
    但确认的人要知道它不是 application-dev.yml 里写明的开发库，得自己核对地址。
    """
    src = (conn.get("source") or "").strip()
    if not src:
        return "手工配的（%s）" % (conn.get("_config_path") or "连接配置")
    base = os.path.basename(re.sub(r":\d+$", "", src.replace("\\", "/")))
    if _SHARED_CONF.match(base):
        return "%s（没分环境的公共配置，套件按开发库用：确认前核对上面的地址是不是开发库）" % src
    return src


def _show_plan(conn, stmt, rows, risk):
    print("连接    %s（%s）" % (conn["name"], dbconf.DIALECT_INFO[conn["dialect"]]["name"]))
    print("地址    %s" % _where_line(conn))
    print("来源    %s" % _source_line(conn))
    print("语句    %s" % stmt.kind)
    print("目标表  %s" % (stmt.table or "(认不出来)"))
    print("影响面  %s" % ("%d 行" % rows if rows is not None and rows >= 0 else "算不出来"))
    print("风险    %s" % risk.level)
    for r in risk.reasons:
        print("  · " + r)
    print()
    # 打的是分析过的那一条（去掉了注释和结尾的分号）：数行数、取快照、真正执行的都是它
    print("SQL：")
    for line in stmt.raw.strip().splitlines():
        print("  " + line)
    print()


def _blocked(risk):
    print("拦住了：这条语句不允许执行。", file=sys.stderr)
    for r in risk.reasons:
        print("  · " + r, file=sys.stderr)
    return EXIT_BLOCKED


def _norm_key(p):
    """和套件里 normKey 一样的写法：绝对路径、正斜杠、小写。"""
    return os.path.abspath(str(p)).replace("\\", "/").lower()


def auto_mode():
    """
    这条命令是不是在全自动模式下跑的（用户不在）。
    只认配置页打开的（state/config-seal.json 里记着）：手改 config.json 打开的不算。
    全自动模式只在走 OpenSpec 流程的会话里算数：跑命令之前套件的钩子留了一张条子（state/tool-flow.json，
    按当前目录记，两分钟内有效），条子说这个会话不在流程里（用户在），就照有人在的样子来。
    没有条子（钩子没经过：在终端里手敲的、套在脚本里跑的）按用户不在算。
    """
    cfg = vibe.kit_json("config.json", {}) or {}
    seal = vibe.kit_json("state/config-seal.json", {}) or {}
    if not (cfg.get("autoMode") is True and seal.get("autoMode") is not False):
        return False
    ticket = vibe.kit_json("state/tool-flow.json", {}) or {}
    rec = (ticket.get("byCwd") or {}).get(_norm_key(os.getcwd()))
    if isinstance(rec, dict):
        try:
            age = datetime.datetime.now().timestamp() * 1000 - float(rec.get("at") or 0)
        except (TypeError, ValueError):
            age = -1
        if 0 <= age <= 120000:
            return rec.get("auto") is True
    return True


def _auto_blocked(reasons=None):
    """全自动模式下这条写操作不执行：备份不了，或者本来就是要人拿主意的。"""
    print("拦住了：全自动模式（用户不在），这条写操作不执行。", file=sys.stderr)
    for r in (reasons or ["还原不是全自动模式下做的事：它自己不留改前快照，做了就回不去。"]):
        print("  · " + r, file=sys.stderr)
    print("全自动模式下只做留得下备份的写操作：改、删要取得全改前快照、生成得出还原脚本；新增要记得下主键；"
          "建表、建索引、加列要写得出对应的 DROP。", file=sys.stderr)
    print("在那项任务后面标「（留给用户：要改库）」，把第一步打印的影响面写进最后的交代，接着做别的。", file=sys.stderr)
    if RUN is not None:
        RUN.error("BLOCKED")
    return EXIT_BLOCKED


# ------------------------------------------------------------ 全自动模式下的写操作
#
# 用户 2026-09-30 定的：全自动模式不拦改库，条件是留得下备份 ——
#   改、删   改前快照要取全，还原脚本（undo.sql）要生成得出来：影响面数得清、不超过快照上限，
#            UPDATE 的表得有主键，表里不能有二进制列
#   新增     把表和新行的主键记下来，还原脚本是按主键一行一行删。语句里写明了主键值的直接记；
#            没写的（自增、序列）让驱动把主键带回来，带不回来就不执行
#   建表、建索引、建视图、建序列、加列   记下来，还原脚本是对应的 DROP
# 备份不了的不执行，留给用户：没有 WHERE、连表、影响面数不出来、超过快照上限、没有主键、INSERT … SELECT、
# 撞键就改的插入、改列删列、清空、删表、授权、看不懂的语句。

_LITERAL = re.compile(r"^(?:[Nn]?'(?:[^']|'')*'|[-+]?\d+(?:\.\d+)?)$")


def _split_top(raw, masked, start, end):
    """raw[start:end] 按括号最外层的逗号切开，返回每一段的原文（去了两头的空白）。"""
    out = []
    depth = 0
    at = start
    for i in range(start, end):
        ch = masked[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            out.append(raw[at:i].strip())
            at = i + 1
    out.append(raw[at:end].strip())
    return out


def _paren_end(masked, start):
    """masked[start] 是一个左括号：返回和它配对的右括号的位置，配不上返回 -1。"""
    depth = 0
    for i in range(start, len(masked)):
        if masked[i] == "(":
            depth += 1
        elif masked[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def insert_literal_ids(stmt, pk_cols, table_cols):
    """
    INSERT … VALUES 里写明了的主键值：[(值的原样写法, …), …]，一行一个。
    主键的列在语句里没出现、或者给的不是一个确定的值（序列、函数、子查询）的，返回 None。
    table_cols 是表的列（按库里的顺序）：语句没写列名单的时候按它对位置。
    """
    if stmt.kind != sqlguard.INSERT or not pk_cols:
        return None
    raw = stmt.raw
    masked = sqlguard._mask_literals(raw, stmt.dialect)
    m = re.search(r"\bINSERT\s+(?:IGNORE\s+)?INTO\s+%s" % sqlguard._QUALIFIED, masked, re.I)
    if not m:
        return None
    i = m.end()
    while i < len(masked) and masked[i].isspace():
        i += 1
    cols = None
    if i < len(masked) and masked[i] == "(":
        j = _paren_end(masked, i)
        if j < 0:
            return None
        cols = [sqlguard._clean_ident(c) for c in _split_top(raw, masked, i + 1, j)]
        i = j + 1
    v = re.compile(r"\bVALUES\b", re.I).search(masked, i)
    if not v or masked[i:v.start()].strip():
        return None                     # 列名单和 VALUES 之间还有别的（INSERT … SELECT、OVERRIDING …）：不认
    if cols is None:
        cols = [str(c) for c in (table_cols or [])]
    low = [c.lower() for c in cols]
    try:
        where = [low.index(str(p).lower()) for p in pk_cols]
    except ValueError:
        return None                     # 主键的列不在语句里：值是库里自己生成的
    out = []
    i = v.end()
    n = len(masked)
    while True:
        while i < n and masked[i].isspace():
            i += 1
        if i >= n or masked[i] != "(":
            return None
        j = _paren_end(masked, i)
        if j < 0:
            return None
        vals = _split_top(raw, masked, i + 1, j)
        if len(vals) != len(cols):
            return None
        one = tuple(vals[k] for k in where)
        if not all(_LITERAL.match(x) for x in one):
            return None
        out.append(one)
        i = j + 1
        while i < n and masked[i].isspace():
            i += 1
        if i < n and masked[i] == ",":
            i += 1
            continue
        break
    if masked[i:].strip():
        return None                     # 后面还跟着东西（RETURNING、ON CONFLICT…）
    return out or None


def _ddl_undo(stmt, dialect):
    """
    建对象、加列的还原脚本。返回 (还原的 SQL, 记下来的对象, 不行的原因)。
    只认写得出还原脚本的那几种；别的返回 (None, None, 原因)。
    """
    raw = stmt.raw
    masked = sqlguard._mask_literals(raw, dialect)
    q = sqlguard._QUALIFIED
    if stmt.kind == sqlguard.CREATE:
        if re.match(r"^\s*CREATE\s+OR\s+REPLACE\b", masked, re.I):
            return None, None, "CREATE OR REPLACE 会盖掉已有的对象，原来的样子留不下来"
        m = re.match(r"^\s*CREATE\s+((?:GLOBAL\s+|LOCAL\s+|TEMPORARY\s+|TEMP\s+|UNIQUE\s+|BITMAP\s+|CLUSTERED\s+|NONCLUSTERED\s+)*)"
                     r"(TABLE|INDEX|VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(%s)" % q, masked, re.I)
        if not m:
            return None, None, "这种 CREATE 写不出对应的还原脚本（只认建表、建索引、建视图、建序列）"
        what = m.group(2).upper()
        name = " ".join(raw[m.start(3):m.end(3)].split())
        undo = "DROP %s %s;" % (what, name)
        if what == "INDEX" and sqlguard._mysql(dialect):
            on = re.compile(r"\bON\s+(%s)" % q, re.I).search(masked, m.end(3))
            if not on:
                return None, None, "认不出这个索引建在哪张表上"
            undo = "DROP INDEX %s ON %s;" % (name, " ".join(raw[on.start(1):on.end(1)].split()))
        return undo, {"kind": what, "name": name}, None
    if stmt.kind == sqlguard.ALTER_TABLE:
        m = re.match(r"^\s*ALTER\s+TABLE\s+(%s)\s+ADD\b" % q, masked, re.I)
        if not m:
            return None, None, "改结构的语句里只有加列、加约束留得下还原脚本；改列、删列、改名的原来的样子留不下来"
        table = " ".join(raw[m.start(1):m.end(1)].split())
        rest_at = m.end()
        top = sqlguard._top_level(masked[rest_at:])
        if re.search(r"\b(DROP|MODIFY|RENAME|CHANGE|TRUNCATE|EXCHANGE)\b|\bALTER\s+COLUMN\b", top, re.I):
            return None, None, "这条语句除了加列还做了别的（删、改、改名），原来的样子留不下来"
        body_m = masked[rest_at:]
        body_r = raw[rest_at:]
        c = re.match(r"\s*CONSTRAINT\s+(%s)" % sqlguard._IDENT, body_m, re.I)
        if c:
            if re.search(r",\s*ADD\b", top, re.I):
                return None, None, "一条语句里加了好几样东西，拆成一条一条的"
            name = body_r[c.start(1):c.end(1)].strip()
            return "ALTER TABLE %s DROP CONSTRAINT %s;" % (table, name), {"kind": "CONSTRAINT", "name": name, "table": table}, None
        if re.match(r"\s*(PRIMARY|UNIQUE|FOREIGN|INDEX|KEY|CHECK|PARTITION|FULLTEXT|SPATIAL)\b", body_m, re.I):
            return None, None, "加的是没起名字的约束、索引或者分区，写不出对应的还原脚本。给它起个名字（ADD CONSTRAINT <名字> …）"
        # ADD [COLUMN] [IF NOT EXISTS] c 类型 …  或者  ADD (c1 类型, c2 类型)
        i = 0
        k = re.match(r"\s*COLUMN\b", body_m, re.I)
        if k:
            i = k.end()
        k = re.match(r"\s*IF\s+NOT\s+EXISTS\b", body_m[i:], re.I)
        if k:
            i += k.end()
        while i < len(body_m) and body_m[i].isspace():
            i += 1
        names = []
        if i < len(body_m) and body_m[i] == "(":
            j = _paren_end(body_m, i)
            if j < 0 or body_m[j + 1:].strip():
                return None, None, "加列的写法认不全"
            parts = _split_top(body_r, body_m, i + 1, j)
        else:
            parts = _split_top(body_r, body_m, i, len(body_m))
        for p in parts:
            p2 = re.sub(r"^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?", "", p, flags=re.I)
            c = re.match(r"\s*(%s)\s+\S" % sqlguard._IDENT, p2)
            if not c or re.match(r"(?i)^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|INDEX|KEY|CHECK|PARTITION)$", c.group(1)):
                return None, None, "加列的写法认不全（%s）" % " ".join(p.split())[:40]
            names.append(c.group(1))
        if not names:
            return None, None, "认不出加的是哪一列"
        undo = "\n".join("ALTER TABLE %s DROP COLUMN %s;" % (table, n) for n in names)
        return undo, {"kind": "COLUMN", "name": "、".join(names), "table": table}, None
    return None, None, "%s 这类语句留不下备份" % stmt.kind


def _table_meta(conn, project_root, stmt, args):
    """
    这张表现在的列和主键（不用本地存的：主键有没有、有没有二进制列，要以库里现在的为准）。
    返回 (表的信息, 出错的原因)。
    """
    schema = getattr(args, "schema", None) or conn.get("schema") or ""
    r = run_runner(conn, "describe", project_root,
                   extra_args=["--tables", stmt.table] + scope_args(conn, schema), timeout=args.timeout)
    if not r.get("ok"):
        return None, "看不了这张表的结构（%s）" % str(r.get("error", ""))[:120]
    t = (r.get("tables") or [None])[0]
    if not t or not t.get("found") or t.get("ambiguous"):
        return None, "找不到表 %s 的结构，或者有好几张同名的表（加 --schema 指定）" % stmt.table
    cols = t.get("columns") or {}
    ni = _col_index(cols, "COLUMN_NAME")
    ti = _col_index(cols, "DATA_TYPE")
    names = []
    types = {}
    for row in cols.get("rows", []):
        if ni is None:
            break
        name = row[ni]
        names.append(name)
        try:
            types[str(name).lower()] = int(row[ti]) if ti is not None and row[ti] is not None else 12
        except (TypeError, ValueError):
            types[str(name).lower()] = 12
    return {"names": names, "types": types, "pk": t.get("primary_keys") or []}, None


def auto_plan(args, conn, project_root, stmt, risk, rows):
    """
    全自动模式下这条写操作做不做。返回 {"ok": 行不行, "why": [不行的原因], …执行时要用的东西}。
    行的时候带着：ids（语句里写明的主键值）、key_cols（要让驱动带回来的主键列）、pk、types、undo_ddl、created。
    """
    why = []
    plan = {"ok": False, "why": why}
    k = stmt.kind
    if k == sqlguard.INSERT:
        if stmt.upsert:
            why.append("撞上键就改已有的行的插入：被改的行改之前的样子留不下来")
        elif not stmt.table:
            why.append("认不出往哪张表里插")
        elif sqlguard.estimate_insert_rows(stmt) is None:
            why.append("INSERT … SELECT 这类插多少行、插了哪些行事先定不下来，主键记不下来")
        if why:
            return plan
        meta, err = _table_meta(conn, project_root, stmt, args)
        if err:
            why.append(err)
            return plan
        if not meta["pk"]:
            why.append("表 %s 没有主键：新增的行以后定位不到，没法按主键删" % stmt.table)
            return plan
        plan.update(pk=meta["pk"], types=meta["types"])
        ids = insert_literal_ids(stmt, meta["pk"], meta["names"])
        if ids:
            plan["ids"] = ids
        else:
            plan["key_cols"] = list(meta["pk"])
        plan["ok"] = True
        return plan
    if k in (sqlguard.UPDATE, sqlguard.DELETE):
        if risk.level not in (sqlguard.SAFE, sqlguard.WARN):
            why.extend(risk.reasons)
            return plan
        n = risk.rows if risk.rows is not None else rows
        if n is None or n < 0:
            why.append("会动多少行数不出来")
            return plan
        if n > args.snapshot_max_rows:
            why.append("会动 %d 行，超过改前快照的上限 %d 行：快照取不全，还原脚本只覆盖一部分" % (n, args.snapshot_max_rows))
            return plan
        if not sqlguard.before_image_sql_for(stmt):
            why.append("改前的样子取不出来")
            return plan
        meta, err = _table_meta(conn, project_root, stmt, args)
        if err:
            why.append(err)
            return plan
        if k == sqlguard.UPDATE and not meta["pk"]:
            why.append("表 %s 没有主键：改过的行定位不到，生成不了还原脚本" % stmt.table)
            return plan
        binary = [c for c in meta["names"] if meta["types"].get(str(c).lower()) in journal._BINARY_TYPES]
        if binary:
            why.append("表 %s 有二进制列（%s）：它的值写不进还原脚本" % (stmt.table, "、".join(str(c) for c in binary[:3])))
            return plan
        plan.update(pk=meta["pk"], ok=True)
        return plan
    if k in (sqlguard.CREATE, sqlguard.ALTER_TABLE):
        undo, created, err = _ddl_undo(stmt, conn["dialect"])
        if err:
            why.append(err)
            return plan
        plan.update(undo_ddl=undo, created=created, ok=True)
        return plan
    why.extend(risk.reasons or ["%s 这类语句留不下备份" % k])
    return plan


def _limits_and_forbid(args, conn):
    """
    这一次用的禁止名单和几条线。连接配置里写的是底线，命令行上给的只能再收紧：
    禁止名单是两边合起来；几条线各取更小的那个。
    """
    limits, ignored = dbconf.tighter_limits(conn, {"warn_above": args.warn_above, "confirm_above": args.confirm_above,
                                                   "hard_limit": args.hard_limit}, sqlguard.DEFAULT_LIMITS)
    for msg in ignored:
        print("⚠ " + msg, file=sys.stderr)
    forbidden = tuple(conn.get("forbid") or ()) + tuple(
        x.strip() for x in (args.forbid or "").split(",") if x.strip())
    return limits, forbidden


def cmd_exec(args, conn, project_root):
    """
    写操作。两步走：
      第一步不带 --ack，算清影响面和风险，把要做的事摆出来，什么都不改；
      第二步带上打印出来的那串 --ack，才真的执行。

    ack 串里带着表名和影响行数，是有意的：Claude Code 的确认弹窗只显示命令行，
    SQL 在文件里它看不见，把关键信息放进 ack 串，弹窗里才看得出要动什么。

    一个确认串只能用一次：第一步给出来的时候登记，第二步用掉。同一条命令再跑一遍不会再执行一遍。
    第二步只起一次 java：行数在执行的那个事务里核对，和确认时不一样就不执行。
    """
    show_notes(conn)
    if getattr(args, "undo", None):
        return cmd_undo(args, conn, project_root)
    sql_text = read_sql(args)
    stmts = sqlguard.analyze(sql_text, conn["dialect"])
    if not stmts:
        print("这个文件里没有 SQL", file=sys.stderr)
        return EXIT_USAGE
    if len(stmts) > 1:
        print("一次只执行一条语句，这里有 %d 条。拆开分别执行，"
              "这样每一条的影响面和改前快照才是对得上的。" % len(stmts), file=sys.stderr)
        return EXIT_USAGE

    stmt = stmts[0]
    limits, forbidden = _limits_and_forbid(args, conn)

    def classify(rows):
        return sqlguard.classify(stmt, rows=rows, forbidden=forbidden,
                                 readonly=conn["readonly"], limits=limits)

    # ---- 先不带行数判一次，够禁的直接拦掉，连库都不用连 ----
    pre = classify(-1)
    if pre.blocked:
        return _blocked(pre)

    count_sql = sqlguard.count_sql_for(stmt)
    # 只要会改数据库，就必须确认，不按风险等级区分。
    # 规则简单才不会被误解：曾经按等级放行 SAFE 的写操作，结果「想先看看影响面」
    # 的那一次调用就把数据改了 —— 想预览得用 --dry-run，可没人记得住。
    needs_ack = stmt.kind != sqlguard.SELECT
    # 全自动模式（用户不在）：不等人确认，但只做留得下备份的写操作，见 auto_plan
    auto = needs_ack and auto_mode()

    # ---- 带了确认串：直接去执行，行数在事务里核对 ----
    why_not = "这个串认不出来"
    if args.ack and needs_ack and not args.dry_run:
        known, n = sqlguard.rows_in_token(args.ack)
        if known:
            risk = classify(n if n is not None else -1)
            if risk.blocked:
                return _blocked(risk)
            plan = None
            if auto:
                plan = auto_plan(args, conn, project_root, stmt, risk, n if n is not None else -1)
                if not plan["ok"]:
                    return _auto_blocked(plan["why"])
            ok, why_not = journal.pending_take(args.ack, _fingerprint(conn, stmt, risk))
            if ok:
                return _apply(args, conn, project_root, stmt, risk, n, count_sql, classify, limits, plan)

    # ---- 预扫影响面 ----
    rows = -1
    if count_sql:
        cr = run_runner(conn, "count", project_root, sql_segments=[count_sql], timeout=args.timeout)
        if cr.get("ok"):
            rows = cr.get("count", -1)
        else:
            print("⚠ 影响面算不出来（%s）。按「影响面未知」处理，判成高风险。"
                  % cr.get("error", "")[:200], file=sys.stderr)

    risk = classify(rows)
    if risk.blocked:
        return _blocked(risk)

    _show_plan(conn, stmt, risk.rows if risk.rows is not None else rows, risk)

    if args.dry_run:
        print("（--dry-run，到此为止，什么都没改）")
        return EXIT_OK

    if not needs_ack:
        print("这是查询，不是写操作。用 query 跑：db.py --conn %s query --sql \"...\"" % conn["name"])
        return EXIT_USAGE

    # 全自动模式：这条做不做现在就说清楚。备份不了的不给确认串，留给用户
    if auto:
        plan = auto_plan(args, conn, project_root, stmt, risk, risk.rows if risk.rows is not None else rows)
        if not plan["ok"]:
            return _auto_blocked(plan["why"])

    token = new_ack(conn, stmt.kind, stmt.table, risk.rows, _fingerprint(conn, stmt, risk))
    if args.ack:
        print("确认串对不上：%s。你给的是 %s。" % (why_not, args.ack), file=sys.stderr)
        print("什么都没有执行。%s，用下面这个新的串。" % ("看一遍上面的内容" if auto else "把上面的内容重新给人看一遍"), file=sys.stderr)
    if auto:
        print("全自动模式：这条留得下备份，不用等人确认。上面的影响面看过没问题，就重跑一遍并带上：")
    else:
        print("这是写操作，要确认才能执行。把上面的内容给人看过之后，重跑一遍并带上：")
    print()
    print("  --ack %s" % token)
    print()
    if auto:
        print("执行时留改前快照和还原脚本（新增的记下表和主键）。执行完把它打印的留痕目录写进最后的交代。")
    return EXIT_NEED_ACK


def _literal_of(value, jdbc_type, dialect):
    """驱动带回来的主键值写成 SQL 里的字面量。写不了（二进制）返回 None。"""
    return journal.quote_literal(value, jdbc_type, dialect)


def _insert_record(stmt, conn, plan, r, pk_cols):
    """
    新增的行记下来：表、主键列、每一行的主键值。返回 (记录, 还原的 SQL)；主键没拿到返回 (记录, None)。
    ids 里是可以直接放进 SQL 的写法（语句里原样写的，或者驱动带回来的值转成的字面量）。
    """
    table = stmt.table_sql or stmt.table
    ids = None
    source = ""
    if plan and plan.get("ids"):
        ids = [list(x) for x in plan["ids"]]
        source = "语句里写明的"
    elif r.get("inserted_keys"):
        k = r["inserted_keys"]
        types = (plan or {}).get("types") or {}
        rows = []
        for row in k.get("rows") or []:
            one = []
            for i, col in enumerate(k.get("columns") or []):
                v = row[i] if i < len(row) else None
                lit = None if v is None else _literal_of(v, types.get(str(col).lower(), 12), conn["dialect"])
                one.append(lit)
            rows.append(one)
        if rows and all(x is not None for one in rows for x in one):
            ids = rows
            source = "驱动带回来的"
    rec = {"table": stmt.table, "pk": list(pk_cols or []), "ids": ids, "source": source,
           "rows": r.get("affected_rows", -1)}
    if not ids or not pk_cols:
        return rec, None
    q = [journal.quote_name(c, conn["dialect"]) for c in pk_cols]
    lines = ["DELETE FROM %s WHERE %s;" % (table, " AND ".join("%s = %s" % (q[i], one[i]) for i in range(len(q)))) for one in ids
             if len(one) == len(q)]
    return rec, "\n".join(lines) if lines else None


def _apply(args, conn, project_root, stmt, risk, expect, count_sql, classify, limits, plan=None):
    """真的执行。确认串已经对上了、用掉了。plan 是全自动模式下 auto_plan 给的（有人在的时候是 None）。"""
    entry = journal.new_entry_dir(conn["name"], stmt.kind)
    snapshot_path = entry / "before.json"
    before_sql = sqlguard.before_image_sql_for(stmt)

    labeled = []
    extra = ["--snapshot-max-rows", str(args.snapshot_max_rows)]
    # 新增、主键不在语句里：让驱动把主键带回来，带不回来就不提交
    if plan and plan.get("key_cols"):
        extra += ["--key-columns", ",".join(str(c) for c in plan["key_cols"]), "--require-ids", "true"]
    if count_sql and expect is not None:
        labeled.append(("count", count_sql))
        extra += ["--expect-count", str(expect)]
    if before_sql:
        labeled.append(("before", before_sql))
        extra += ["--snapshot-out", str(snapshot_path)]
    # 执行的是分析过、确认过的那一条，不是文件里的原文：原文结尾的分号 Oracle 不收，
    # 原文里的注释各家认的不一样，照原文执行的可能不是确认的那一条
    labeled.append(("write", stmt.raw))
    # 硬上限在事务里再卡一次：行数数不出来的语句，执行完发现动得太多就回滚
    hard = (limits or {}).get("hard_limit")
    if hard is None:
        hard = sqlguard.DEFAULT_LIMITS["hard_limit"]
    if stmt.kind in (sqlguard.UPDATE, sqlguard.DELETE, sqlguard.INSERT):
        extra += ["--max-affected", str(hard)]
    # 主键：UPDATE 的还原脚本按主键定位；INSERT 把新行的主键记下来（方便以后删）
    want_pk = stmt.kind in (sqlguard.UPDATE, sqlguard.INSERT) and stmt.table
    if want_pk:
        bare = stmt.table.split(".")[-1]
        schema = stmt.table.split(".")[0] if "." in stmt.table else (getattr(args, "schema", None) or "")
        extra += ["--pk-table", bare] + scope_args(conn, schema)

    started = datetime.datetime.now()
    r = run_runner(conn, "apply", project_root, labeled=labeled, extra_args=extra, timeout=args.timeout)

    def drop_entry():
        try:
            for f in entry.iterdir():
                f.unlink()
            os.rmdir(str(entry))
        except OSError:
            pass

    if r.get("code") == "IDS_UNKNOWN":
        # 全自动模式：新增的行的主键拿不到。没有执行（执行了的也回滚了）
        drop_entry()
        return _auto_blocked(["新增的行的主键记不下来：%s" % str(r.get("error", ""))[:200],
                              "主键是自己定的值的话，把它直接写进语句里（写在列名单和 VALUES 里），就记得下来"])

    if r.get("code") in ("COUNT_CHANGED", "AFFECTED_MORE"):
        # 确认之后、执行之前，库里的数据变了。没有执行（执行了的也回滚了）。把现在的影响面摆出来，重新确认
        drop_entry()
        now = r.get("count", -1) if r.get("code") == "COUNT_CHANGED" else r.get("affected", -1)
        risk2 = classify(now)
        if risk2.blocked:
            return _blocked(risk2)
        if r.get("code") == "COUNT_CHANGED":
            print("★ 没有执行：确认的时候影响 %s 行，现在是 %s 行。这期间数据变了。" % (expect, now))
        else:
            print("★ 没有执行（已经回滚）：确认的是 %s 行，真执行的时候动了 %s 行。这期间数据变了。" % (expect, now))
        print()
        _show_plan(conn, stmt, now, risk2)
        if plan is not None:
            # 全自动模式：行数变了，能不能做要重新看一遍（可能超过快照上限了）
            plan2 = auto_plan(args, conn, project_root, stmt, risk2, now)
            if not plan2["ok"]:
                return _auto_blocked(plan2["why"])
            print("全自动模式：看一遍上面现在的影响面，没问题就重跑一遍并带上：")
        else:
            print("把上面的内容重新给人看过之后，重跑一遍并带上：")
        print()
        print("  --ack %s" % new_ack(conn, stmt.kind, stmt.table, risk2.rows, _fingerprint(conn, stmt, risk2)))
        print()
        return EXIT_NEED_ACK

    if r.get("code") == "OVER_LIMIT":
        drop_entry()
        print("拦住了（已经回滚，数据没有变）：这条语句实际动了 %s 行，超过硬上限 %s。"
              % (r.get("affected"), hard), file=sys.stderr)
        return EXIT_BLOCKED

    op = {
        "time": started.strftime("%Y-%m-%d %H:%M:%S"),
        "connection": conn["name"],
        "dialect": conn["dialect"],
        "kind": stmt.kind,
        "table": stmt.table,
        "sql": stmt.raw.strip(),
        "risk": risk.level,
        "risk_reasons": risk.reasons,
        "estimated_rows": risk.rows,
        "ack": args.ack,
        "before_image_sql": before_sql,
        "result": {k: v for k, v in r.items() if not k.startswith("_")},
        # 是不是全自动模式下做的（没有人确认）、在哪个项目里做的：全自动报告按这两样把它列出来
        "auto": plan is not None,
        "project": str(pathlib.Path(project_root).resolve()),
    }
    journal.write_op(entry, op)

    if not r.get("ok"):
        if r.get("code") in ("UNKNOWN_OUTCOME", "TIMEOUT"):
            # 发出去了、没等到结果：可能已经提交了。不能说"数据没有变"
            print("★ 结果不明：这条写操作交出去了，但没等到结果。可能已经执行并提交了，也可能没有。", file=sys.stderr)
            print("不要直接重跑。先查一下数据现在是什么样，告诉用户，由用户决定。", file=sys.stderr)
        else:
            print("执行失败，已经回滚，数据没有变。", file=sys.stderr)
        print("留痕在 %s" % journal.relative_to_home(entry), file=sys.stderr)
        return die(r, conn)

    affected = r.get("affected_rows", -1)
    print("执行完成，影响 %d 行，已提交。" % affected)

    # 改了结构：这张表存在本地的结构作废
    if stmt.kind in sqlguard.STRUCTURE_KINDS:
        metacache.drop(project_root, conn["name"], stmt.table)

    # ---- 生成反向 SQL（只生成，不执行）----
    snap = journal.load_snapshot(entry)
    pk_cols = r.get("primary_keys") or [] if want_pk else []
    header = ("%s 在 %s 上执行：%s\n影响 %d 行，改前快照 %d 行"
              % (op["time"], conn["name"], stmt.kind, affected,
                 (snap or {}).get("row_count", 0)))

    if stmt.kind == sqlguard.INSERT:
        # 新增：把表和新行的主键记下来，还原脚本是按主键一行一行删
        static = plan if plan is not None else {"ids": insert_literal_ids(stmt, pk_cols, None)}
        rec, undo_sql = _insert_record(stmt, conn, static, r, pk_cols or (plan or {}).get("pk") or [])
        op["inserted"] = rec
        journal.write_op(entry, op)
        notes = [] if undo_sql else ["★ 新增的行的主键没记下来（%s）：要删的话照 op.json 里那条语句的值去找"
                                     % ("表没有主键" if not rec["pk"] else "主键的值是库里自己生成的")]
        undo_path = journal.write_undo(entry, undo_sql, notes, header)
        print()
        print("留痕   %s" % journal.relative_to_home(entry))
        if rec["ids"]:
            shown = "、".join("(%s)" % ", ".join(one) if len(one) > 1 else one[0] for one in rec["ids"][:5])
            print("  新增的行  表 %s，主键 %s：%s%s（%s）"
                  % (stmt.table, "、".join(str(c) for c in rec["pk"]), shown,
                     " 等 %d 行" % len(rec["ids"]) if len(rec["ids"]) > 5 else "", rec["source"]))
            print("  还原脚本 %s（按主键把这几行删掉）" % journal.relative_to_home(undo_path))
            print("  ★ 还原脚本只生成、没有执行。要删掉这次新增的：db.py --conn %s exec --undo \"%s\"（要人确认）"
                  % (conn["name"], journal.relative_to_home(entry)))
        for n in notes:
            print("  " + n)
        return EXIT_OK

    if plan is not None and plan.get("undo_ddl"):
        # 建表、建索引、加列：还原脚本是对应的 DROP（只写出来，不执行：DROP 要人来做）
        op["created"] = plan.get("created")
        journal.write_op(entry, op)
        notes = ["★ 这是删掉刚建的对象的语句。删表、删列会连里面的数据一起删，要人看过再执行（全自动模式下不做）"]
        undo_path = journal.write_undo(entry, plan["undo_ddl"], notes, header)
        c = plan.get("created") or {}
        print()
        print("留痕   %s" % journal.relative_to_home(entry))
        print("  建了     %s %s%s" % (c.get("kind", ""), c.get("name", ""), ("（表 %s）" % c["table"]) if c.get("table") else ""))
        print("  还原脚本 %s" % journal.relative_to_home(undo_path))
        return EXIT_OK

    undo_sql, notes = journal.build_undo_sql(stmt.kind, stmt.table_sql or stmt.table, snap, pk_cols, conn["dialect"])
    undo_path = journal.write_undo(entry, undo_sql, notes, header)

    print()
    print("留痕   %s" % journal.relative_to_home(entry))
    print("  改前快照 %d 行" % (snap or {}).get("row_count", 0))
    print("  反向 SQL %s" % journal.relative_to_home(undo_path))
    for n in notes:
        print("  " + n)
    if undo_sql:
        print("  ★ 反向 SQL 只生成、没有执行。要还原：db.py --conn %s exec --undo \"%s\"（一样要人确认）"
              % (conn["name"], journal.relative_to_home(entry)))
    return EXIT_OK


# ------------------------------------------------------------ 确认串

def _fingerprint(conn, stmt, risk):
    """
    确认的是什么：哪台库、哪个账号、哪条语句、多少行、什么风险。
    任何一项变了，指纹就变，旧的确认串对不上。
    连接串和账号也在里面：同一个连接名改指到另一台库之后，之前给出的确认串不能接着用。
    """
    material = "\x00".join([
        conn["name"], conn["jdbc"], conn.get("user") or "", stmt.kind, str(stmt.table),
        stmt.raw, str(risk.rows), risk.level,
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def new_ack(conn, kind, table, rows, fingerprint):
    """
    出一个确认串并登记。前半段是人看的（动哪张表、多少行），后半段是防串改的指纹。
    指纹里掺了一个随机数：同一条语句每次第一步给出的串都不一样，用过的串不能再用。
    """
    nonce = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    digest = hashlib.sha256((fingerprint + nonce).encode("utf-8")).hexdigest()[:8]
    name = re.sub(r"[^A-Za-z0-9_-]", "_", (table or "table").split(".")[-1])[:80] or "table"
    n = "%drows" % rows if rows is not None and rows >= 0 else "rows-unknown"
    token = "%s-%s-%s-%s" % (kind, name, n, digest)
    journal.pending_put(token, fingerprint)
    return token


# ------------------------------------------------------------ 还原

def cmd_undo(args, conn, project_root):
    """
    照某一次写操作留下的 undo.sql 还原。一样两步走、一样要人确认。

    undo.sql 里是一行一条语句（删了 30 行就是 30 条 INSERT），整份在一个事务里跑：
    每一条都得正好动一行，有一条不是就全部回滚。
    """
    entry = pathlib.Path(os.path.expanduser(str(args.undo).strip().strip('"')))
    if not entry.is_dir():
        raise dbconf.ConfError("留痕目录不存在：%s" % entry)
    try:
        entry.resolve().relative_to(journal.journal_root().resolve())
    except ValueError:
        raise dbconf.ConfError("这不是留痕目录（要在 %s 下面）：%s" % (journal.journal_root(), entry))
    op = journal.load_op(entry)
    if not op:
        raise dbconf.ConfError("这个目录里没有 op.json，不知道那一次做了什么：%s" % entry)
    if op.get("connection") != conn["name"]:
        raise dbconf.ConfError("那一次是在连接 %s 上做的，现在用的是 %s。加 --conn %s"
                               % (op.get("connection"), conn["name"], op.get("connection")))
    done = journal.load_undone(entry)
    if done:
        print("这一次已经还原过了（%s）。没有再执行。" % done.get("time", "时间没记"), file=sys.stderr)
        return EXIT_BLOCKED
    if not (op.get("result") or {}).get("ok"):
        print("那一次没有执行成功，没有东西要还原。", file=sys.stderr)
        return EXIT_USAGE
    undo_file = entry / "undo.sql"
    if not undo_file.is_file():
        raise dbconf.ConfError("这个目录里没有 undo.sql：%s" % entry)
    text = undo_file.read_text(encoding="utf-8")
    stars = [ln[2:].strip() for ln in text.splitlines() if ln.startswith("-- ★")]
    stmts = sqlguard.analyze(text, conn["dialect"])
    if not stmts:
        print("这份 undo.sql 里没有可以执行的语句。原因写在它开头的注释里：", file=sys.stderr)
        for ln in text.splitlines()[:12]:
            print("  " + ln, file=sys.stderr)
        return EXIT_USAGE

    if op.get("kind") in (sqlguard.CREATE, sqlguard.ALTER_TABLE):
        print("那一次是建对象、加列，还原就是把建的东西删掉：删表、删列会连里面的数据一起删，这里不代做。", file=sys.stderr)
        print("确实要删，把 undo.sql 里的语句拿出来，用 exec --sql 一条一条执行（要人确认）：", file=sys.stderr)
        for s in stmts[:5]:
            print("  " + " ".join(s.raw.split())[:200], file=sys.stderr)
        return EXIT_USAGE

    # 删掉的插回去、改过的改回去、新增的按主键删掉
    want = {"DELETE": sqlguard.INSERT, "UPDATE": sqlguard.UPDATE, "INSERT": sqlguard.DELETE}.get(op.get("kind"))
    table = str(op.get("table") or "")
    for i, s in enumerate(stmts):
        if s.kind != want or (s.table or "").lower() != table.lower() or s.multi_table or s.upsert \
                or (want in (sqlguard.UPDATE, sqlguard.DELETE) and (not s.has_where or s.where_trivial)):
            print("拦住了：undo.sql 的第 %d 条不是还原 %s 的语句（文件被改过？）。没有执行。" % (i + 1, table),
                  file=sys.stderr)
            print("  " + " ".join(s.raw.split())[:120], file=sys.stderr)
            return EXIT_BLOCKED

    limits, forbidden = _limits_and_forbid(args, conn)
    for s in stmts:
        one = sqlguard.classify(s, rows=1, forbidden=forbidden, readonly=conn["readonly"], limits=limits)
        if one.blocked:
            return _blocked(one)
    hard = limits.get("hard_limit")
    if hard is None:
        hard = sqlguard.DEFAULT_LIMITS["hard_limit"]
    if len(stmts) >= hard:
        print("拦住了：要还原 %d 行，超过硬上限 %d。" % (len(stmts), hard), file=sys.stderr)
        return EXIT_BLOCKED

    body = "\n".join(s.raw for s in stmts)
    fp = hashlib.sha256("\x00".join([conn["name"], conn["jdbc"], conn.get("user") or "", "UNDO", table,
                                     str(entry.resolve()), body]).encode("utf-8")).hexdigest()

    if args.ack and not args.dry_run:
        if auto_mode():
            return _auto_blocked()
        ok, why_not = journal.pending_take(args.ack, fp)
        if ok:
            return _apply_undo(args, conn, project_root, entry, op, stmts)
    else:
        why_not = ""

    print("连接    %s（%s）" % (conn["name"], dbconf.DIALECT_INFO[conn["dialect"]]["name"]))
    print("地址    %s" % _where_line(conn))
    print("还原    %s 那一次 %s（%s）" % (op.get("time"), op.get("kind"), journal.relative_to_home(entry)))
    print("目标表  %s" % table)
    print("语句    %d 条 %s，一条还原一行，在一个事务里跑" % (len(stmts), want))
    print("影响面  %d 行" % len(stmts))
    print("风险    %s" % sqlguard.WARN)
    print("  · 那一次之后别人改过这些行的话，那些改动会被一起盖掉")
    print("  · 每一条都得正好动一行。有一条不是（那一行后来被删了、表里有重复的行），就全部回滚")
    print("  · 还原本身不留改前快照：还原之后想再回到还原之前的样子，做不到")
    for n in stars:
        print("  · " + n)
    print()
    print("SQL（共 %d 条，这是前 %d 条）：" % (len(stmts), min(3, len(stmts))))
    for s in stmts[:3]:
        print("  " + " ".join(s.raw.split())[:300])
    print()
    if args.dry_run:
        print("（--dry-run，到此为止，什么都没改）")
        return EXIT_OK
    token = new_ack(conn, "UNDO", table, len(stmts), fp)
    if args.ack:
        print("确认串对不上：%s。你给的是 %s。" % (why_not, args.ack), file=sys.stderr)
        print("什么都没有执行。把上面的内容重新给人看一遍，用下面这个新的串。", file=sys.stderr)
    print("这是写操作，要确认才能执行。把上面的内容给人看过之后，重跑一遍并带上：")
    print()
    print("  --ack %s" % token)
    print()
    return EXIT_NEED_ACK


def _apply_undo(args, conn, project_root, entry, op, stmts):
    started = datetime.datetime.now()
    r = run_runner(conn, "batch", project_root, labeled=[("stmt", s.raw) for s in stmts],
                   extra_args=["--expect-each", "1"], timeout=args.timeout)
    rec = {"time": started.strftime("%Y-%m-%d %H:%M:%S"), "ack": args.ack, "statements": len(stmts),
           "result": {k: v for k, v in r.items() if not k.startswith("_")}}
    if not r.get("ok"):
        journal.write_json(entry / "undo-failed.json", rec)
        if r.get("code") == "EACH_MISMATCH":
            print("没有还原（全部回滚了，数据没有变）：第 %s 条动了 %s 行，应该正好 1 行。"
                  % (r.get("index"), r.get("affected")), file=sys.stderr)
            print("多半是那一次之后这一行被删了、主键被改了，或者表里有重复的行。把这个情况告诉用户。", file=sys.stderr)
            print("  " + " ".join(stmts[max(0, int(r.get("index") or 1) - 1)].raw.split())[:200], file=sys.stderr)
            return EXIT_FAILED
        if r.get("code") in ("UNKNOWN_OUTCOME", "TIMEOUT"):
            print("★ 结果不明：还原交出去了，但没等到结果。可能已经执行并提交了，也可能没有。", file=sys.stderr)
            print("不要直接重跑。先查一下数据现在是什么样，告诉用户，由用户决定。", file=sys.stderr)
        else:
            print("还原失败，已经回滚，数据没有变。", file=sys.stderr)
        return die(r, conn)
    journal.write_json(entry / "undone.json", rec)
    print("还原完成：%d 条语句，影响 %d 行，已提交。" % (len(stmts), r.get("affected_rows", -1)))
    print("留痕   %s" % journal.relative_to_home(entry))
    return EXIT_OK


def cmd_daemon(args):
    """后台执行器：看现在留着几个、都停掉。"""
    if args.subcmd == "stop":
        n = daemon.stop_all()
        print("停了 %d 个后台执行器。" % n)
        return EXIT_OK
    items = daemon.status()
    print("后台执行器的开关：%s" % ("开着" if daemon.enabled() else "关着（在 vibe-kit 配置页打开；关着的时候每条命令起一次 java）"))
    if not items:
        print("现在没有留着的后台执行器。")
        return EXIT_OK
    for it in items:
        print("  %s 端口 %s　进程号 %s　留着 %s 条连接"
              % ("✓" if it["alive"] else "✗（已经不在了）", it["port"], it["pid"], it["connections"]))
    print("都停掉：db.py daemon stop")
    return EXIT_OK


def _print_subset(result, keep):
    """只打我们关心的那几列，DatabaseMetaData 的其余列噪音太大。"""
    idx = []
    for name in keep:
        i = _col_index(result, name)        # 大小写不敏感，金仓返回的是小写列名
        if i is not None:
            idx.append((name, i))
    if not idx:
        print_rows(result, META_WIDTH, hint=False)
        return
    sub = {
        "columns": [{"name": n} for n, _ in idx],
        "rows": [[row[i] for _, i in idx] for row in result.get("rows", [])],
        "row_count": result.get("row_count", 0),
        "truncated_rows": result.get("truncated_rows"),
        "truncated_cell": result.get("truncated_cell"),
    }
    print_rows(sub, META_WIDTH, hint=False)


def _col_index(result, name):
    """
    在结果集里按列名找下标，**大小写不敏感**。

    JDBC 规范里元数据的列标签是大写（COLUMN_NAME），达梦、Oracle、MySQL、神通
    都照办；但金仓这类 PG 系的驱动返回的是小写（column_name）。
    按大写精确匹配的话，在金仓上认不出主键，反向 SQL 会悄悄退化成拿整行当条件。
    """
    cols = [c["name"] for c in result.get("columns", [])]
    want = name.lower()
    for i, c in enumerate(cols):
        if c.lower() == want:
            return i
    return None


def _read_sql_file(path):
    p = pathlib.Path(path)
    if not p.is_file():
        raise dbconf.ConfError("SQL 文件不存在：%s" % p)
    try:
        return p.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        try:
            return p.read_text(encoding="gbk")
        except UnicodeDecodeError:
            raise dbconf.ConfError("SQL 文件不是有效的 UTF-8 或 GBK，不能替换坏字节后执行，请先修正编码")


def read_sql(args):
    """exec 用：只收一条。"""
    if args.sql_file:
        return _read_sql_file(args.sql_file)
    if args.sql:
        return command_sql(args.sql if isinstance(args.sql, str) else args.sql[0])
    raise dbconf.ConfError("要么 --sql-file，要么 --sql，总得给一条 SQL")


def read_sqls(args):
    """query 用：可以给几条。"""
    out = []
    if args.sql_file:
        out.append(_read_sql_file(args.sql_file))
    for s in (args.sql or []):
        out.append(command_sql(s))
    if not out:
        raise dbconf.ConfError("要么 --sql-file，要么 --sql，总得给一条 SQL")
    return out


def command_sql(text):
    """命令行只收 ASCII 短 SQL。中文可能在到达 Python 前丢掉；已经退化成空 LIKE 的也先停，改走文件。"""
    if not text.isascii():
        raise dbconf.ConfError("--sql 不收非 ASCII 字符：Windows 命令行可能吞掉中文。把原 SQL 写进 UTF-8 文件，用 --sql-file。")
    if re.search(r"\bLIKE\s+(?:N)?'%{1,2}'", sqlguard.strip_comments(text), re.IGNORECASE):
        raise dbconf.ConfError("--sql 的 LIKE 模式只有通配符，可能是中文丢失。核对原 SQL 后用 --sql-file；不要按当前结果判断数据。")
    return text


def argument_file(filename):
    """中文参数从 UTF-8 文件读取，避免 Windows shell 拼接实参时损坏。"""
    try:
        return pathlib.Path(filename).read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        raise dbconf.ConfError("参数文件读不到或不是 UTF-8，请核对文件路径和编码")


# ============================================================ 入口

def build_parser():
    p = argparse.ArgumentParser(prog="db.py", description="对开发库做读写")
    p.add_argument("--config", help="连接配置文件路径")
    p.add_argument("--project", help="被操作项目的根目录，用来找配置和驱动。默认当前目录")
    p.add_argument("--conn", help="用哪个连接")
    p.add_argument("--timeout", type=int, default=120, help="整条命令的超时秒数，默认 120")
    sub = p.add_subparsers(dest="cmd")

    width_help = "每格最多显示多少个字符，默认 %d；0 是不截" % DEFAULT_WIDTH

    sub.add_parser("discover", help="只看：这个项目用到了哪些数据库，配置在哪，各是哪个环境的")
    ip = sub.add_parser("init", help="扫项目里的数据库配置，把开发环境的配进来并试连")
    ip.add_argument("--force", action="store_true",
                    help="没装 vibe-kit 时：已有配置也重新扫描覆盖。装了的时候用不着（是并进去，人改过的不动）")
    sub.add_parser("doctor", help="自检：这台机器上还缺什么")

    c = sub.add_parser("conn", help="连接相关")
    csub = c.add_subparsers(dest="subcmd")
    csub.add_parser("list", help="列出配置里的连接")
    csub.add_parser("test", help="连一下试试，报数据库和驱动版本")

    t = sub.add_parser("tables", help="列出表和视图")
    t.add_argument("--schema", help="schema / 库名")
    t.add_argument("--pattern", help="表名匹配，如 T_ORDER%%")

    fd = sub.add_parser("find", help="按关键字找表和字段（表名、列名、注释里带这个词的）")
    fd.add_argument("keyword", nargs="*", help="关键字，中文英文都行；shell 无法传中文时用 --keyword-file")
    fd.add_argument("--keyword-file", help="UTF-8 文件里的查找关键字，与命令行关键字二选一")
    fd.add_argument("--schema")
    fd.add_argument("--tables-only", action="store_true", help="只找表，不找字段（库很大时快得多）")
    fd.add_argument("--limit", type=int, default=100, help="表和字段各最多列多少条")

    col = sub.add_parser("columns", help="看表的列和主键。一次可以看几张，逗号隔开")
    col.add_argument("--table", required=True, help="表名；几张表用逗号隔开")
    col.add_argument("--schema")
    col.add_argument("--fresh", action="store_true", help="不用本地存的表结构，重新到库里查")

    pk = sub.add_parser("peek", help="看看这张表里有什么（不用写 SQL）")
    pk.add_argument("--table", required=True)
    pk.add_argument("--eq-file", help="UTF-8 文件，每行一个列名=值，与 --eq 合并。适合 shell 无法传中文时")
    pk.add_argument("--schema")
    pk.add_argument("--eq", action="append", metavar="列名=值",
                    help="等值条件，值不用加引号。可以写好几个，之间是「并且」")
    pk.add_argument("--where", help="可选，WHERE 之后那一段（--eq 表达不了的条件）。只能是条件，不能有分号、注释")
    pk.add_argument("--order", help="可选，ORDER BY 之后那一段：列名，后面可以跟 ASC / DESC，几列用逗号隔开")
    pk.add_argument("--cols", help="只看这几列，逗号隔开")
    pk.add_argument("--count", action="store_true", help="只数有多少行")
    pk.add_argument("--limit", type=int, default=20)
    pk.add_argument("--width", type=int, default=None, help=width_help)

    nt = sub.add_parser("note", help="记一条这个连接的坑，下次自动带出来")
    nt.add_argument("text", nargs="*", help="要记的话；不给就只列已记的")
    nt.add_argument("--list", action="store_true", help="只列，不记")

    q = sub.add_parser("query", help="只读查询。可以一次给几条")
    q.add_argument("--sql-file", help="SQL 文件（几条查询用分号隔开）")
    q.add_argument("--sql", action="append", help="直接写一条短 SQL。可以写好几个 --sql，一次连库跑完")
    q.add_argument("--max-rows", type=int, default=200)
    q.add_argument("--width", type=int, default=None, help=width_help)
    q.add_argument("--json", action="store_true", help="原始 JSON 结果，不补齐、不按列宽截断；含 truncated_cell、truncated_rows 标记")

    e = sub.add_parser("exec", help="写操作。先看影响面，确认后才执行")
    e.add_argument("--sql-file", help="SQL 文件")
    e.add_argument("--sql", help="直接写一条短 SQL")
    e.add_argument("--undo", metavar="留痕目录",
                   help="照某一次写操作留下的 undo.sql 还原（那一次执行完打印的留痕目录）。一样两步确认")
    ack = e.add_mutually_exclusive_group()
    ack.add_argument("--ack", help="ASCII 确认串。第一次跑会打印出来给你。一个串只能用一次")
    ack.add_argument("--ack-file", help="UTF-8 文件里的一条确认串，兼容旧版中文串。照样核对影响面、指纹和一次性使用")
    e.add_argument("--schema", help="表所在的 schema，用来找主键")
    e.add_argument("--dry-run", action="store_true", help="只看影响面和风险，绝不执行")
    limit_help = "只能比连接配置里写的更严，放宽的不作数"
    e.add_argument("--forbid", default="", help="另外再禁止操作的对象，逗号分隔，支持 * 通配（连接配置里 forbid 写的照样算）")
    e.add_argument("--warn-above", type=int, default=None, help=limit_help)
    e.add_argument("--confirm-above", type=int, default=None, help=limit_help)
    e.add_argument("--hard-limit", type=int, default=None, help="影响行数的硬上限。" + limit_help)
    e.add_argument("--snapshot-max-rows", type=int, default=10000,
                   help="改前快照最多留多少行，超过就留不全，还原不回去")

    d = sub.add_parser("daemon", help="后台执行器：看状态、停掉")
    dsub = d.add_subparsers(dest="subcmd")
    dsub.add_parser("status", help="现在留着几个")
    dsub.add_parser("stop", help="都停掉")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.cmd:
        build_parser().print_help()
        return EXIT_USAGE

    project_root = args.project or os.getcwd()
    global ENV, RUN
    RUN = stats.Run(args.cmd + ((" " + args.subcmd) if getattr(args, "subcmd", None) else ""), project_root)
    # 探测缓存要和配置待在同一个 .vibe 下。配置可能在上层或子目录里
    # （壳子套后端），这时候缓存也跟过去，免得一份配置配一堆散落的缓存。
    try:
        cfg_probe, _ = dbconf.load(project_root, args.config)
        if cfg_probe.parent.name == vibe.VIBE:
            project_root = str(cfg_probe.parent.parent)
    except dbconf.ConfError:
        pass                            # 还没有配置，就用当前目录，init 会把它建起来
    ENV = vibe.Env(project_root)
    code = EXIT_USAGE
    try:
        if args.cmd == "find":
            if args.keyword_file:
                if args.keyword:
                    raise dbconf.ConfError("关键字和 --keyword-file 只能选一种")
                args.keyword = [argument_file(args.keyword_file)]
            if not args.keyword or not " ".join(args.keyword).strip():
                raise dbconf.ConfError("find 要提供关键字或 --keyword-file")
        if args.cmd == "peek" and args.eq_file:
            lines = [line.strip() for line in argument_file(args.eq_file).splitlines() if line.strip()]
            if not lines:
                raise dbconf.ConfError("--eq-file 不能是空文件，避免退化成无筛选查询")
            args.eq = (args.eq or []) + lines
        if getattr(args, "ack_file", None):
            value = argument_file(args.ack_file)
            if not value or re.search(r"\s", value) or len(value) > 1024:
                raise dbconf.ConfError("--ack-file 必须只放一条确认串，不能放多条或其他文字")
            args.ack = value
        code = _dispatch(args, project_root)
        return code
    except dbconf.ConfError as e:
        print(str(e), file=sys.stderr)
        code = EXIT_USAGE
        return code
    except Exception as e:             # 脚本自己的毛病：记下来交给改套件的人，别把调用栈糊给用户
        stats.incident("crash", "%s: %s" % (type(e).__name__, str(e)[:200]), stats.crash_detail(),
                       RUN.cmd if RUN else "", project_root)
        print("%s 自己出错了（%s：%s）。这是工具的问题，已经记下来。" % (SKILL, type(e).__name__, e), file=sys.stderr)
        code = EXIT_FAILED
        return code
    finally:
        # 这次新探到的东西存进 .vibe，下次省掉一遍查找
        if ENV is not None:
            try:
                ENV.save()
            except OSError:
                pass            # 存不下就算了，不能因为缓存写不了而让正事失败
        if RUN is not None:
            RUN.done(code)


def _dispatch(args, project_root):
    if args.cmd == "discover":
        return cmd_discover(args, project_root)
    if args.cmd == "init":
        return cmd_init(args, project_root)
    if args.cmd == "doctor":
        return cmd_doctor(args, project_root)
    if args.cmd == "daemon":
        return cmd_daemon(args)

    cfg_path, conns = dbconf.load(project_root, args.config)

    if args.cmd == "conn" and args.subcmd == "list":
        return cmd_conn_list(args, conns, cfg_path)

    global CFG_PATH
    CFG_PATH = cfg_path
    conn = dbconf.pick(conns, args.conn)

    if args.cmd == "conn" and args.subcmd == "test":
        return cmd_conn_test(args, conn, project_root)
    if args.cmd == "tables":
        return cmd_tables(args, conn, project_root)
    if args.cmd == "find":
        return cmd_find(args, conn, project_root)
    if args.cmd == "columns":
        return cmd_columns(args, conn, project_root)
    if args.cmd == "peek":
        return cmd_peek(args, conn, project_root)
    if args.cmd == "note":
        return cmd_note(args, conn, project_root)
    if args.cmd == "query":
        return cmd_query(args, conn, project_root)
    if args.cmd == "exec":
        return cmd_exec(args, conn, project_root)

    build_parser().print_help()
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
