---
name: ttls-redis
description: 查 redis、改 redis 里的数据。内置零依赖的直连客户端，不用装 redis-cli。当用户说"查一下 redis""看看这个 key""缓存里有没有""连接 redis""清一下这个缓存"时使用；排查问题要核对缓存里的实际内容时也用。连接信息从项目的配置里按连接名取，口令不经你的手。
---

# redis

> 版本 3.0.0　｜　更新 2026-09-30　｜　变更记录见 [CHANGELOG.md](CHANGELOG.md)
> 原来叫 redis，现在并进 vibe-kit，跟着套件一起装、一起更新。

面对 redis **自己连、自己查**，不要甩给用户。

客户端只用 Node 自带的模块，不用装任何东西。只支持单机、不加密的连接；集群、哨兵、加密连接会明确报"不支持"。

## 怎么用

```bash
node "$HOME/.claude/skills/ttls-redis/scripts/redis.js" [--conn <连接名>] <子命令> [参数...]
```

工作目录是被操作的项目。只有一个连接时 `--conn` 可以不写。

| 子命令 | 干什么 |
|---|---|
| `conns` | 列出配置里的连接（不带口令） |
| `ping` / `info` | 连一下试试 / 服务器信息 |
| `get <key>` | 读一个 key。类型自己判断：string 是值，hash 是对象，list、set 是数组，zset 是 `[{member,score}]`。key 不存在返回 `exists:false` |
| `keys <pattern>` | 列 key。用游标遍历，不会卡住服务。最多看 3 秒、返回 1000 个，没看完返回 `truncated:true` |
| `ttl <key>` | 还有多久过期 |
| `set <key> <value>` | 写一个 key。原来有过期时间的照样留着 |
| `del <key...>` | 删 key，可以给几个。返回 `deleted:N` |

输出是一行 JSON：成功 `{"ok":true,"data":…}`，失败 `{"ok":false,"code":"…","error":"…"}`。

- **参数里有空格、引号的要整个括起来。** 多出来的参数不会被悄悄丢掉，会报 `BAD_ARGS`。
- **`set` 的值带引号、带 JSON、以 `/` 开头的，不要走命令行**（shell 会改它：PowerShell 去掉里面的双引号，Git Bash 把 `/api/x` 改成 Windows 路径）。
  把值写进 `.vibe/tmp/<事由>/` 里的文件，用 `set <key> --value-file <文件>`。
  `set` 的返回里有 `written`（实际写进去的值），和你要写的对一眼。
- key 以 `/` 开头的（`get /session/1`），在 Git Bash 里命令最前面加 `MSYS_NO_PATHCONV=1`。
- **大的值只取前面一段**：列表、集合、哈希默认取 500 个元素，字符串默认取 64K，返回里有 `truncated:true` 和一共多少。
  要多取加 `--limit <N>`（最多 10000），字符串加 `--full`。
- **`hex:…` 开头的 key、值是二进制的**（多半是 Java 序列化写进去的），显示成了十六进制。
  要读、要删这样的 key，把 `hex:…` 原样当 key 给。

## 连接信息从哪来

项目的 `.vibe/redis.json`。vibe-kit 在后台自动探索项目时会把**开发环境**的 redis 写进去，多数情况下直接就能用。
会话开头的项目说明里有"redis"一行的，连接名照它写。

```json
{ "connections": { "dev": { "host": "127.0.0.1", "port": 6379, "password": "", "db": 0 } } }
```

报 `NO_CONFIG`（找不到配置）时：告诉用户缺什么，让他在 `.vibe/redis.json` 里填；不要假装查到了。
**测试、生产环境的 redis 不会配进来，你也不要自己往里配**：要查那些，告诉用户，由他来配。
以前的位置 `.claude/project.local.json` 的 redis 段照样认。

**口令不经你的手**：不要打开连接配置文件，不要把口令拼进命令行，不要在回答里复述它。

## 几条规矩

1. **读直接做**：`get`、`keys`、`ttl`、`info`、`ping` 不用问。
2. **写之前先问**：`set`、`del` 先用提问框让用户确认，写明要执行的命令、影响哪些 key（`set` 会覆盖已有的值）。
   只有一种情况不用问：用户这一轮明说了对哪一个 key 做什么（"把 user:1 的缓存清掉"），照做。
   一次删两个以上、按 `keys` 的结果批量删，一定要问。
3. **全自动模式下不改数据**：`set`、`del` 会被脚本拦下（退出码 3）。在那项任务后面标"（留给用户：要改 redis 的数据）"，接着做别的。
4. **`truncated:true` 必须说出来**：结果不全。把返回里的 `note` 转述给用户，不要当成完整的结果下结论。
   `keys` 没看完的时候，**没列出来的不等于没有**：知道确切的 key 就直接 `get`。
5. 清空整个库、改运行配置：这个客户端做不了，也不要用别的办法去做。让用户自己来。

## 出错了怎么办

| 错误码 | 意思 | 你该做什么 |
|---|---|---|
| `NO_CONFIG` / `NO_CONN` | 没有配置、没有这个连接名 | 跑 `conns` 看有哪些；没有配置就告诉用户 |
| `CONN_REFUSED` / `TIMEOUT` / `HOST_UNRESOLVED` / `NET_UNREACHABLE` | 连不上 | redis 没起、地址是别的机器、VPN 没连。把原因告诉用户 |
| `CMD_TIMEOUT` | 连上了，命令没等到回话 | 要取的值太大，或者服务器忙。加 `--limit` 少取一些再试 |
| `AUTH_FAILED` | 口令不对；或者服务器没设口令、配置里却写了 | 让用户改配置里的口令 |
| `REDIS_ERROR` | redis 回了一个错（切不到库、命令不认） | 把原话告诉用户。认证、切库不成的时候后面的命令没有发 |
| `UNSUPPORTED_MODE` / `UNSUPPORTED_TYPE` | 集群、哨兵、加密连接、stream 类型 | 这个客户端做不了，告诉用户 |
| `BAD_ARGS` | 参数不对（多了、少了、有不认识的 `--` 参数） | 照提示改 |
| `BLOCKED` | 全自动模式下的写操作 | 留给用户 |
| `UNKNOWN` | 没归类的网络错误 | 把原话告诉用户 |
| 提示"脚本自己出错了" | 这个技能的毛病 | 已经自动记成套件的问题反馈，交代里列进"套件问题" |
