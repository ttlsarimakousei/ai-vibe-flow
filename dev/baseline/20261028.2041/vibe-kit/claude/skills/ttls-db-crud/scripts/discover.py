# -*- coding: utf-8 -*-
"""
discover.py —— 从被操作的项目里找数据库连接信息。只用 Python 标准库。

**装了 vibe-kit 的时候用不到这里**：扫项目、分环境由套件的 kit/lib/discover.js 做
（db.py 的 discover、init 都交给它），那一份认得全：按 profile 分段的 application.yml、
多数据源的名字、默认激活的环境、部署目录……这里是技能被单独拷出来用、没有套件时的后备，
认环境的办法简单得多，所以**往严里判**：看得出是开发环境的才算，看不出的一律不算。

扫的是这些文件：
    application*.yml / *.yaml / *.properties、bootstrap*
    jdbc.properties / db.properties / config.properties / druid.properties
    *.xml 里带 jdbc: 的（Spring、MyBatis、Druid 的数据源配置）

怎么找：先在文件里找出所有 `jdbc:xxx:...` 串，再在它所在的那一块里找账号、口令
（YAML 是同一层缩进，properties 是同一个前缀，XML 是同一个 bean）。

值怎么取：
    properties 的值取到行尾，行中间的 # 是值的一部分（口令 Dm#2023 不能截成 Dm）；
    YAML 只有"空白加 #"才是注释，带引号的按引号取；
    XML 先把 &amp; 这些还原，再取（不然连接串在第一个 &amp; 处就断了）。

什么算开发环境的（dev_only）：
    文件名、目录、profile、数据源的名字里有 dev / local / 开发 / 本地，或者连的是本机；
    而且哪里都没有测试、生产的字样。
"""
import html
import os
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dbconf                                                    # noqa: E402

# 要扫的文件名长什么样
NAME_PATTERNS = (
    re.compile(r"^application.*\.(ya?ml|properties)$", re.I),
    re.compile(r"^(jdbc|db|database|datasource|druid|config|jeecg|ruoyi)\.properties$", re.I),
    re.compile(r"^bootstrap.*\.(ya?ml|properties)$", re.I),
)
XML_PATTERN = re.compile(r".*\.xml$", re.I)          # XML 多，靠内容里有没有 jdbc: 再筛
# 这些 XML 里不会有连接，量又大：不读。pom.xml 也不读：里面的连接串写在 <profiles> 里，分不清是哪个环境的
XML_SKIP = re.compile(r"(mapper|dao|sqlmap)\.xml$|^(pom|logback|log4j2?|ehcache)([-_.][\w-]*)?\.xml$", re.I)

# 不进这些目录
SKIP_DIRS = {".git", "node_modules", "target", "build", "dist", "out", ".idea", ".vscode",
             "__pycache__", ".vibe", ".claude", "logs", "log"}

MAX_DEPTH = 6
MAX_FILE_BYTES = 512 * 1024

JDBC_RE = re.compile(r"jdbc:[a-z0-9]+:[^\s\"'<>]+", re.I)

USER_KEYS = ("username", "user", "user-name", "user_name")
PASS_KEYS = ("password", "passwd", "pwd", "pass")

XML_PROP_RE = re.compile(
    r"""name\s*=\s*["'](?P<key>[\w.\-]+)["']\s+value\s*=\s*["'](?P<val>[^"']*)["']""", re.I)
XML_ATTR_RE = re.compile(r"""(?P<key>[A-Za-z_][\w.\-]*)\s*=\s*["'](?P<val>[^"']*)["']""")

ENV_WORDS = {
    "dev": ("dev", "develop", "development", "local", "localhost", "开发", "本地"),
    "test": ("test", "testing", "uat", "sit", "qa", "pre", "preprod", "prepub", "staging", "stage", "gray",
             "测试", "预发", "灰度"),
    # product 不算：叫 product 的多半是"商品"库，不是生产环境
    "prod": ("prod", "production", "prd", "online", "release", "live", "生产", "线上", "正式"),
}
# 地址、库名里只认不会和业务词撞上的那几个：库叫 pre_order、live_room、release_note 的很多
URL_WORDS = {
    "test": ("test", "testing", "uat", "sit", "staging", "测试", "预发"),
    "prod": ("prod", "production", "prd", "online", "生产", "线上", "正式"),
}
LOCAL_HOST = re.compile(r"^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$", re.I)
WHY = {"prod": "是生产环境的配置", "test": "是测试环境的配置"}


