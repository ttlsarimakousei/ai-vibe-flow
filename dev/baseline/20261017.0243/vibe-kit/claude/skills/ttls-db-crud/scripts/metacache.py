# -*- coding: utf-8 -*-
"""
metacache.py —— 表结构缓存：看过的表的列和主键存在 `<项目>/.vibe/db-crud.cache.json`。只用 Python 标准库。

为什么要存：表结构很少变，而每看一次都要起 java、连库。存下来之后再看同一张表不用连库。

什么时候不用缓存里的：
  · 存了超过 12 小时
  · 命令带了 --fresh
  · 通过这个工具对这张表执行过改结构的语句（ALTER、DROP、CREATE、TRUNCATE）—— 执行完就把它从缓存里去掉

**别人在库里改了表结构，这里不会知道。** 所以从缓存里拿出来的，输出里一定说明"来自缓存、多久之前存的"；
照着缓存写的 SQL 报"列不存在"，就带 --fresh 重新看一遍。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vibe                                                      # noqa: E402

TTL_SECONDS = 12 * 3600
MAX_TABLES = 300


def _key(conn_name, schema, table):
    return "%s|%s|%s" % (conn_name, (schema or "").lower(), (table or "").lower())


def _load(project_root):
    p = vibe.meta_cache_path(project_root)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("tables"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "tables": {}}


def _save(project_root, data):
    try:
        vibe.ensure_dir(project_root)
        tables = data.get("tables", {})
        if len(tables) > MAX_TABLES:
            keep = sorted(tables.items(), key=lambda kv: kv[1].get("at", 0), reverse=True)[:MAX_TABLES]
            data["tables"] = dict(keep)
        p = vibe.meta_cache_path(project_root)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        os.replace(str(tmp), str(p))
    except OSError:
        pass                            # 存不下就算了，下次重新查


def get(project_root, conn_name, schema, table, ttl=TTL_SECONDS):
    """拿一张表的缓存。没有、过期了返回 None。返回的字典里 age 是存了多少秒。"""
    e = _load(project_root)["tables"].get(_key(conn_name, schema, table))
    if not e or not e.get("found"):
        return None
    age = time.time() - float(e.get("at", 0))
    if age < 0 or age > ttl:
        return None
    out = dict(e)
    out["age"] = int(age)
    return out


def put(project_root, conn_name, schema, asked, entry):
    """存一张表。只存找到了的：找不到的下次还要再查（可能只是还没建）。"""
    if not entry or not entry.get("found"):
        return
    data = _load(project_root)
    rec = dict(entry)
    rec["at"] = time.time()
    data["tables"][_key(conn_name, schema, asked)] = rec
    # 按实际的表名也存一份：下次不管按哪种大小写问都能命中。
    # 问的时候带着 schema（OTHER.T_ORDER）的不另存：另存的那一份键里是默认的 schema，
    # 下次问默认 schema 的 T_ORDER 会拿到 OTHER 那张表的结构
    real = entry.get("table")
    if real and "." not in (asked or "") and real.lower() != (asked or "").lower():
        data["tables"][_key(conn_name, schema, real)] = rec
    _save(project_root, data)


def drop(project_root, conn_name, table=None):
    """表结构变了。table 不给就把这个连接的都去掉。返回去掉了几条。"""
    data = _load(project_root)
    bare = (table or "").split(".")[-1].lower()
    gone = [k for k in data["tables"]
            if k.startswith(conn_name + "|") and (not bare or k.split("|")[-1].split(".")[-1] == bare)]
    for k in gone:
        del data["tables"][k]
    if gone:
        _save(project_root, data)
    return len(gone)
