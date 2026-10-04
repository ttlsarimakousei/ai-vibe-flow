# -*- coding: utf-8 -*-
"""
daemon.py —— 后台执行器（开关，默认关）。只用 Python 标准库。

平时每条命令都要起一次 java、载一次驱动、连一次库，一两秒就花在这上面。
打开开关之后：第一次用的时候起一个 java 留在后台，连接留着；后面的命令把要做的事交给它，
省掉前三件事。几分钟没人用它自己退出。

开关在 vibe-kit 的配置页（config.json 的 dbcrudDaemon），默认关 ——
这个技能原来的设计是不留常驻进程。没装 vibe-kit 时也可以用环境变量 DBCRUD_DAEMON=1 打开。

它只听本机（127.0.0.1），端口随机，每次启动生成一个口令牌，连同端口写在
~/.db-crud/daemon/<编号>.json 里；不带对口令牌的请求一律拒绝。
数据库的口令随每个请求经本机的这条连接交给它，不进命令行。

**先握手，再交口令。** 状态文件可能是残留的（执行器被结束了、关机了），那个端口后来可能被别的程序占了：
连上之后先发一个随机数，对面要用口令牌算出对的回答，才把请求（里面有数据库口令）发过去。

**走不通就退回老办法**：起不来、连不上、握手不对，这一次就照旧起一个 java 做，不报错。
**请求发出去之后就不重发**：发出去之后超时、断了，执行器那头可能已经在做、也可能做完了。
只读的请求重做一遍没有害处，退回老办法；写操作不重做，报"结果不明"。
"""
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vibe                                                      # noqa: E402

END = "--@@DBCRUD-END@@"

# 会改库的请求：发出去之后出了岔子不能重做
WRITE_MODES = ("apply", "batch")

# _talk 的三种结局
UNREACHABLE = "unreachable"         # 没连上、握手不对：什么都没发出去
LOST = "lost"                       # 请求发出去了，没等到回话


def enabled():
    env = os.environ.get("DBCRUD_DAEMON")
    if env is not None:
        return env.strip() in ("1", "true", "on")
    cfg = vibe.kit_json("config.json", {}) or {}
    return cfg.get("dbcrudDaemon") is True


def idle_seconds():
    cfg = vibe.kit_json("config.json", {}) or {}
    try:
        n = int(cfg.get("dbcrudDaemonIdleMinutes") or 5)
    except (TypeError, ValueError):
        n = 5
    return max(1, min(60, n)) * 60


def state_dir():
    return pathlib.Path.home() / ".db-crud" / "daemon"