def words_in(text, table):
    """一串文字里带不带某个环境的字样。按词看：product 里的 prod 不算，-prod、_prod、prodDataSource 才算。"""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(text or "")).lower()
    parts = [p for p in re.split(r"[^a-z0-9一-龥]+", s) if p]
    for env in ("prod", "test", "dev"):
        for w in table.get(env, ()):
            if re.search(r"[一-龥]", w):
                if w in s:
                    return env
            elif w in parts:
                return env
    return ""


def env_in_text(text):
    return words_in(text, ENV_WORDS)


def _worse(a, b):
    rank = {"prod": 3, "test": 2, "dev": 1, "": 0}
    return a if rank[a] >= rank[b] else b


def env_of_file(rel):
    """按文件名和所在目录看环境。目录只看 src 后面的那几段（前面是模块的名字）。"""
    parts = str(rel or "").replace("\\", "/").split("/")
    base = parts.pop() if parts else ""
    low = [d.lower() for d in parts]
    at = len(low) - 1 - low[::-1].index("src") if "src" in low else -1
    env = ""
    for d in (parts[at + 1:] if at >= 0 else parts):
        env = _worse(env, env_in_text(d))
    return _worse(env, env_in_text(re.sub(r"\.[^.]+$", "", base)))


def host_of_url(url):
    s = str(url or "")
    m = (re.search(r"//(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?;,\s]+)", s)
         or re.search(r"@(?://)?(\[[^\]]+\]|[^:/?;,\s(]+)", s)
         or re.search(r"HOST\s*=\s*([^)\s]+)", s, re.I))
    return m.group(1) if m else ""


class Found(object):
    def __init__(self, url, user, password, source, line, name_hint, env="", owner=""):
        self.url = url
        self.user = user
        self.password = password
        self.source = source            # 哪个文件
        self.line = line
        self.name_hint = name_hint
        self.env = env                  # 文件名、目录、profile 说的环境：prod / test / dev / ''
        self.owner = owner              # 数据源的名字（多数据源里的 master、prod 这些）

    @property
    def dialect(self):
        low = self.url.lower()
        for did, info in dbconf.DIALECT_INFO.items():
            if low.startswith(info["url_prefix"]):
                return did
        # kingbase 的前缀有 kingbase8 / kingbase 两种写法
        if low.startswith("jdbc:kingbase"):
            return "kingbase"
        if low.startswith("jdbc:postgresql"):
            return "kingbase"           # 金仓常被当成 PG 配，方言按金仓走；驱动另算（dbconf.driver_key）
        return None

    @property
    def why(self):
        """为什么不算开发环境的。算的返回空串。"""
        env = _worse(self.env, env_in_text(self.owner))
        if env in WHY:
            return WHY[env]
        host = host_of_url(self.url)
        local = bool(host and LOCAL_HOST.match(host))
        if not local:
            addr = re.sub(r"^jdbc:[a-z0-9]+:", "", re.split(r"[?;]", self.url)[0], flags=re.I)
            e = words_in(addr, URL_WORDS)
            if e:
                return "地址或库名里有%s的字样" % ("生产" if e == "prod" else "测试")
        if env == "dev" or local:
            return ""
        return "看不出是不是开发环境的配置"

    @property
    def dev_only(self):
        return not self.why

    @property
    def unresolved(self):
        """连接串里还留着没展开的占位符（${DB_HOST} 这类），填了也连不上。"""
        return "${" in self.url or "${" in (self.user or "")

    @property
    def password_usable(self):
        """口令能不能直接用：加密的（ENC(…)）、占位符没展开的不能。"""
        p = (self.password or "").strip()
        return bool(p) and "${" not in p and not re.match(r"^(ENC\(.*\)|\{cipher\})", p, re.I)


def expand(value):
    """${NAME:默认值} 按默认值展开。"""
    s = str(value or "")
    for _ in range(5):
        nxt = re.sub(r"\$\{([^{}:]+):([^{}]*)\}", lambda m: m.group(2), s)
        if nxt == s:
            break
        s = nxt
    return s


def scan(project_root, max_files=400):
    """
    扫一个项目，返回 Found 列表（已去重）。
    同一个地址、同一个账号只留一条；它在哪一处被认成不是开发环境的，就整个不算。
    """
    root = pathlib.Path(project_root)
    out = []
    seen = {}
    n = 0
    for path in _candidate_files(root):
        n += 1
        if n > max_files:
            break
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            text = _read(path)
        except OSError:
            continue
        if "jdbc:" not in text:
            continue
        text = strip_comments(text, path.suffix)        # 注释掉的旧地址不能当成配置
        if "jdbc:" not in text:
            continue
        for f in _extract(text, path, root):
            key = (f.url.lower(), (f.user or "").lower())
            had = seen.get(key)
            if had is not None:
                if had.dev_only and not f.dev_only:
                    had.env, had.owner = f.env, f.owner
                continue
            seen[key] = f
            out.append(f)
    return out


