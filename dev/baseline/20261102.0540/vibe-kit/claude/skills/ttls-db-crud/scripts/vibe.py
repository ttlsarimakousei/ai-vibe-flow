# -*- coding: utf-8 -*-
"""
vibe.py —— `<项目>/.vibe/` 目录：配置放这里，探测结果和表结构也缓存在这里。

为什么要有这个目录：

1. **一个项目可能连好几个库**（主库、历史库、报表库），配置跟着项目走才对得上。
2. **探测很慢，但结果很稳**。找 java、在 Maven 仓库里翻驱动 jar，
   每条命令都重来一遍是浪费 —— 探一次写下来，后面直接读。

目录里有什么：

    <项目>/.vibe/
    ├── db-crud.ini           连接配置：连哪些库、账号、schema、驱动
    ├── db-crud.env.json      探测缓存：java 在哪、每种方言的驱动 jar 在哪
    └── db-crud.cache.json    表结构缓存：看过的表的列和主键（columns 命令用）

**配置里会有账号口令，这个目录不能进版本库。** vibe-kit 的钩子会在 `.vibe/` 一出现时
就把它加进那个仓库的 `.gitignore`；`db.py doctor` 还会实地查一下它到底有没有被忽略，没有就提醒。

这个技能并进 vibe-kit 之前叫 urai-db-crud，配置文件叫 urai-db-crud.ini。
已经建好的配置是人一条条填出来的，不能因为改个名就让它失效：两个名字都认，
都在的话用最近改过的那一份；新建的一律叫 db-crud.ini。
"""
import datetime
import json
import os
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

VIBE = ".vibe"
CONFIG_NAME = "db-crud.ini"
CACHE_NAME = "db-crud.env.json"
META_CACHE_NAME = "db-crud.cache.json"

# 以前的名字，照样认
LEGACY_CONFIG_NAMES = ("urai-db-crud.ini",)
LEGACY_CACHE_NAMES = ("urai-db-crud.env.json",)

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent


def kit_dir():
    """
    vibe-kit 装在哪（~/.claude/vibe-kit）。驱动的登记表、开关、用量记录都在那里。

    技能装在 <用户目录>/.claude/skills/ttls-db-crud/ 下，套件就在隔壁的 vibe-kit/；
    不在那儿（单独拷出来用、在开发仓库里直接跑）就看 CLAUDE_CONFIG_DIR 和默认位置。
    找不到返回 None —— 没有套件这个技能照样能用，只是没有登记表和用量记录。
    """
    cands = [SKILL_DIR.parent.parent / "vibe-kit"]
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        cands.append(pathlib.Path(env) / "vibe-kit")
    cands.append(pathlib.Path.home() / ".claude" / "vibe-kit")
    for c in cands:
        try:
            if c.is_dir():
                return c
        except OSError:
            continue
    return None


def kit_json(name, default=None):
    """读套件目录里的一个 JSON 文件。没有套件、没有文件、读不了都返回 default。"""
    k = kit_dir()
    if k is None:
        return default
    try:
        text = (k / name).read_text(encoding="utf-8")
        if text.startswith("\ufeff"):
            text = text[1:]
        return json.loads(text)
    except (OSError, ValueError):
        return default


def vibe_dir(project_root):
    return pathlib.Path(project_root or os.getcwd()) / VIBE


def config_path(project_root):
    """要新建的时候用这个：一律写新名字。"""
    return vibe_dir(project_root) / CONFIG_NAME


def _newest(paths):
    best = None
    best_m = -1
    for p in paths:
        try:
            if not p.is_file():
                continue
            m = p.stat().st_mtime
        except OSError:
            continue
        if m > best_m:
            best, best_m = p, m
    return best


def existing_config(project_root):
    """要读的时候用这个：新旧名字都认，都在就用最近改过的那一份。都没有返回新名字的路径（给调用方报错用）。"""
    d = vibe_dir(project_root)
    hit = _newest([d / CONFIG_NAME] + [d / n for n in LEGACY_CONFIG_NAMES])
    return hit if hit is not None else d / CONFIG_NAME


def cache_path(project_root):
    d = vibe_dir(project_root)
    hit = _newest([d / CACHE_NAME] + [d / n for n in LEGACY_CACHE_NAMES])
    return hit if hit is not None else d / CACHE_NAME


def meta_cache_path(project_root):
    return vibe_dir(project_root) / META_CACHE_NAME


def ensure_dir(project_root):
    """建 .vibe 目录。返回目录路径。"""
    d = vibe_dir(project_root)
    d.mkdir(parents=True, exist_ok=True)
    return d


