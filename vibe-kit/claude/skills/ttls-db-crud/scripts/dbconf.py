# -*- coding: utf-8 -*-
"""
dbconf.py —— 连接配置、驱动定位、Java 定位。只用 Python 标准库。

配置用 ini 格式（configparser），因为它能写注释、人看着舒服，而且是标准库自带的。
找配置的顺序见 load()。

一份配置长这样：

    [dev-dm]
    dialect = dm
    jdbc = jdbc:dm://localhost:5236
    user = SYSDBA
    password = ${ENV:DM_PWD}
    ; driver_jar 可以不写：用 vibe-kit 配置页"数据库驱动"里登记的那个
    driver_jar = C:/path/to/DmJdbcDriver18.jar
    ; 标成生产库之后，这个连接只能读不能写
    readonly = true

口令支持三种写法：
  ${ENV:变量名}     从环境变量取
  ${FILE:路径}      从文件第一行取
  明文              直接写，内网开发库常这么用，不会因此警告
"""
import configparser
import hashlib
import os
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import notes                                                     # noqa: E402
import vibe                                                      # noqa: E402

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent

SUPPORTED_DIALECTS = ("dm", "oscar", "mysql", "oracle", "kingbase")

# 各方言的驱动 jar 文件名长什么样，以及它的 URL 前缀。
# 和 vibe-kit 的 kit/lib/drivers.js 里的 DIALECTS 对着：加一种数据库两边都要加。
DIALECT_INFO = {
    "dm": {
        "name": "达梦",
        "url_prefix": "jdbc:dm:",
        "jar_patterns": (r"dm\d*-?jdbc-?driver", r"^dm\d*\.jar$", r"dameng"),
        # 达梦 8 的驱动类；新驱动自带 SPI 声明，一般用不上
        "driver_class": "dm.jdbc.driver.DmDriver",
    },
    "oscar": {
        "name": "神通",
        "url_prefix": "jdbc:oscar:",
        "jar_patterns": (r"oscar", r"shentong"),
        "driver_class": "com.oscar.Driver",
    },
    "mysql": {
        "name": "MySQL",
        "url_prefix": "jdbc:mysql:",
        "jar_patterns": (r"mysql-connector", r"mysql.*jdbc"),
        "driver_class": None,
    },
    "oracle": {
        "name": "Oracle",
        "url_prefix": "jdbc:oracle:",
        "jar_patterns": (r"ojdbc",),
        "driver_class": None,
    },
    "kingbase": {
        "name": "人大金仓",
        "url_prefix": "jdbc:kingbase",
        "jar_patterns": (r"kingbase",),
        "driver_class": "com.kingbase8.Driver",
    },
}

# 只在找驱动的时候用的：不是一种 dialect（见 driver_key）
DRIVER_ONLY = {
    "postgresql": {
        "name": "PostgreSQL",
        "url_prefix": "jdbc:postgresql:",
        "jar_patterns": (r"postgresql", r"^pgjdbc"),
        "driver_class": None,
    },
}


class ConfError(Exception):
    """配置有问题。消息是给人看的，直接打出来就行。"""


# ============================================================ 配置文件

MAX_UP = 5          # 往上找几层
MAX_DOWN = 3        # 往下找几层
DOWN_SKIP = {".git", "node_modules", "target", "build", "dist", "out",
             ".idea", ".vscode", "__pycache__", ".claude"}


def config_candidates(project_root=None, explicit=None):
    """
    按优先级列出可能的配置文件位置（往下找的那部分另算，见 load）。

    先看当前目录，再往上找 —— 在子模块里开 Claude Code 也要能找到项目根上的配置。
    """
    out = []
    if explicit:
        out.append(pathlib.Path(explicit))
    root = pathlib.Path(project_root or os.getcwd()).resolve()
    out.append(vibe.existing_config(root))
    if (root / ".git").exists():
        return out                      # 当前目录自己就是仓库根：上面是别人的地方，不往上找
    n = 0
    for p in root.parents:
        out.append(vibe.existing_config(p))
        n += 1
        if (p / ".git").exists() or n >= MAX_UP:
            break                       # 到仓库根或够远了就停，别翻到别人的项目上
    return out