def _candidate_files(root):
    named = []
    xml = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = pathlib.Path(dirpath).relative_to(root)
        if len(rel.parts) >= MAX_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if any(p.match(fn) for p in NAME_PATTERNS):
                named.append(pathlib.Path(dirpath) / fn)
            elif XML_PATTERN.match(fn) and not XML_SKIP.search(fn):
                xml.append(pathlib.Path(dirpath) / fn)
    # 按名字认的配置文件排前面：XML 多的工程里不能让它们把名额占光
    return named + xml


def _read(path):
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="gbk", errors="replace")   # 老项目多半是 GBK


def _strip_yaml_tail(line):
    """YAML 一行后面的注释（空白加 #）去掉。引号里的 # 不算。"""
    q = ""
    for i, c in enumerate(line):
        if q:
            if c == q:
                q = ""
            continue
        if c in "\"'" and (i == 0 or line[i - 1] in " \t:[,{"):
            q = c
            continue
        if c == "#" and i > 0 and line[i - 1] in " \t":
            return line[:i].rstrip()
    return line


def strip_comments(text, suffix):
    """
    把注释里的内容抹成空格，**保留行号和行数**（报出处时要用）。

    这一步不能省。老项目的配置文件里常年躺着一堆注释掉的旧地址 ——
    比如 proxool.xml 里十几行 `<!--<driver-url>jdbc:oracle:thin:@...-->`，
    只有一行是生效的。照单全收的话会生成一堆假连接，
    而那些地址很可能是别的环境甚至生产库，连过去就是事故。
    YAML 行尾的注释也去掉；properties 只有整行的注释，值里面的 # 是值的一部分。
    """
    suffix = suffix.lower()
    if suffix == ".xml":
        out = list(text)
        i = 0
        n = len(text)
        while True:
            a = text.find("<!--", i)
            if a < 0:
                break
            b = text.find("-->", a + 4)
            b = n if b < 0 else b + 3
            for k in range(a, b):
                if out[k] != "\n":
                    out[k] = " "
            i = b
        return "".join(out)

    yaml = suffix in (".yml", ".yaml")
    lines = text.splitlines(keepends=True)
    out = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#") or (suffix == ".properties" and stripped.startswith("!")):
            # #--- 是 properties 分文档的标记，留着（后面按它分段）
            if suffix == ".properties" and re.match(r"^[#!]---\s*$", line):
                out.append(line)
            else:
                out.append(" " * (len(line) - 1) + ("\n" if line.endswith("\n") else ""))
        elif yaml:
            body = line.rstrip("\r\n")
            out.append(_strip_yaml_tail(body) + line[len(body):])
        else:
            out.append(line)
    return "".join(out)


# ------------------------------------------------------------ 拆成"键 → 值"

def _unquote(v):
    v = str(v or "").strip()
    m = re.match(r"""^(["'])(.*)\1$""", v)
    return m.group(2) if m else v


def _yaml_entries(lines):
    """每一行一项 (缩进, 键, 值, 文档号)，不是"键: 值"的行是 None。"""
    out = [None] * len(lines)
    doc = 0
    for i, l in enumerate(lines):
        if re.match(r"^---\s*$", l):
            doc += 1
            continue
        m = re.match(r"^(\s*(?:-\s+)?)([^\s:#][^:]*?)\s*:(?:\s+(.*))?$", l)
        if not m:
            continue
        out[i] = (len(m.group(1)), _unquote(m.group(2)), _unquote(m.group(3) or ""), doc)
    return out


def _props_entries(lines):
    out = [None] * len(lines)
    doc = 0
    for i, l in enumerate(lines):
        if re.match(r"^[#!]---\s*$", l):
            doc += 1
            continue
        m = re.match(r"^\s*([^\s=:#!][^\s=:]*)\s*[=:]\s*(.*?)\s*$", l)
        if not m:
            continue
        out[i] = (0, m.group(1), re.sub(r"\\([:=#!\\ ])", r"\1", m.group(2)), doc)
    return out


def _key_hit(key, keys):
    k = str(key).lower()
    return k in keys or re.split(r"[._]", k)[-1] in keys