def is_git_ignored(project_root):
    """
    这个项目有没有把 .vibe 排除掉。

    返回 True（确实被忽略）/ False（没被忽略，配置有被提交的风险）/ None（判断不了：
    没装 git、不是 git 仓库、或者 git 调不起来）。

    用 git 自己来判断而不是去解析 .gitignore：忽略规则可以写在好几个地方
    （仓库的、全局的、.git/info/exclude），只有 git 说了算。
    """
    import subprocess
    root = pathlib.Path(project_root or os.getcwd())
    target = str(config_path(root))
    try:
        r = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", target],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           **no_window())
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode == 0:
        return True
    if r.returncode == 1:
        # 也可能这压根不是 git 仓库，那就谈不上"没被忽略"
        try:
            chk = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                                 **no_window())
        except (OSError, subprocess.SubprocessError):
            return None
        return False if chk.returncode == 0 else None
    return None


def no_window():
    """
    起子进程时带上这个，Windows 上不弹黑窗口。

    后台自动探索、配置页都会调这个技能的脚本，那时候没有控制台：
    不写的话每起一次 java、git，桌面上就闪一个窗口。
    """
    if os.name != "nt":
        return {}
    return {"creationflags": 0x08000000}        # CREATE_NO_WINDOW


class Env(object):
    """
    探测结果的缓存。读的时候先看缓存，缓存里的路径还在就直接用；
    不在了（换了机器、删了 jar、重装了 JDK）就重新探，探完写回去。
    """

    def __init__(self, project_root):
        self.project_root = project_root
        self.path = cache_path(project_root)
        self.data = {}
        self.dirty = False
        if self.path.is_file():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self.data = {}          # 缓存坏了当没有，重新探一遍就是

    # ---------------------------------------------------------------- java

    def get_java(self):
        j = self.data.get("java") or {}
        p = j.get("path")
        if p and os.path.isfile(p):
            return p
        return None

    def set_java(self, path, version=None):
        self.data["java"] = {"path": str(path), "version": version}
        self.dirty = True

    def drop_java(self):
        """缓存里的 java 用不了（太老、坏了）：去掉，下次重新找。"""
        if "java" in self.data:
            del self.data["java"]
            self.dirty = True

    # ---------------------------------------------------------------- 驱动

    def get_driver(self, dialect):
        """返回 (jar 路径, 从哪找到的)，缓存失效就返回 (None, None)。"""
        d = (self.data.get("drivers") or {}).get(dialect) or {}
        jar = d.get("jar")
        if jar and os.path.isfile(jar):
            return jar, d.get("from", "缓存")
        return None, None

    def set_driver(self, dialect, jar, source):
        self.data.setdefault("drivers", {})[dialect] = {
            "jar": str(jar), "from": source}
        self.dirty = True

    # ---------------------------------------------------------------- 落盘

    def save(self):
        if not self.dirty:
            return None
        self.data["detected_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        ensure_dir(self.project_root)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8", newline="\n")
        self.dirty = False
        return self.path

    def clear(self):
        self.data = {}
        self.dirty = True


SAMPLE_CONFIG = """; ttls-db-crud 的连接配置。
; ★ 这里面有账号口令，确认项目的 .gitignore 排除了 .vibe/ 再往里填。
;
; 一个项目可以配多个库，一个方括号一段。用 --conn <名字> 指定操作哪一个。
; 口令直接写明文就行（内网开发库一般都这么配）。
; 想更谨慎可以用 ${ENV:变量名} 或 ${FILE:路径}，但不是必须。

[main]
dialect = dm
jdbc = jdbc:dm://localhost:5236
user = SYSDBA
password = ${ENV:DM_PWD}
schema = SYSDBA

; 再来一个库就再加一段，比如历史库：
; [history]
; dialect = mysql
; jdbc = jdbc:mysql://localhost:3306/history?useUnicode=true&characterEncoding=UTF-8
; user = root
; password = ${ENV:MYSQL_PWD}
; catalog = history
;
; 生产库这样标，写操作会被脚本直接拒绝：
; readonly = true
;
; 这个连接上不许碰的表（逗号隔开，* 是通配），和影响行数的几条线。
; 写在这里的是底线：命令行上只能再收紧，不能放宽。
; forbid = SYS_*, T_AUDIT_LOG
; hard_limit = 100000
;
; 驱动在 vibe-kit 的配置页"数据库驱动"里管。这个连接要用别的版本就指路径：
; driver_jar = D:/path/to/your-driver.jar
"""


def write_sample_config(project_root):
    """写一份带注释的配置样例。已经有配置就不覆盖。"""
    ensure_dir(project_root)
    p = existing_config(project_root)
    if p.is_file():
        return p, False
    p = config_path(project_root)
    p.write_text(SAMPLE_CONFIG, encoding="utf-8", newline="\n")
    return p, True
