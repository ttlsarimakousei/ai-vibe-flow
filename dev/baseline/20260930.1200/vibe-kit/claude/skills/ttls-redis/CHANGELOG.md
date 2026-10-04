# ttls-redis 变更记录

> 当前版本 **3.0.0**。这个技能原来叫 redis，在 SKILL 仓库里；2026-09-30 并进 vibe-kit，以后在 vibe-kit 这边维护。

## 3.0.0 —— 2026-09-30　并进 vibe-kit：改名、口令不上命令行

- 名字：`redis` → `ttls-redis`。客户端从 `assets/redis-client.js` 挪到 `scripts/redis.js`
- **连接信息不从命令行传了**。以前是把主机、端口、口令拼成一段 JSON 放在命令行上，口令会进会话记录和进程列表。现在写在项目的 `.vibe/redis.json` 里，命令行只给连接名（`--conn dev`）。把 JSON 放在命令行上会被拒绝，并说明改法
- 配置文件可以有几个连接；口令可以写明文、`${ENV:变量名}`、`${FILE:路径}`
- 以前的位置 `.claude/project.local.json` 的 redis 段照样认，连接名算 `main`
- 找配置：当前目录、往上 5 层（到仓库根为止）、往下 3 层（人在壳子上，配置在里面的后端下）。往下找到好几份不猜，让人用 `--project` 指定
- 新子命令 `conns`：列出配置里的连接，不带口令
- **全自动模式下 `set`、`del` 不做**（退出码 3）：用户不在，改数据的事留给他
- 集群、哨兵、加密连接（rediss）明确报"不支持"。以前会去连配置里的第一个地址，得到一堆看不懂的错
- 带用户名的认证（redis 6 的 ACL）：配置里写了 `username` 就用 `AUTH 用户名 口令`
- 用量和毛病自动记进 vibe-kit：每条命令的耗时、出错的类别；脚本自己崩了记成套件的问题反馈。不记 key、值、地址、口令
- 方法说明并进了 SKILL.md，不再单独一份

**发布前全仓审查之后改的**（同一个版本）

- **一条命令在一个连接里做完，先认证、切库，成了才发后面的命令**。以前是一起发出去：库号写错、服务器没设口令配置里却写了的时候，`set`、`del` 照样在 0 号库里执行了，脚本却报失败
- **`keys` 真的看得到 1 万个以内的库了**：一轮看 1000 个（以前 100 个、最多 10 轮，只看得到约 1000 个 key），按时间（3 秒）收尾。没看完的时候说清一共多少个 key、看了大约多少个，"没列出来的不等于没有"
- **`set` 留着原来的过期时间**。以前直接覆盖，30 分钟过期的缓存被改成了永久的
- **`set` 的值可以不走命令行**：`--value-file`、`--value-stdin`。返回里带着实际写进去的值。多出来的参数报错（以前 `set k hello world` 只写进 hello，还说成功）
- **`--conn` 写在哪都认；不认识的 `--` 参数不收**。以前 `del cache:1 --conn dev` 会把 `--conn`、`dev` 也当成 key 删
- **二进制的 key 和值显示成 `hex:…`，也可以这么给**。以前 Java 序列化写进去的 key 列得出来、读不到
- **大的值只取前面一段**（500 个元素、64K），说清一共多少；`--limit`、`--full` 放宽。收数据不再每来一块就从头解一遍
- 错误码分细了：网络不通 `NET_UNREACHABLE`（以前算 `UNKNOWN`，被说成技能的毛病）、命令超时 `CMD_TIMEOUT`（以前和连不上用同一个码）
- 脚本自己出的错才记成套件的问题反馈（以前基本记不上）
- 找配置：当前目录自己是仓库根的不往上找（以前会用到上一层别的项目的配置）

七个原有的子命令（ping、info、get、keys、ttl、set、del）照样在；`get` 大的值、`keys` 的输出多了几个字段（`truncated`、`total`、`note`）。

---

以下是并进来之前的记录。
# redis skill CHANGELOG

> 格式：`- {Issue 编号}: 一句话变更摘要 (类型缩写)`；时间 `YYYY-MM-DD HH:MM`；语义版本 X.Y.Z。

## 2.0.0 (待发布) — 零依赖 Node 直连（BREAKING：不再需要 redis-cli）

- FEAT-008: **连接机制换实现**——新增内置直连客户端 `assets/redis-client.js`（仅用 Node 内置 `net`/`dns` 自实现 redis 线上协议编解码），**彻底去掉对外部 redis-cli 二进制的依赖**（用户机器普遍没装 cli，原实现实际一直走"够不着"降级）。7 子命令 `ping`/`info`/`get`（按键类型自动分派 string·hash·list·set·zset，**键不存在显式 `exists:false` 区别于空串**，stream 与未知类型返回 `UNSUPPORTED_TYPE` 不猜值）/`keys`（**游标遍历替代一次性列举**，上限 10 轮·10000 键，**达上限返回 `truncated` 标记禁止当完整结果**）/`set`/`del`（多 key，返回 `deleted:N`）/`ttl`；**9 类错误码含 `UNKNOWN` 兜底**；**双层超时**（连接 3s + 命令 5s）；抗 TCP 分包；按字节长度编码（中文/特殊字符安全）；`net.connect` 加 DNS lookup 钩子使解析失败快速准确归类。**安全模型不变**（连接优先级 连接器>本机配置>降级、危险操作结构化确认、参数数组防注入），新增**脚本层硬约束**（客户端不提供清库/改运行配置子命令）。描述去"Windows 环境"限定——直连后真跨平台。自测 14 组验收全通过（mock 服务端端到端 7 子命令 / AUTH·SELECT 分支 / db=0 不切库 / 超时 / 认证失败 / 错误分类 / SCAN 截断 / 特殊字符往返 / 零依赖检查）(BREAKING)

## 1.0.0 (待发布) — 首版

- FEAT-003: 自研轻量 redis skill 首版——Windows redis-cli + 读项目 `.claude/project.local.json` redis 段连接 + 命令集（connect/get/keys[SCAN 优先]/set/del/ttl/info）+ 危险操作安全模型（FLUSHALL/FLUSHDB/批量 DEL/CONFIG SET 先结构化确认）+ 连接优先级（MCP→local 配置→降级告知）+ execFileSync 防注入；落实用户"必要时自己查 redis"偏好，配合自主执行红线 (NEW)
