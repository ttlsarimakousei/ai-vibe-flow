# -*- coding: utf-8 -*-
"""
stats.py —— 记用量和工具自己出的毛病，给 vibe-kit 收。只用 Python 标准库。

记在 ~/.claude/vibe-kit/state/tool-usage.jsonl，一行一条。vibe-kit 的钩子和配置页会来读：
  · 用量：哪条命令跑了多少次、多慢、哪种错多 —— 导出的问题汇总里有一张表
  · 毛病：工具自己崩了、执行器没有输出、找不到驱动、找不到 java —— 自动记成一条问题反馈

**只记工具的事，不记数据。** SQL 原文、查出来的内容、连接串、账号、口令一概不记。
数据库报的错只记类别（SQLSTATE、厂商错误码），不记原话 —— 原话里会带表名和数据。

没装 vibe-kit（技能单独拷出来用）就什么都不记。记不上不影响正事。
"""
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vibe                                                      # noqa: E402

TOOL = "ttls-db-crud"
LOG_NAME = "tool-usage.jsonl"
MAX_BYTES = 2 * 1024 * 1024         # 到这么大就把前一半丢掉


def _log_path():
    k = vibe.kit_dir()
    if k is None:
        return None
    return k / "state" / LOG_NAME


def _append(rec):
    p = _log_path()
    if p is None:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            if p.stat().st_size > MAX_BYTES:
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
                p.write_text("\n".join(lines[len(lines) // 2:]) + "\n", encoding="utf-8", newline="\n")
        except OSError:
            pass
        line = json.dumps(rec, ensure_ascii=False)
        # 一次 write 写一整行：几个进程同时追加也不会写花
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
    except (OSError, ValueError):
        pass


class Run(object):
    """一次命令的用量。用完调 done()。"""

    def __init__(self, cmd, project=""):
        self.cmd = cmd
        self.project = os.path.basename(str(project or "").rstrip("\\/"))
        self.t0 = time.time()
        self.launches = 0           # 起了几次 java
        self.daemon = 0             # 走了几次后台执行器
        self.cached = 0             # 用了几次缓存（没连库）
        self.dialect = ""
        self.errors = []            # 这次碰到的错的类别

    def launched(self, via_daemon=False):
        if via_daemon:
            self.daemon += 1
        else:
            self.launches += 1

    def error(self, code, sql_state=None, vendor=None):
        item = str(code or "UNKNOWN")
        if sql_state:
            item += ":" + str(sql_state)
        if vendor not in (None, 0, "0"):
            item += ":" + str(vendor)
        if item not in self.errors:
            self.errors.append(item)

    def done(self, exit_code):
        _append({
            "tool": TOOL, "cmd": self.cmd, "exit": int(exit_code), "ms": int((time.time() - self.t0) * 1000),
            "java": self.launches, "daemon": self.daemon, "cached": self.cached,
            "dialect": self.dialect, "errors": self.errors[:5], "project": self.project,
            "at": int(time.time() * 1000),
        })


def incident(kind, what, detail="", cmd="", project=""):
    """
    工具自己出了毛病。kind 是类别（固定的几种，同一类同一句话只会合成一条问题）：
      crash          脚本自己抛了异常
      runner         执行器没有输出、输出不是 JSON、报了内部错误
      no-driver      找不到驱动
      no-java        找不到 java
      slow           一条命令跑了很久
    detail 里不要放 SQL、数据、连接串。
    """
    _append({
        "tool": TOOL, "incident": str(kind), "what": str(what)[:300], "detail": str(detail)[:1500],
        "cmd": str(cmd), "project": os.path.basename(str(project or "").rstrip("\\/")),
        "at": int(time.time() * 1000),
    })


def crash_detail():
    """当前异常的调用栈，只留文件名和行号（路径里有用户名，去掉）。"""
    lines = []
    for ln in traceback.format_exc().splitlines():
        ln = ln.rstrip()
        if ln.lstrip().startswith("File "):
            try:
                a = ln.index('"')
                b = ln.index('"', a + 1)
                ln = ln[:a + 1] + os.path.basename(ln[a + 1:b]) + ln[b:]
            except ValueError:
                pass
        lines.append(ln)
    return "\n".join(lines[-12:])