def _doc_env(entries, doc, yaml):
    """这份文档自己写的环境：spring.profiles: prod，或者 spring.config.activate.on-profile: prod。"""
    env = ""
    stack = []
    for e in entries:
        if e is None or e[3] != doc:
            continue
        ind, key, val, _ = e
        while stack and stack[-1][0] >= ind:
            stack.pop()
        stack.append((ind, key))
        full = ".".join(k for _, k in stack).lower() if yaml else key.lower()
        if val and full in ("spring.profiles", "spring.config.activate.on-profile"):
            env = _worse(env, env_in_text(val))
    return env


def _yaml_parents(entries, idx):
    """这一行上面的各层父键，从里往外。"""
    out = []
    cur = entries[idx][0]
    doc = entries[idx][3]
    for j in range(idx - 1, -1, -1):
        e = entries[j]
        if e is None:
            continue
        if e[3] != doc:
            break
        if e[0] < cur:
            out.append((j, e))
            cur = e[0]
            if cur == 0:
                break
    return out


def _yaml_find(entries, idx, keys):
    """在连接串所在的那一块里找：先是同一层的，再往上一层。别的块里的不拿。"""
    me = entries[idx]
    parents = _yaml_parents(entries, idx)
    levels = [(me[0], parents[0][0] if parents else -1)]
    if parents:
        levels.append((parents[0][1][0], parents[1][0] if len(parents) > 1 else -1))
    for ind, top in levels:
        best = None
        j = top + 1
        while j < len(entries):
            e = entries[j]
            if e is not None:
                if e[3] != me[3] or e[0] < ind:
                    break
                if e[0] == ind and e[2] and j != idx and _key_hit(e[1], keys):
                    if best is None or abs(j - idx) < abs(best - idx):
                        best = j
            j += 1
        if best is not None:
            return entries[best][2]
    return ""


def _prefix(key):
    k = str(key)
    d = k.rfind(".")
    if d >= 0:
        return k[:d]
    u = k.rfind("_")
    return k[:u] if u > 0 else ""


def _props_find(entries, idx, keys):
    me = entries[idx]
    mine = _prefix(me[1]).lower()
    for want in (mine, _prefix(mine).lower() if mine else None):
        if want is None:
            continue
        best = None
        for j, e in enumerate(entries):
            if e is None or j == idx or e[3] != me[3] or not e[2]:
                continue
            if _key_hit(e[1], keys) and _prefix(e[1]).lower() == want:
                if best is None or abs(j - idx) < abs(best - idx):
                    best = j
        if best is not None:
            return entries[best][2]
    return ""


def _xml_block(lines, idx):
    """连接串所在的那个 bean（或者 Resource、dataSource 元素）是第几行到第几行，叫什么。"""
    start, name, tag = idx, "", ""
    for j in range(idx, max(-1, idx - 41), -1):
        if j < idx and re.search(r"</bean>", lines[j], re.I):
            break
        m = re.search(r"<(bean|Resource|dataSource|data-source|property-group)\b([^>]*)", lines[j], re.I)
        if m:
            start, tag = j, m.group(1).lower()
            n = re.search(r"""\b(?:id|name)\s*=\s*["']([^"']+)["']""", m.group(2), re.I)
            name = n.group(1) if n else ""
            break
    inner = tag in ("bean", "property-group", "")
    end = idx
    for j in range(idx, min(len(lines), idx + 40)):
        if j > idx and re.search(r"<bean\b", lines[j], re.I):
            break
        end = j
        if re.search(r"</(bean|property-group|beans)>" if inner else r"/>|</[A-Za-z-]+>", lines[j], re.I):
            break
    return start, end, name


def _xml_pick(line, keys):
    for rx in (XML_PROP_RE, XML_ATTR_RE):
        for m in rx.finditer(line):
            val = html.unescape(m.group("val").strip())
            if _key_hit(m.group("key"), keys) and val and not val.lower().startswith("jdbc:"):
                return val
    return ""


def _xml_find(lines, idx, keys):
    start, end, _ = _xml_block(lines, idx)
    for d in range(0, 41):
        for j in ([idx] if d == 0 else [idx + d, idx - d]):
            if start <= j <= end:
                v = _xml_pick(lines[j], keys)
                if v:
                    return v
    return ""