def config_fallbacks(project_root=None):
    """
    兜底位置。**必须排在「往子目录找」之后** ——
    用户级那份多半是随手配的通用连接，不该盖过项目自己的配置。
    """
    root = pathlib.Path(project_root or os.getcwd()).resolve()
    return [root / ".claude" / "urai-db-crud" / "connections.ini",     # 早期位置，仍然认
            pathlib.Path.home() / ".db-crud" / "connections.ini"]


def configs_below(project_root, max_depth=MAX_DOWN):
    """
    往下找子目录里的配置。

    外面套一层壳子（把前端后端装在一起的目录）时，配置是写在里面那个后端项目下的；
    人在壳子根上开 Claude Code，得能找到它。
    """
    root = pathlib.Path(project_root or os.getcwd()).resolve()
    hits = []
    for dirpath, dirnames, _ in os.walk(root):
        cur = pathlib.Path(dirpath)
        depth = len(cur.relative_to(root).parts)
        if depth >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in DOWN_SKIP]
        if cur == root:
            continue                    # 自己那份在 config_candidates 里已经算过
        cfg = vibe.existing_config(cur)
        if cfg.is_file():
            hits.append(cfg)
            dirnames[:] = []            # 找到就不再往这一支深挖
    return hits


def load(project_root=None, explicit=None):
    """读配置，返回 (配置文件路径, {连接名: 连接字典})。"""
    # 显式指定了 --config 就必须用它。找不到要当场报错，
    # 绝不能悄悄回退到别处的配置 —— 那会连上另一个库，而使用者以为连的是自己指定的那个。
    if explicit:
        p = pathlib.Path(os.path.expanduser(explicit))
        if not p.is_file():
            raise ConfError("--config 指定的配置文件不存在：%s" % p)
        return p, _parse(p)

    # 一、当前目录和上层
    tried = config_candidates(project_root, None)
    for path in tried:
        if path.is_file():
            return path, _parse(path)

    # 二、子目录（壳子套后端：人在壳子根上，配置在里面的后端下）
    below = configs_below(project_root)
    if len(below) == 1:
        return below[0], _parse(below[0])
    if len(below) > 1:
        raise ConfError(
            "子目录里有好几份配置，不知道该用哪个：\n  "
            + "\n  ".join(str(p) for p in below)
            + "\n用 --project 指到某个项目，或者 --config 直接指到某一份。"
        )

    # 三、兜底：老位置和用户级
    for path in config_fallbacks(project_root):
        if path.is_file():
            return path, _parse(path)

    raise ConfError(
        "找不到连接配置。跑一次 init 让它自动扫（只配开发环境的库），或者由用户手工建在这里：\n  %s\n"
        "测试、生产环境的库不要自己往里配：要查那些库，告诉用户，由用户来配。"
        % vibe.config_path(pathlib.Path(project_root or os.getcwd()).resolve())
    )


def _parse(path):
    cp = configparser.ConfigParser(interpolation=None)   # 关掉 % 插值，免得和 SQL 里的 % 打架
    try:
        # 配置文件可能是 GBK 存的，UTF-8 读不了就退回去试一次
        raw = pathlib.Path(path).read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("gbk", errors="replace")
        cp.read_string(text)
    except configparser.Error as e:
        raise ConfError("配置文件格式无法解析：%s；请在本机核对 INI 格式，原始配置不输出。" % path)

    # 旧版只写失效注释，连接仍可执行；升级首次探索前也不能继续选中。
    expired = set()
    section = ""
    for line in text.splitlines():
        m = re.match(r"\s*\[([^\]]+)\]", line)
        if m:
            section = m.group(1)
        elif "来源文件里已经找不到这个连接" in line and line.lstrip().startswith((";", "#")):
            expired.add(section)
    conns = {}
    for name in cp.sections():
        sec = cp[name]
        if not sec.getboolean("enabled", fallback=True):
            continue
        if sec.get("source") and (name in expired or sec.get("disabled_reason")):
            continue
        dialect = (sec.get("dialect") or "").strip().lower()
        if not dialect:
            raise ConfError("连接 [%s] 没写 dialect，可选：%s" % (name, "、".join(SUPPORTED_DIALECTS)))
        if dialect not in SUPPORTED_DIALECTS:
            raise ConfError("连接 [%s] 的 dialect=%s 不认识，可选：%s"
                            % (name, dialect, "、".join(SUPPORTED_DIALECTS)))
        jdbc = (sec.get("jdbc") or "").strip()
        if not jdbc:
            raise ConfError("连接 [%s] 没写 jdbc 连接串" % name)
        conns[name] = {
            "name": name,
            "_config_path": str(pathlib.Path(path).resolve()),
            "_config_stamp": hashlib.sha256(raw).hexdigest(),
            "_config_root": str(pathlib.Path(path).resolve().parent.parent if pathlib.Path(path).parent.name == ".vibe" else pathlib.Path(path).resolve().parent),
            "dialect": dialect,
            "jdbc": jdbc,
            "user": (sec.get("user") or "").strip(),
            "password_raw": sec.get("password") or "",
            "driver_jar": (sec.get("driver_jar") or "").strip(),
            "driver_class": (sec.get("driver_class") or "").strip(),
            "readonly": sec.getboolean("readonly", fallback=False),
            "schema": (sec.get("schema") or "").strip(),
            "catalog": (sec.get("catalog") or "").strip(),
            "notes": notes.parse_notes(sec.get("notes")),
            # 后台自动探索写的：这个连接是从项目的哪个配置文件里找到的
            "source": (sec.get("source") or "").strip(),
            # 这个连接上不许碰的对象、影响行数的几条线。写在配置里的是底线：命令行上只能再收紧，不能放宽
            "forbid": tuple(x.strip() for x in re.split(r"[,，\n]", sec.get("forbid") or "") if x.strip()),
            "limits": {k: _int_or_none(name, k, sec.get(k)) for k in LIMIT_KEYS},
        }
    if not conns:
        raise ConfError("配置文件 %s 里一个连接都没有" % path)
    return conns


