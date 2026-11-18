# -*- coding: utf-8 -*-
"""
notes_selftest.py —— 记坑的自测。不连数据库，纯离线。

重点保的是两件事：
1. **改配置不能把别的东西弄坏** —— 注释、其它连接段、原有字段都得原样还在
2. **同一条不重复记** —— 这个功能是「别再踩第二次」，不是攒一堆重复提醒

跑法：python notes_selftest.py
"""
import pathlib
import shutil
import sys

# 不在技能目录里留 __pycache__：安装器靠逐个文件比对来判断技能有没有被改过
sys.dont_write_bytecode = True
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import notes                                                     # noqa: E402

FAILS = []

SAMPLE = """; urai-db-crud 的连接配置，由 init 从项目里自动扒出来的。
; 口令是从项目配置里原样抄来的，明文就明文，改不改随你。

[main]
dialect = dm
jdbc = jdbc:dm://10.0.0.5:5236
user = SYSDBA
password = devpwd
; 来自 src/main/resources/application.yml:6

[history]
dialect = mysql
jdbc = jdbc:mysql://10.0.0.6:3306/hist
user = root
password = rootpwd
; 来自 src/main/resources/application-hist.yml:4
"""


def check(cond, msg):
    if not cond:
        FAILS.append(msg)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="dbcrud-notes-"))
    cfg = tmp / "urai-db-crud.ini"
    try:
        cfg.write_text(SAMPLE, encoding="utf-8")

        # ---- 第一条 ----
        ok, msg = notes.add(cfg, "main", "表名要大写")
        check(ok, "第一条没记上：%s" % msg)
        text = cfg.read_text(encoding="utf-8")
        check("notes =" in text, "没写出 notes 块")
        check("表名要大写" in text, "内容没写进去")

        # ---- 别的东西不能被弄坏 ----
        check("; 来自 src/main/resources/application.yml:6" in text, "出处注释被吃掉了")
        check(text.startswith("; urai-db-crud 的连接配置"), "文件头注释被吃掉了")
        check("[history]" in text and "rootpwd" in text, "另一个连接段被弄坏了")
        check("password = devpwd" in text, "原有字段丢了")

        # ---- 第二条要追加，不覆盖 ----
        ok, _ = notes.add(cfg, "main", "空串会变 NULL")
        check(ok, "第二条没记上")
        text = cfg.read_text(encoding="utf-8")
        check("表名要大写" in text and "空串会变 NULL" in text, "第二条把第一条覆盖了")

        # ---- 重复的不记 ----
        ok, msg = notes.add(cfg, "main", "表名要大写")
        check(not ok, "重复的被记了第二遍")
        ok, msg = notes.add(cfg, "main", "  表名要大写  ")
        check(not ok, "只差空格的重复被记了")

        # ---- 记到另一个连接上，不能串段 ----
        ok, _ = notes.add(cfg, "history", "这是历史库，只读")
        check(ok, "另一个连接记不上")

        # ---- 读回来，两个连接各是各的 ----
        import configparser
        cp = configparser.ConfigParser(interpolation=None)
        cp.read_string(cfg.read_text(encoding="utf-8"))
        main_notes = notes.parse_notes(cp["main"].get("notes"))
        hist_notes = notes.parse_notes(cp["history"].get("notes"))
        check(len(main_notes) == 2, "main 应有 2 条，实得 %d" % len(main_notes))
        check(len(hist_notes) == 1, "history 应有 1 条，实得 %d" % len(hist_notes))
        check(all("只读" not in n for n in main_notes), "history 的话串到 main 去了")
        check(cp["main"]["password"] == "devpwd", "读回来时口令变了")

        # ---- 连接不存在 ----
        ok, msg = notes.add(cfg, "nosuch", "x")
        check(not ok and "没有叫" in msg, "对不存在的连接应明确拒绝，实得：%s" % msg)

        # ---- 排版 ----
        out = notes.render(main_notes)
        check("这个连接记过的坑" in out and "表名要大写" in out, "排版不对")
        check(notes.render([]) == "", "没有坑时不该输出东西")

        # ---- 工具自己记的：一个连接只记一条，不按表一张张记 ----
        ok, _ = notes.add(cfg, "main", "标识符要用大写：表名按 T_ORDER 这样写，t_order 查不到", once="标识符要用大写")
        check(ok, "大小写的提醒第一次没记上")
        for t in ("T_USER", "T_ROLE", "T_MENU"):
            ok, _ = notes.add(cfg, "main", "标识符要用大写：表名按 %s 这样写，%s 查不到" % (t, t.lower()),
                              once="标识符要用大写")
            check(not ok, "大小写的提醒换一张表又记了一条：%s" % t)

        # ---- 人记的排前面、新记的排前面；工具记的再多也挤不掉人记的 ----
        many = ["2026-09-0%d 标识符要用大写：表名按 T%d 这样写，t%d 查不到" % (i, i, i) for i in range(1, 10)]
        many += ["2026-09-01 T_LOG 没有主键，改之前先想清楚怎么还原"]
        many += ["2026-09-20 空串会变 NULL", "2026-09-21 AMOUNT 是加密存的"]
        out = notes.render(many, conn_name="main")
        lines = out.splitlines()
        check(lines[1].endswith("AMOUNT 是加密存的") and lines[2].endswith("空串会变 NULL"),
              "人记的、新记的应该排最前：%s" % lines[1:3])
        check(out.count("标识符要用大写") == 1, "同一类的工具提醒只显示一条，实得 %d" % out.count("标识符要用大写"))
        check("db-crud.ini" not in out, "不该让人去翻配置文件（里面有口令）")
        eleven = ["2026-09-%02d 第 %d 条" % (i, i) for i in range(1, 12)]
        out = notes.render(eleven, conn_name="main")
        check("还有 3 条没显示" in out and "note --list" in out, "超过 8 条要说怎么看全部：%s" % out.splitlines()[-1])
        out = notes.render(eleven, conn_name="main", show_all=True)
        check(out.count("  · ") == 11, "--list 要全部列出，实得 %d" % out.count("  · "))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if not FAILS:
        print("全部通过：记坑")
        return 0
    print("不通过 %d 项" % len(FAILS))
    for f in FAILS:
        print("  FAIL %s" % f)
    return 1


if __name__ == "__main__":
    sys.exit(main())