def _extract(text, path, root):
    lines = text.splitlines()
    try:
        source = str(path.relative_to(root))
    except ValueError:
        source = str(path)
    suffix = path.suffix.lower()
    file_env = env_of_file(source)

    found = []

    def add(i, url, user, password, env, owner):
        url = expand(url)
        f = Found(url, expand(user) or None, password or None, source, i + 1,
                  _name_hint(url, path), env=env, owner=owner)
        f.abspath = path                    # 算「这份配置属于哪个项目」时要用
        found.append(f)

    if suffix == ".xml":
        for i, line in enumerate(lines):
            for m in JDBC_RE.finditer(line):
                _, _, name = _xml_block(lines, i)
                add(i, html.unescape(m.group(0)), _xml_find(lines, i, USER_KEYS), _xml_find(lines, i, PASS_KEYS),
                    file_env, name)
        return found

    yaml = suffix in (".yml", ".yaml")
    entries = _yaml_entries(lines) if yaml else _props_entries(lines)
    for i, e in enumerate(entries):
        if e is None or not e[2]:
            continue
        val = expand(e[2])
        if not re.match(r"^jdbc:[a-z0-9]+:", val, re.I):
            continue
        if yaml:
            owner = " ".join(p[1][1] for p in _yaml_parents(entries, i))
            user, pw = _yaml_find(entries, i, USER_KEYS), _yaml_find(entries, i, PASS_KEYS)
        else:
            owner = _prefix(e[1])
            user, pw = _props_find(entries, i, USER_KEYS), _props_find(entries, i, PASS_KEYS)
        add(i, val, user, expand(pw), _worse(file_env, _doc_env(entries, e[3], yaml)), owner)
    return found


# 认项目根的标志。只认构建文件，不认 .git ——
# 外面套一层壳子（把前端后端装在一起的目录）常常也是个 git 仓库，
# 按 .git 找会落到壳子上，而配置其实属于里面的后端。
PROJECT_MARKERS = ("pom.xml", "build.gradle", "build.gradle.kts", "build.xml",
                   "settings.gradle", "settings.gradle.kts")


def owning_project_root(found, scan_root):
    """
    这份配置属于哪个项目。

    从配置文件所在目录往上走到扫描根，收集带构建文件的目录，取**最靠外的那个**：
    多模块工程会落到聚合根（有父 pom 的那层），而不是 xxx-admin 这种子模块。

    壳子的情况：壳子目录本身没有 pom.xml，所以往上走到它就停了，
    结果是里面那个后端项目 —— 正是我们要的。
    没有壳子时，扫描根自己就是项目根，结果不变。

    一个构建文件都找不到（纯资源目录、老项目没有 pom）就返回扫描根。
    """
    root = pathlib.Path(scan_root).resolve()
    start = pathlib.Path(getattr(found, "abspath", root)).resolve().parent
    hits = []
    cur = start
    while True:
        if any((cur / m).is_file() for m in PROJECT_MARKERS):
            hits.append(cur)
        if cur == root or root not in cur.parents:
            break
        cur = cur.parent
    return hits[-1] if hits else root


def _name_hint(url, path):
    """给这个连接起个名字：优先用 URL 里的库名，其次用文件名。"""
    m = re.search(r"jdbc:[^\s\"']*?/([A-Za-z0-9_\-]+)(\?|;|$)", url)
    if m:
        return m.group(1)
    m = re.search(r"jdbc:oracle:thin:@[^\s\"']*[:/]([A-Za-z0-9_\-]+)", url)
    if m:
        return m.group(1)
    return path.stem


def to_ini(found_list):
    """把扫到的结果拼成配置文件内容。返回 (文本, 用了哪些名字)。只该把开发环境的交进来。"""
    used = {}
    blocks = []
    for f in found_list:
        d = f.dialect
        if not d:
            continue
        base = re.sub(r"[^\w\-]", "_", (f.name_hint or d)).strip("_").lower() or d
        name = base
        k = 2
        while name in used:
            name = "%s%d" % (base, k)
            k += 1
        used[name] = f

        lines = ["[%s]" % name,
                 "dialect = %s" % d,
                 "jdbc = %s" % f.url]
        if f.user:
            lines.append("user = %s" % f.user)
        if f.password_usable:
            lines.append("password = %s" % f.password)
        else:
            lines.append("; 项目配置里没找到能直接用的口令（没写、是加密的、或者是占位符）：把明文口令填在下面")
            lines.append("password =")
        lines.append("; 来自 %s:%d" % (f.source, f.line))
        blocks.append("\n".join(lines))

    header = ("; ttls-db-crud 的连接配置，由 `db.py init` 从项目里找出来的（只配开发环境的）。\n"
              "; ★ 这里面有账号口令，确认项目的 .gitignore 排除了 .vibe/。\n"
              "; 口令是从项目配置里原样抄来的。\n")
    return header + "\n\n" + "\n\n".join(blocks) + "\n", used