LIMIT_KEYS = ("warn_above", "confirm_above", "hard_limit")


def _int_or_none(conn_name, key, raw):
    s = (raw or "").strip().replace(",", "").replace("_", "")
    if not s:
        return None
    try:
        n = int(s)
    except ValueError:
        raise ConfError("连接 [%s] 的 %s 要写整数，现在是：%s" % (conn_name, key, raw.strip()))
    if n < 0:
        raise ConfError("连接 [%s] 的 %s 不能是负数" % (conn_name, key))
    return n


def tighter_limits(conn, cli, defaults):
    """
    影响行数的几条线。底线是连接配置里写的，配置里没写的用默认值（defaults）；
    命令行上给的只能比底线更严（更小），给得更宽的不作数 ——
    不然跑命令的人（模型）加一个参数就把上限放开了。要放宽，由人去改连接配置。
    返回 (几条线, [没作数的说明…])。
    """
    out = {}
    ignored = []
    base = conn.get("limits") or {}
    for k in LIMIT_KEYS:
        a = base.get(k)
        where = "连接配置里的"
        if a is None:
            a = defaults[k]
            where = "默认的"
        b = (cli or {}).get(k)
        if b is None or b < 0:
            out[k] = a
            continue
        out[k] = min(a, b)
        if b > a:
            ignored.append("--%s %d 比%s %d 宽，不作数，按 %d 算。要放宽得由用户去改连接配置里这个连接的 %s"
                           % (k.replace("_", "-"), b, where, a, a, k))
    return out, ignored


def mask_url(url):
    """
    给人看、给模型看的连接串：串里带的账号口令遮掉
    （//用户:口令@、Oracle 的 用户/口令@、password=）。和 kit/lib/discover.js 的 maskUrl 是同一套。
    """
    s = str(url or "")
    s = re.sub(r"(//[^:/\s@]+:)[^@\s/]+@", r"\1***@", s, count=1)
    s = re.sub(r"(jdbc:oracle:[a-z]+:[^/@\s]+/)[^@\s]+@", r"\1***@", s, count=1, flags=re.I)
    s = re.sub(r"([?&;](?:password|passwd|pwd)=)[^&;]*", r"\1***", s, flags=re.I)
    return s


def short_url(url):
    """连接串里的主机和库：遮掉口令，去掉参数。确认写操作的时候给人看的就是它。"""
    return re.sub(r"[?;].*$", "", mask_url(url))


def driver_key(conn):
    """
    这个连接要哪种驱动。和 dialect 只差一处：连接串写成 jdbc:postgresql 的（金仓常这么配）
    要 PostgreSQL 的驱动，金仓的驱动不认这个前缀；SQL 的写法仍按金仓走。
    """
    if str(conn.get("jdbc") or "").lower().startswith("jdbc:postgresql"):
        return "postgresql"
    return conn["dialect"]


