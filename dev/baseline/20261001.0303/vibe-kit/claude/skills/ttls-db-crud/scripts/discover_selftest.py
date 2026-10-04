# -*- coding: utf-8 -*-
"""
discover_selftest.py —— 扫描与落点的自测。不连数据库，不读真实项目，纯离线。

两块：
1. **剥注释**：注释掉的旧地址不能被当成配置。老项目的配置里常年躺着一堆
   注释掉的历史地址，那些多半是别的环境甚至生产库，连过去就是事故。
2. **落点**：`.vibe` 要落在「真正拥有这份配置的项目」下。
   外面套一层壳子（把前端后端装在一起的目录）时，不能落在壳子上 ——
   否则下次在后端目录里开 Claude Code 就找不到了。

跑法：python discover_selftest.py
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

import discover as d                                             # noqa: E402

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)


# ==================================================== 一、剥注释

def t_strip():
    xml = ('<beans>\n'
           '  <!--<property name="url" value="jdbc:oscar://10.0.0.1:2003/old"/>-->\n'
           '  <property name="url" value="jdbc:oscar://10.0.0.2:2003/live"/>\n'
           '</beans>\n')
    out = d.strip_comments(xml, ".xml")
    check("10.0.0.1" not in out, "XML 注释里的地址没被抹掉")
    check("10.0.0.2" in out, "XML 里生效的地址被误抹了")
    check(len(out.splitlines()) == len(xml.splitlines()), "剥注释改变了行数，报出处会错位")

    multi = ('a\n<!-- 跨行注释\n  jdbc:mysql://10.9.9.9:3306/x\n-->\nb jdbc:mysql://1.1.1.1:3306/y\n')
    out = d.strip_comments(multi, ".xml")
    check("10.9.9.9" not in out, "跨行 XML 注释没被抹掉")
    check("1.1.1.1" in out, "跨行注释之外的内容被误抹了")

    props = ('jdbc.url=jdbc:mysql://1.2.3.4:3306/live\n'
             '#jdbc.url=jdbc:mysql://9.9.9.9:3306/dead\n'
             '!jdbc.url=jdbc:mysql://8.8.8.8:3306/dead2\n')
    out = d.strip_comments(props, ".properties")
    check("9.9.9.9" not in out, "properties 的 # 注释没被抹掉")
    check("8.8.8.8" not in out, "properties 的 ! 注释没被抹掉")
    check("1.2.3.4" in out, "properties 里生效的行被误抹了")

    yml = ('url: jdbc:dm://5.5.5.5:5236\n'
           '#  url: jdbc:dm://7.7.7.7:5236\n')
    out = d.strip_comments(yml, ".yml")
    check("7.7.7.7" not in out, "yml 的 # 注释没被抹掉")
    check("5.5.5.5" in out, "yml 里生效的行被误抹了")


# ==================================================== 二、落点

class FakeFound(object):
    def __init__(self, abspath):
        self.abspath = abspath


def mk(root, rel, text="x"):
    p = pathlib.Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def t_owner():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="dbcrud-selftest-"))
    try:
        # 有壳子：壳子没有 pom，后端有
        shell = tmp / "shell"
        cfg = mk(shell, "backend/src/main/resources/application.yml")
        mk(shell, "backend/pom.xml")
        mk(shell, "frontend/package.json")
        got = d.owning_project_root(FakeFound(cfg), shell)
        check(got == (shell / "backend").resolve(),
              "有壳子：应落在 backend，实得 %s" % got)

        # 没壳子：当前目录就是项目根
        plain = tmp / "plain"
        cfg = mk(plain, "src/main/resources/application.yml")
        mk(plain, "pom.xml")
        got = d.owning_project_root(FakeFound(cfg), plain)
        check(got == plain.resolve(), "没壳子：应落在项目根，实得 %s" % got)

        # 多模块：聚合根也有 pom，要落在最外层那个
        multi = tmp / "multi"
        cfg = mk(multi, "app-admin/src/main/resources/application.yml")
        mk(multi, "app-admin/pom.xml")
        mk(multi, "pom.xml")
        got = d.owning_project_root(FakeFound(cfg), multi)
        check(got == multi.resolve(),
              "多模块：应落在聚合根而不是子模块，实得 %s" % got)

        # 一个构建文件都没有：退回扫描根
        bare = tmp / "bare"
        cfg = mk(bare, "conf/jdbc.properties")
        got = d.owning_project_root(FakeFound(cfg), bare)
        check(got == bare.resolve(), "没有构建文件：应退回扫描根，实得 %s" % got)

        # 壳子是 git 仓库，但没有 pom —— 仍然要落在后端，不能被 .git 带偏
        gshell = tmp / "gshell"
        cfg = mk(gshell, "svc/src/main/resources/application.yml")
        mk(gshell, "svc/pom.xml")
        (gshell / ".git").mkdir(parents=True, exist_ok=True)
        got = d.owning_project_root(FakeFound(cfg), gshell)
        check(got == (gshell / "svc").resolve(),
              "壳子是 git 仓库：仍应落在 svc，实得 %s" % got)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def t_scan_end_to_end():
    """整条链路：扫出来的东西要能算出正确的落点。"""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="dbcrud-selftest2-"))
    try:
        shell = tmp / "shell"
        mk(shell, "backend/pom.xml")
        mk(shell, "backend/src/main/resources/application.yml",
           "spring:\n  datasource:\n"
           "    url: jdbc:mysql://localhost:3306/live\n"
           "    username: u\n    password: p\n"
           "#    url: jdbc:mysql://9.9.9.9:3306/dead\n")
        found = d.scan(shell)
        usable = [f for f in found if f.dialect and not f.unresolved]
        check(len(usable) == 1, "应只扫出 1 个可用连接，实得 %d" % len(usable))
        if usable:
            check("9.9.9.9" not in usable[0].url, "注释掉的地址混进来了")
            owner = d.owning_project_root(usable[0], shell)
            check(owner == (shell / "backend").resolve(),
                  "端到端：落点应是 backend，实得 %s" % owner)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    t_strip()
    t_owner()
    t_scan_end_to_end()
    if not FAILS:
        print("全部通过：剥注释 + 落点")
        return 0
    print("不通过 %d 项" % len(FAILS))
    for f in FAILS:
        print("  FAIL %s" % f)
    return 1


if __name__ == "__main__":
    sys.exit(main())
