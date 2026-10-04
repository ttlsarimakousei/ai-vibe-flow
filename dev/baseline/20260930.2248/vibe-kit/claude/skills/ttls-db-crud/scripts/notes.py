# -*- coding: utf-8 -*-
"""
notes.py —— 把用这个连接时踩过的坑记进连接配置（`.vibe/db-crud.ini`），下次自动带出来。

为什么记在配置文件里而不是另起一份：坑几乎都是**跟着某个连接**走的 ——
这个库的表名要大写、那个库跑在 Oracle 兼容模式空串会变 NULL、
某个字段是加密存的。写在连接旁边，谁用这个连接谁就看得见。

存成连接段里的多行值：

    [main]
    dialect = dm
    jdbc = jdbc:dm://...
    notes =
        2026-09-23 标识符要用大写：表名按 T_ORDER 这样写，t_order 查不到
        2026-09-24 这个库跑在 Oracle 兼容模式，空串写进去会变 NULL

**改文件用文本方式，不走 configparser 回写** —— 回写会把注释全吃掉，
而自动生成的配置里「来自 xxx.yml:6」这种出处注释是有用的。

两种记法：
  人记的（`db.py note "…"`）：整句一样才算记过。
  工具自己记的（大小写）：一个连接只记一条 —— 一张表记一条的话，
    看过十张表就是十条，人记的那几条被挤到后面，再也显示不出来。
"""
import datetime
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

INDENT = "    "
_SECTION_RE = re.compile(r"^\s*\[(?P<name>[^\]]+)\]\s*([;#].*)?$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\s*")

# 工具自己记的那几种，认开头
AUTO_PREFIXES = ("标识符要用大写", "标识符要用小写")
# 以前的版本一张表记一条的，现在不记了；已经记下的照样认成"工具记的"
_OLD_AUTO_RE = re.compile(r"没有主键，改之前先想清楚怎么还原$")


def parse_notes(raw):
    """把配置里读出来的 notes 值拆成一条条。"""
    if not raw:
        return []
    return [ln.strip() for ln in str(raw).splitlines() if ln.strip()]


def body(note):
    """去掉开头的日期。"""
    return _DATE_RE.sub("", str(note or "")).strip()


def is_auto(note):
    b = body(note)
    return b.startswith(AUTO_PREFIXES) or bool(_OLD_AUTO_RE.search(b))


def add(config_path, conn_name, text, stamp=True, once=None):
    """
    给某个连接加一条。返回 (是否加了, 说明)。

    同样的话已经记过就不重复记 —— 这个功能的意义是「别再踩第二次」，
    不是攒一堆重复提醒。
    once：工具自己记的时候给，是这一类提醒的开头（"标识符要用大写"）；
          这个连接已经有这个开头的就不再记。
    """
    text = " ".join(str(text).split())
    if not text:
        return False, "空的，没记"

    p = pathlib.Path(config_path)
    try:
        content = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = p.read_text(encoding="gbk", errors="replace")
    lines = content.splitlines()

    start, end = _section_span(lines, conn_name)
    if start is None:
        return False, "配置里没有叫 %s 的连接" % conn_name

    existing = [t for t in _notes_in(lines, start, end)]
    norm = text.lower()
    for e in existing:
        # 去掉开头的日期再比，免得同一句话换个日子又记一遍
        if body(e).lower() == norm:
            return False, "这条已经记过了"
        if once and body(e).startswith(once):
            return False, "这一类已经记过了"

    entry = text
    if stamp:
        entry = "%s %s" % (datetime.date.today().isoformat(), text)

    notes_at = _notes_key_line(lines, start, end)
    if notes_at is None:
        # 这个连接还没有 notes，在段尾插一块
        insert_at = _last_nonblank(lines, start, end) + 1
        block = ["notes =", INDENT + entry]
        lines[insert_at:insert_at] = block
    else:
        # 已有 notes，追加到它最后一条后面
        tail = notes_at
        for i in range(notes_at + 1, end):
            if lines[i].startswith((" ", "\t")) and lines[i].strip():
                tail = i
            elif lines[i].strip():
                break
        lines.insert(tail + 1, INDENT + entry)

    p.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return True, entry


def _section_span(lines, name):
    """返回某个段的 [起始行, 结束行)，起始行是 [name] 那一行的下一行。"""
    start = None
    for i, ln in enumerate(lines):
        m = _SECTION_RE.match(ln)
        if not m:
            continue
        if start is None and m.group("name").strip() == name:
            start = i + 1
        elif start is not None:
            return start, i
    if start is not None:
        return start, len(lines)
    return None, None


def _notes_key_line(lines, start, end):
    for i in range(start, end):
        if re.match(r"^\s*notes\s*=", lines[i]):
            return i
    return None


def _notes_in(lines, start, end):
    at = _notes_key_line(lines, start, end)
    if at is None:
        return []
    out = []
    first = lines[at].split("=", 1)[1].strip()
    if first:
        out.append(first)
    for i in range(at + 1, end):
        ln = lines[i]
        if ln.startswith((" ", "\t")) and ln.strip():
            out.append(ln.strip())
        elif ln.strip():
            break
    return out


def _last_nonblank(lines, start, end):
    last = start - 1
    for i in range(start, end):
        if lines[i].strip():
            last = i
    return last


def ordered(notes):
    """
    显示的先后：人记的排前面，新记的排前面；工具自己记的排后面。
    同一类的工具提醒（以前一张表记一条）只留最早的一条。
    """
    human = [n for n in notes if not is_auto(n)]
    auto = []
    seen = set()
    for n in notes:
        if not is_auto(n):
            continue
        b = body(n)
        kind = next((p for p in AUTO_PREFIXES if b.startswith(p)), "没有主键")
        if kind == "没有主键":
            auto.append(n)              # 以前记下的，每张表一条，照样留着
            continue
        if kind in seen:
            continue
        seen.add(kind)
        auto.append(n)
    return list(reversed(human)) + auto


def render(notes, limit=8, conn_name="", show_all=False):
    """
    要打给人看的样子。没有就返回空串。
    每条命令开头带出来的最多 limit 条；show_all（note --list）全部列出。
    """
    if not notes:
        return ""
    items = ordered(notes)
    out = ["这个连接记过的坑："]
    shown = items if show_all else items[:limit]
    for n in shown:
        out.append("  · " + n)
    if len(items) > len(shown):
        out.append("  （还有 %d 条没显示。看全部：db.py%s note --list）"
                   % (len(items) - len(shown), (" --conn " + conn_name) if conn_name else ""))
    return "\n".join(out)