def driver_info(conn):
    k = driver_key(conn)
    return DRIVER_ONLY.get(k) or DIALECT_INFO[k]


def pick(conns, name):
    if not name:
        if len(conns) == 1:
            return list(conns.values())[0]
        raise ConfError("配置里有 %d 个连接，必须用 --conn 指名道姓：%s"
                        % (len(conns), "、".join(sorted(conns))))
    if name not in conns:
        raise ConfError("没有叫 %s 的连接。配置里有：%s" % (name, "、".join(sorted(conns))))
    return conns[name]


# ============================================================ 口令

_PLACEHOLDER = re.compile(r"^\$\{(ENV|FILE):(.+)\}$")


def resolve_password(conn):
    """
    把口令占位符解析成真值，返回口令。

    **明文口令是受支持的写法，不会因此警告。** 这个工具面向内网开发库，
    连接信息本来就躺在项目的 application.yml 里；为此每条命令唠叨一遍
    只会让人烦到忽略所有提示，那才是真的降低安全。
    想更稳妥的可以用 ${ENV:变量名} / ${FILE:路径}，但不是必须。

    口令解析出来之后只会经由子进程的环境变量（或者本机的后台执行器）交给 Java，
    不进命令行、不打印、不写日志 —— 命令行会进进程列表和对话记录。
    """
    raw = (conn.get("password_raw") or "").strip()
    if not raw:
        return ""

    m = _PLACEHOLDER.match(raw)
    if not m:
        return raw                      # 明文，照用

    kind, value = m.group(1), m.group(2).strip()
    if kind == "ENV":
        got = os.environ.get(value)
        if got is None:
            raise ConfError(
                "连接 [%s] 的口令要从环境变量 %s 取，但这个变量没有值。\n"
                "注意：用 setx 设过之后，得重开 Claude Code 才读得到。\n"
                "嫌麻烦的话，直接把口令明文写进配置里也行。" % (conn["name"], value)
            )
        return got
    # FILE
    p = pathlib.Path(os.path.expanduser(value))
    if not p.is_file():
        raise ConfError("连接 [%s] 的口令文件不存在：%s" % (conn["name"], p))
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = p.read_text(encoding="gbk", errors="replace")
    first = text.splitlines()[0] if text.splitlines() else ""
    if not first.strip():
        raise ConfError("口令文件 %s 第一行是空的" % p)
    return first.strip()


# ============================================================ 找 Java

def _kit_jdks():
    """vibe-kit 配置页"本机环境"里配的 JDK，默认的那个排最前。返回 java 可执行文件的路径列表。"""
    local = vibe.kit_json("local.json", {}) or {}
    jdks = [j for j in (local.get("jdks") or []) if isinstance(j, dict) and j.get("path")]
    default = str(local.get("defaultJdk") or "")
    jdks.sort(key=lambda j: 0 if str(j.get("name")) == default else 1)
    exe = "java.exe" if os.name == "nt" else "java"
    return [str(pathlib.Path(j["path"]) / "bin" / exe) for j in jdks]


def find_java(env=None):
    """
    找一个能用的 java。顺序：DBCRUD_JAVA → 配置页"本机环境"里的 JDK → 探测缓存 → JAVA_HOME → PATH。
    只要求能跑 class 文件，JDK 8 以上都行，不需要 javac。

    人明说的（环境变量、配置页）排在缓存前面：第一次探到的是个太老的 java 时，
    在配置页配一个新的就改得过来，不会一直用缓存里那个。
    """
    cand = []
    env_java = os.environ.get("DBCRUD_JAVA")
    if env_java:
        cand.append(env_java)
    cand.extend(_kit_jdks())
    if env is not None:
        cached = env.get_java()
        if cached:
            cand.append(cached)
    java_home = os.environ.get("JAVA_HOME")
    if java_home:
        exe = "java.exe" if os.name == "nt" else "java"
        cand.append(str(pathlib.Path(java_home) / "bin" / exe))
    cand.append("java")

    import shutil
    for c in cand:
        has_dir = (os.sep in c) or ("/" in c)
        found = (c if os.path.isfile(c) else None) if has_dir else shutil.which(c)
        if found:
            if env is not None and env.get_java() != found:
                env.set_java(found)
            return found
    raise ConfError(
        "机器上找不到 java。这个技能靠 JDBC 连数据库，必须有 JDK 或 JRE（8 以上都行）。\n"
        "在 vibe-kit 配置页的「本机环境」里配一个 JDK，或者把 java 放进 PATH，"
        "或者设环境变量 DBCRUD_JAVA 指到 java.exe。"
    )