def _runner_stamp(classpath, runner_class):
    """执行器那个 class 文件的指纹：套件升级之后换了新的，就不再用旧的那个后台执行器。"""
    first = str(classpath).split(os.pathsep)[0]
    try:
        with open(os.path.join(first, runner_class + ".class"), "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()[:12]
    except OSError:
        return ""


def _state_file(java, classpath, runner_class="DbRunner"):
    key = hashlib.sha1(("%s\n%s\n%s" % (java, classpath, _runner_stamp(classpath, runner_class)))
                       .encode("utf-8")).hexdigest()[:12]
    return state_dir() / (key + ".json")


def _read_state(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_line(s, limit=4096):
    buf = b""
    while len(buf) < limit:
        ch = s.recv(1)
        if not ch or ch == b"\n":
            break
        buf += ch
    return buf.decode("utf-8", errors="replace").strip()


def _talk(state, args, stdin_text, password, timeout):
    """
    发一个请求，拿回那一行 JSON。
    返回 (结果, 结局)：成功是 (字典, None)；没连上、握手不对是 (None, UNREACHABLE)；
    请求发出去之后没等到回话是 (None, LOST)。
    """
    token = str(state.get("token", ""))
    lines = ["TOKEN " + token]
    it = iter(args)
    for a in it:
        name = a[2:] if a.startswith("--") else a
        val = next(it, "")
        lines.append("ARG %s %s" % (name, str(val).replace("\r", " ").replace("\n", " ")))
    if password:
        lines.append("PASSWORD " + str(password).replace("\r", "").replace("\n", ""))
    lines.append("INPUT")
    if stdin_text:
        lines.append(stdin_text)
    lines.append(END)
    data = ("\n".join(lines) + "\n").encode("utf-8")
    try:
        s = socket.create_connection(("127.0.0.1", int(state.get("port", 0))), timeout=3)
    except (OSError, ValueError):
        return None, UNREACHABLE
    sent = False
    try:
        # 握手：对面得知道口令牌。执行器认得握手的，会在状态文件里写 hello；不认得的（旧的执行器）照老办法直接发
        if state.get("hello"):
            nonce = hashlib.sha256(os.urandom(32)).hexdigest()[:32]
            s.settimeout(3)
            s.sendall(("HELLO %s\n" % nonce).encode("utf-8"))
            want = "HI " + hashlib.sha256((token + "\n" + nonce).encode("utf-8")).hexdigest()
            if not token or _read_line(s) != want:
                return None, UNREACHABLE
        s.settimeout(timeout)
        sent = True
        s.sendall(data)
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except OSError:
        return None, (LOST if sent else UNREACHABLE)
    finally:
        try:
            s.close()
        except OSError:
            pass
    text = buf.decode("utf-8", errors="replace").strip()
    if not text:
        return None, LOST
    try:
        return json.loads(text.splitlines()[-1]), None
    except ValueError:
        return None, LOST


def _spawn(java, classpath, runner_class, state_path, jvm_flags):
    state_dir().mkdir(parents=True, exist_ok=True)
    try:
        state_path.unlink()
    except OSError:
        pass
    exe = java
    # javaw 没有控制台，不会弹窗口
    if os.name == "nt" and java.lower().endswith("java.exe"):
        w = java[:-8] + "javaw.exe"
        if os.path.isfile(w):
            exe = w
    cmd = [exe] + list(jvm_flags) + ["-Dfile.encoding=UTF-8", "-cp", classpath, runner_class,
                                     "--mode", "serve", "--state-file", str(state_path),
                                     "--idle-seconds", str(idle_seconds())]
    log = state_dir() / "daemon.log"
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x08000000 | 0x00000200       # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    try:
        with open(log, "ab") as lf:
            # 工作目录放在它自己的目录里：放在项目目录的话，它活着的那几分钟项目目录删不掉、改不了名
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=lf, stderr=lf, close_fds=True,
                             cwd=str(state_dir()), **kw)
    except OSError:
        return None
    # 等它把端口写出来
    for _ in range(60):
        time.sleep(0.1)
        st = _read_state(state_path)
        if st and st.get("port"):
            return st
    return None


def _lost(mode):
    """请求发出去了、没等到回话。只读的返回 None（调用方照旧起 java 重做）；写操作不重做。"""
    if mode not in WRITE_MODES:
        return None
    return {"ok": False, "code": "UNKNOWN_OUTCOME",
            "error": "请求已经交给后台执行器，但没等到回话（超时，或者连接断了）。"
                     "这条写操作可能已经执行并提交了，也可能没有。"
                     "不要直接重跑：先查一下数据现在是什么样，再决定。"}


def request(java, classpath, runner_class, args, stdin_text, password, timeout, jvm_flags=()):
    """
    把一次调用交给后台执行器。返回执行器回的 JSON；走不通返回 None（调用方照旧起 java）。
    写操作发出去之后没等到回话：返回一个 code 是 UNKNOWN_OUTCOME 的失败结果，调用方不能重做。
    """
    mode = ""
    for i, a in enumerate(args):
        if a == "--mode" and i + 1 < len(args):
            mode = args[i + 1]
    path = _state_file(java, classpath, runner_class)
    st = _read_state(path)
    if st:
        r, why = _talk(st, args, stdin_text, password, timeout)
        if r is not None and r.get("code") != "BAD_TOKEN":
            return r
        if why == LOST:
            return _lost(mode)
    st = _spawn(java, classpath, runner_class, path, jvm_flags)
    if not st:
        return None
    r, why = _talk(st, args, stdin_text, password, timeout)
    if r is None and why == LOST:
        return _lost(mode)
    return r


def status():
    """现在留着的后台执行器：[{file, port, pid, alive, connections}]。"""
    out = []
    try:
        files = sorted(state_dir().glob("*.json"))
    except OSError:
        files = []
    for f in files:
        st = _read_state(f)
        if not st:
            continue
        r, _ = _talk(st, ["--mode", "status"], "", "", 3)
        out.append({"file": str(f), "port": st.get("port"), "pid": st.get("pid"),
                    "alive": bool(r and r.get("ok")), "connections": (r or {}).get("connections", 0),
                    "started": st.get("started")})
    return out


def stop_all():
    """都停掉。返回停了几个。"""
    n = 0
    try:
        files = sorted(state_dir().glob("*.json"))
    except OSError:
        files = []
    for f in files:
        st = _read_state(f)
        if st:
            r, _ = _talk(st, ["--mode", "stop"], "", "", 3)
            if r and r.get("ok"):
                n += 1
        try:
            f.unlink()
        except OSError:
            pass
    return n