# ============================================================ 找驱动 jar

def project_driver_versions(project_root, patterns):
    """只看当前项目及其本地父 pom，不借用兄弟项目的版本，也不连接数据库。"""
    if not project_root:
        return set()
    p = pathlib.Path(project_root) / "pom.xml"
    docs = []
    seen = set()
    for _ in range(6):
        if not p.is_file() or str(p.resolve()) in seen:
            break
        seen.add(str(p.resolve()))
        try:
            root = ET.parse(p).getroot()
        except (ET.ParseError, OSError):
            break
        for e in root.iter():
            e.tag = e.tag.split("}")[-1]
        docs.append(root)
        parent = root.find("parent")
        if parent is None:
            break
        rel = parent.find("relativePath")
        if rel is not None and not (rel.text or "").strip():
            break
        p = p.parent / ((rel.text or "").strip() if rel is not None else "../pom.xml")
    props = {}
    for root in reversed(docs):
        props.update({e.tag: (e.text or "").strip() for e in root.findall("properties/*")})
    def resolve(v):
        for _ in range(6):
            nv = re.sub(r"\$\{([^}]+)\}", lambda m: props.get(m[1], m[0]), v)
            if nv == v:
                break
            v = nv
        return v if chr(36) + "{" not in v else ""
    managed = {}
    for root in reversed(docs):
        for d in root.findall("dependencyManagement/dependencies/dependency"):
            managed[d.findtext("artifactId", "")] = resolve(d.findtext("version", ""))
    direct = {}
    for root in reversed(docs):
        for d in root.findall("dependencies/dependency"):
            artifact = resolve(d.findtext("artifactId", ""))
            if not any(re.search(x, artifact + ".jar", re.I) for x in patterns):
                continue
            version = resolve(d.findtext("version", "")) or managed.get(artifact, "")
            group = resolve(d.findtext("groupId", ""))
            direct[(group, artifact)] = version
    if any(not v for v in direct.values()):
        raise ConfError("项目声明了驱动依赖，但版本需要外部 BOM、profile 或未解析的属性。请在连接里明确写 driver_jar，不拿默认版本代替。")
    return set(direct.values())


def registry_driver(key, project_root=None):
    """
    vibe-kit 的驱动登记表（~/.claude/vibe-kit/drivers.json）里这种数据库用哪个 jar。
    在配置页"数据库驱动"里登记，或者用 tools/drivers.js。没登记、文件不在了返回 None。
    key 是 driver_key() 给的：一般就是 dialect，jdbc:postgresql 的连接是 postgresql。
    """
    reg = vibe.kit_json("drivers.json", {}) or {}
    d = (reg.get("drivers") or {}).get(key) or {}
    info = DRIVER_ONLY.get(key) or DIALECT_INFO.get(key, {})
    wanted = project_driver_versions(project_root, info.get("jar_patterns", ()))
    versions = d.get("versions") or ([d] if d.get("jar") else [])
    if len(wanted) > 1:
        raise ConfError("项目声明了多个%s驱动版本，不能猜用哪一个；在连接里明确写 driver_jar。" % key)
    if wanted:
        version = next(iter(wanted))
        hit = [x for x in versions if x.get("version") == version and os.path.isfile(x.get("jar", ""))]
        if not hit:
            raise ConfError("项目声明的%s驱动版本%s还没有登记。请添加该版本，不能拿另一个版本代替。" % (key, version))
        if len({x["jar"] for x in hit}) > 1:
            raise ConfError("同一版本有多个驱动文件，在连接里明确写 driver_jar。")
        return hit[0]["jar"]
    jar = d.get("jar")
    if jar and os.path.isfile(jar):
        return jar
    return None


def drivers_tool():
    """套件里管驱动的命令行工具。没装套件返回 None。"""
    k = vibe.kit_dir()
    if k is None:
        return None
    t = k / "tools" / "drivers.js"
    return t if t.is_file() else None


def driver_project_root(conn, project_root):
    """壳子里选某个连接时，从它的配置来源找到所属子项目，不扫描兄弟项目。"""
    owner = pathlib.Path(conn.get("_config_root") or project_root or os.getcwd()).resolve()
    source = conn.get("source") or ""
    if source:
        file = (owner / source).resolve()
        if file.is_file() and (file == owner or owner in file.parents):
            for parent in file.parents:
                if (parent / "pom.xml").is_file():
                    return str(parent)
                if parent == owner:
                    break
    return project_root


def find_driver_jar(conn, project_root=None, extra_dirs=(), env=None):
    """
    按方言找 JDBC 驱动 jar。顺序：
      1. 配置里显式写的 driver_jar
      2. 被操作项目自己的 lib/、WEB-INF/lib/（版本和它连的库最匹配）
      3. vibe-kit 的驱动登记表（配置页"数据库驱动"里选的）
      4. ~/.db-crud/drivers/、套件的驱动目录、本机的 Maven 仓库
    返回 (jar 路径, 从哪找到的说明)。找不到就抛 ConfError，并把找过的地方说清楚。

    驱动不随技能带：达梦、神通、金仓、Oracle 的驱动是厂商的，只限内部使用。
    """
    explicit = conn.get("driver_jar")
    if explicit:
        p = pathlib.Path(os.path.expanduser(explicit))
        if not p.is_file():
            raise ConfError("配置里写的 driver_jar 不存在：%s" % p)
        return str(p), "配置里指定的"

    key = driver_key(conn)
    info = driver_info(conn)
    patterns = info["jar_patterns"]
    if isinstance(patterns, str):
        patterns = (patterns,)
    regexes = [re.compile(p, re.I) for p in patterns]

    project_root = driver_project_root(conn, project_root)
    wanted = project_driver_versions(project_root, patterns)
    if len(wanted) > 1:
        raise ConfError("项目声明了多个驱动版本，在连接里明确写 driver_jar。")
    version = next(iter(wanted)) if wanted else None
    searched = []
    # 项目自己的驱动排最前：它的版本和项目实际连的库对得上。这一步只看两三个目录，很快，不走缓存
    for base, label in _project_dirs(project_root, extra_dirs):
        searched.append(str(base))
        hit = _scan_for_jar(base, regexes, max_depth=2, version=version, unique=True)
        if hit:
            return hit, label

    reg = registry_driver(key, project_root)
    if reg:
        return reg, "配置页里登记的"
    k = vibe.kit_dir()
    if k is not None:
        searched.append(str(k / "drivers.json") + "（登记表）")

    # 下面这些要翻目录，慢：探到一次就记进缓存
    if env is not None:
        jar, src = env.get_driver(key)
        if jar:
            return jar, src
    for base, label in _fallback_dirs():
        searched.append(str(base))
        hit = _scan_for_jar(base, regexes)
        if hit:
            if env is not None:
                env.set_driver(key, hit, label)
            return hit, label

    tool = drivers_tool()
    how = ("三选一：\n"
           "  · 让它到 Maven 本地仓库里找并登记：node \"%s\" auto --only %s\n"
           "  · 手上有 jar：node \"%s\" use <jar 的路径>（也可以在 vibe-kit 配置页的「数据库驱动」里选）\n"
           "  · 只给这一个连接用：把 jar 的路径写进配置的 driver_jar"
           % (tool, key, tool)) if tool else (
        "二选一：把驱动 jar 的路径写进配置的 driver_jar，或者把 jar 放进 ~/.db-crud/drivers/。")
    raise ConfError(
        "找不到%s的 JDBC 驱动 jar。找过这些地方：\n  %s\n%s"
        % (info["name"], "\n  ".join(searched), how)
    )


def _project_dirs(project_root, extra_dirs):
    out = []
    for d in extra_dirs:
        out.append((pathlib.Path(d), "额外指定的目录"))
    if project_root:
        root = pathlib.Path(project_root)
        out.append((root / "lib", "项目的 lib/"))
        out.append((root / "src" / "main" / "webapp" / "WEB-INF" / "lib", "项目的 WEB-INF/lib/"))
        out.append((root / "WEB-INF" / "lib", "项目的 WEB-INF/lib/"))
        out.append((root / "WebRoot" / "WEB-INF" / "lib", "项目的 WEB-INF/lib/"))
        out.append((root / "WebContent" / "WEB-INF" / "lib", "项目的 WEB-INF/lib/"))
    return [(p, label) for p, label in out if p.is_dir()]


def maven_repos():
    """
    这台电脑上的 Maven 本地仓库。先看 vibe-kit 配置页"本机环境"里配的每一套 Maven，
    再看默认的 ~/.m2/repository。
    """
    out = []

    def add(p, label):
        if not p:
            return
        path = pathlib.Path(os.path.expanduser(str(p)))
        if path.is_dir() and all(str(path).lower() != str(x).lower() for x, _ in out):
            out.append((path, label))

    local = vibe.kit_json("local.json", {}) or {}
    mavens = [m for m in (local.get("mavens") or []) if isinstance(m, dict)]
    if not mavens and isinstance(local.get("maven"), dict):
        mavens = [local["maven"]]
    for m in mavens:
        if m.get("repo"):
            add(m["repo"], "本机环境里配的 Maven 仓库")
        elif m.get("settings"):
            add(_repo_of_settings(m["settings"]), "本机环境里配的 Maven 仓库")
    add(_repo_of_settings(pathlib.Path.home() / ".m2" / "settings.xml"), "本机 Maven 仓库")
    add(pathlib.Path.home() / ".m2" / "repository", "本机 Maven 仓库")
    return out


def _repo_of_settings(settings):
    try:
        text = pathlib.Path(settings).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    m = re.search(r"<localRepository>\s*([^<]+?)\s*</localRepository>", text)
    if not m:
        return None
    return m.group(1).replace("${user.home}", str(pathlib.Path.home()))


def _fallback_dirs():
    out = []
    # 用户自己的驱动库（并进 vibe-kit 之前就有的位置，照样认）
    out.append((pathlib.Path.home() / ".db-crud" / "drivers", "~/.db-crud/drivers/"))
    k = vibe.kit_dir()
    if k is not None:
        out.append((k / "drivers", "vibe-kit 的驱动目录"))
    out.extend(maven_repos())
    return [(p, label) for p, label in out if p.is_dir()]


def _scan_for_jar(base, regexes, max_depth=8, version=None, unique=False):
    """
    在一个目录下找匹配的 jar。Maven 仓库很深，限制递归层数免得扫穿整个磁盘。
    有声明版本只匹配该版本；项目目录多个文件时要求明确选，不按文件名猜新旧。
    没有项目版本要求的公共回退目录保留原来的排序选择。
    """
    hits = []
    base_depth = len(base.parts)
    for dirpath, dirnames, filenames in os.walk(base):
        if len(pathlib.Path(dirpath).parts) - base_depth >= max_depth:
            dirnames[:] = []
            continue
        for fn in filenames:
            if not fn.lower().endswith(".jar"):
                continue
            if fn.lower().endswith("-sources.jar") or fn.lower().endswith("-javadoc.jar"):
                continue
            for rx in regexes:
                if rx.search(fn):
                    file = os.path.join(dirpath, fn)
                    matched = not version or bool(re.search(r"(?<![\w.])" + re.escape(version) + r"(?=\.jar$|[-_])", fn, re.I))
                    if version and not matched:
                        try:
                            with zipfile.ZipFile(file) as z:
                                info = z.getinfo("META-INF/MANIFEST.MF")
                                if info.file_size <= 65536:
                                    manifest = z.read(info).decode("utf-8", errors="replace")
                                    matched = bool(re.search(r"^Implementation-Version:\s*" + re.escape(version) + r"\s*$", manifest, re.M))
                        except (OSError, KeyError, zipfile.BadZipFile):
                            pass
                    if matched:
                        hits.append(file)
                    break
    if not hits:
        return None
    if unique and len(hits) > 1:
        raise ConfError("项目目录有多个匹配的驱动文件，在连接里明确写 driver_jar。")
    # 按文件名里的数字比：以前按字典序，8.1.3.62 排在 8.1.3.140 后面，被当成更新的那个（审核 P33）
    hits.sort(key=_natural_key)
    return hits[-1]


def _natural_key(p):
    """文件名按"数字当数字、文字当文字"比的键；数字和文字分开标记，不同文件名之间也比得了"""
    name = re.split(r"[\\/]", str(p))[-1]
    return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in re.split(r"(\d+)", name) if x != ""], str(p)
