# 实测过的 Claude Code 行为

设计套件时用到的事实，都是在真的 Claude Code 上测出来的（一般做法：npm 把指定版本装到单独的目录，本进程起一个记录请求、按剧本回复的假模型，`claude -p` 的环境变量里去掉所有 `CLAUDE*`、`ANTHROPIC*`，再把 `HOME`、`USERPROFILE`、`CLAUDE_CONFIG_DIR` 指到假目录）。内网同事的版本从 2.1.120 到 2.1.259 都有，**套件两头都要兼容**；2026-10-05 又在当时最新的 2.1.289 上测了一遍（见最后两节）。

没写版本的，2.1.120 和 2.1.259 都一样。拿不准的写着"没实测"。换 Claude Code 版本之前，先跑 `dev/probes/` 里的四个探测（见 [dev/README.md](../dev/README.md)）。

## 读写文件

- **只认 UTF-8**（2.1.258 / 2.1.260 实测，内网是 2.1.259）：Edit 改 GBK 文件，改的地方对了，但整个文件的中文都变成乱码（U+FFFD），工具照常返回成功；Write 会把文件悄悄转成 UTF-8，GBK 的工程再编译就读错。判断编码只看 BOM。Grep 用 UTF-8 的中文搜 GBK 文件也搜不到。套件的 `guard-encoding` 就是为这个拦的，`tools/to-utf8.js` 用来转。

## 钩子

- SessionStart、UserPromptSubmit、PostToolUse 的 `additionalContext` 都送得到；PreToolUse、PostToolUse、Stop、SessionEnd 都会触发。
- **拦截要用 JSON 输出**（顶层 `decision: "block"` 加 `reason`；PreToolUse 另带 `permissionDecision: "deny"`），退出码 0。Windows 上 Claude Code 可能经 PowerShell 跑钩子，退出码 2 会变成 1，被当成"钩子出错、不拦"。
- PreToolUse 的 `permissionDecision: "ask"`：权限规则里放行了也照样弹确认框。套件的 push 确认用的就是它。
- 同一个事件的多个命令钩子是并行跑的；每个钩子起 shell + node 要 0.3 到 0.9 秒。
- **`type: "http"` 的钩子能用**（2.1.120 起），一次 0.1 秒左右，服务不在时当放行。Claude Code 发的钩子请求不带 Origin、Sec-Fetch 这类头。
- **PreToolUse 读会话记录时，正在执行的这一次调用已经写进去了**（还没有结果）。判断"上一次改文件"要按"有没有工具结果"区分，不然会把这一次当成上一次。
- 会话开着的时候：钩子脚本改了，下一次调用就是新的；settings.json 里新登记的钩子，会话中就生效。全局 CLAUDE.md 改了、新装的技能，要 `/clear` 之后才读到（套件由用户开口时的钩子把变了的部分送过去）。
- 2.1.259、2.1.263 用 `claude -p` 时，SessionStart 钩子慢一点（几百毫秒）、又有命令方式的 Stop 钩子，答完就不退出。和钩子内容无关，两个空脚本就能复现；2.1.231、2.1.215 没有；Stop 走 HTTP 时没有这个问题。交互方式不受影响。

## 约定、规则、自动记忆

- 规则目录 `~/.claude/rules/*.md`、`项目/.claude/rules/*.md`：没写 `paths` 的会话开始就加载；写了 `paths` 的，**只有 Read 到匹配的文件才加载，一个会话只加载一次**。Write 新建、Grep 都不触发。`paths` 相对规则所在项目的根（`.claude` 的上一级）。（2.1.120、2.1.259、2.1.283 一致）
- 单独一行的 HTML 注释不进上下文，行尾的注释会进。所以元数据可以放在单独一行的注释里，不花 token。
- 自动记忆默认开着（不连 Anthropic 也开着），说明文字每个请求都占系统提示：2.1.120 约 12,700 字符，2.1.259 约 2,300 字符。`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 能关。套件默认关掉它。

## 上下文和自动压缩

- 不指定模型时，2.1.259 发出去的模型名是 `claude-opus-5`，按 100 万的窗口算。模型名改成它不认识的（比如内网模型的真名），按 20 万算，而且强制执行：19 万左右直接报 `Prompt is too long`。`CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` 能告诉它真实窗口。
- **2.1.259 没设压缩窗口时，不按用量自己压缩**：只等模型接口报"请求太长"再补救，内网模型报的错它认不出，上下文会一直涨过 100%。设了 settings.json 的 `autoCompactWindow`（或者环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`）就在"窗口 − min(最大输出, 2 万) − 1.3 万"处压缩，设到 97.7 万以上会先报 `Prompt is too long`。连续失败 3 次不再试。
- 2.1.120 按阈值压缩照常（默认的模型按 20 万窗口算，约 16.7 万压缩），也认 `autoCompactWindow`。
- `/autocompact <数>` 能在开着的会话里改压缩窗口。`/context` 能看它认为窗口多大。
- 状态栏拿到的 `used_percentage` 被夹在 0 到 100。

## 状态栏

- 输出几行就显示几行（2.1.120、2.1.259 是读代码确认的，2.1.289 是在交互界面里实测的）。
- settings.json 里 `statusLine.refreshInterval`（秒）能让它没有新消息时也定时刷新。

## 权限

- 开着跳过权限模式（`--dangerously-skip-permissions`），**Bash 里 cd 和别的命令串在一条里照样弹确认框**（用户实测确认）。所以套件拦下这种命令，给出不用 cd 的写法（`git -C`、`mvn -f`、`npm --prefix`、写完整路径）。
- 权限规则 `Bash(git push:*)` 按前缀匹配，`git -C 子项目 push` 绕得过去，所以 push 的确认由钩子来做。
- 项目里写 `.claude/settings.local.json` 的 `{"disableAllHooks": true}` 能让所有钩子失效，套件的 `guard-kit` 拦这种写入。
- 2.1.120、2.1.259 都认用户 settings.json 里的 `permissions.defaultMode: "bypassPermissions"`；2.1.259 不认项目、local 设置里写的。

## 其他

- `/clear` 不发给模型，触发 SessionStart（`source=clear`）。SessionStart 输出 `initialUserMessage` 能让新会话自动发出第一句话（2.1.259 上 `-p` 也生效）。
- 2.1.259 用 `claude -p` 时不给模型 AskUserQuestion 这个工具，2.1.120 给。提问框的端到端只能在 2.1.120 上测。
- 内网网关给的工具调用 id 会重复，但只在不同会话之间。同一个对话里 id 重复，2.1.120 会把第二次调用换成"[Tool use interrupted]"。
- 内网网关的回复是整段返回的（攒包在网关那层，不在模型、不在路由）。网关对单次请求体有大小上限（实测约 1 MB，合二十三四万 token），超了直接 413，换模型、`/compact` 都没用。路由记下实测到的上限，快到时状态栏提前警告。
- 路由原样转发请求，上游收到的字节和 Claude Code 发出的逐字节一致，不破坏提示缓存。真正让缓存失效的是换模型、请求被放弃后重发、上下文太长（30 万 token 时热请求比冷请求还慢）。

## 2.1.289 上实测的（2026-10-05）

测法：`dev/probes/` 里的四个探测（真的 Claude Code 加假网关），加上端到端五套。

- **`autoCompactWindow` 照样认**（settings.json 顶层）：设 50 万、报 48 万就压缩，报 30 万不压；设 93.3 万、报 91 万就压缩。另外 2.1.289 不设这一项也会按用量压缩了（报 99 万时压缩），不像 2.1.259 那样一直涨。`/autocompact` 按模型各存一份的那个改动没测。
- **没配权限模式时默认进"自动模式"（auto mode）**，`-p` 和交互界面都是，经网关、模型名不认识的也是：
  - 套件装的整条 `Bash` 放行规则在自动模式下不算数。`echo`、`git status`、在项目里 Write / Edit / Read 不过分类器；`node -e`、`curl` 这类每条先发一个分类请求：模型名 `claude-sonnet-5`，不走流式，系统提示约 14 万字符，`max_tokens` 64，带 `stop_sequences`。
  - 分类器要的回答有两种格式（看它拿到的是哪一套提示）：`<block>no</block>` / `<block>yes</block><category>…</category><reason>…</reason>`，或者 `<severity>N</severity>`。答得不合格式：第一段重试 5 次，再用 `max_tokens` 8192 的第二段重试 5 次，然后这条命令被拦下（"Auto mode could not evaluate this action and is blocking it for safety"）。
  - 启动时 stderr 有一句：经网关的会话分类请求照旧计费。
  - **这几种都不进自动模式、没有分类请求**：`permissions.disableAutoMode: "disable"`；`permissions.defaultMode` 写成 `default` 或 `acceptEdits`；命令行 `--dangerously-skip-permissions`。
  - 交互界面：只写 `defaultMode: "default"` 的，会弹一次"Make auto mode your default permission mode?"，默认选中的是 Yes。写 `disableAutoMode` 的不弹，底下显示 `manual mode on`。
  - `permissions.disableAutoMode` 这一项 2.1.120、2.1.259 不认识，但不碍事：设置文件照常生效（放行规则、钩子都在）。
  - 套件没关自动模式之前，端到端五套在 2.1.289 上挂了 31 项（命令被拦、审查代理没跑起来）；套件写上 `disableAutoMode` 之后五套 190 项全过。
- **钩子**：命令方式的 SessionStart、UserPromptSubmit、PreToolUse、Stop 照常（端到端五套）；HTTP 方式的 pre-edit、guard-commit、verify-gate 照常打到路由，拦截和"要确认"都生效。已有的文件没先 Read 就 Write，Claude Code 自己先报错，不走钩子。
- **状态栏**：多行照常显示；`refreshInterval: 30` 起作用（实测相隔 28.8、30.0 秒）；输入里 `context_window.used_percentage`、`current_usage` 在第一次回复之前是 `null`，之后是数字。2.1.289 多了几个字段：`prompt_cache`（`hit_ratio`、`last_miss_cause` 这些）、`cost`、`effort`、`exceeds_200k_tokens`、`prompt_id`。
- 不指定模型时发出去的模型名是 `claude-opus-5-5`；启动时会对网关发一个 `HEAD /api/hello`。
- 交互界面可以在看不见的控制台里跑起来抓屏：Git for Windows 带的 `winpty -Xallow-non-tty -Xplain`，`.claude.json` 里先写好 `hasCompletedOnboarding` 和项目的 `hasTrustDialogAccepted`。
- 测试项目建在用户目录下面时（`%TEMP%` 就在用户目录下面），Claude Code 会往上找到真实的 `~/.claude/CLAUDE.md`，当成上级目录的项目说明读进来（只读，没改）。要完全隔离，把测试项目建在用户目录之外。

## 官方文档里写的、还没实测（2026-10-05 查的）

- 钩子的超时（hooks 文档）：`command`、`http` 默认 600 秒；**在 UserPromptSubmit 上降到 30 秒**。到点就结束钩子、丢掉它的输出，这一轮照常往下走。每个钩子可以用 `timeout` 字段自己定（秒）。套件的"用户开口"钩子里有开工前拉代码，所以安装器给它写明 300 秒。哪个版本开始降到 30 秒文档没说。

## 更新日志里说的、还没实测（2026-10-05 查的，2.1.260 到 2.1.289）

npm 上最新是 2.1.289（2026-10-03）。下面这些来自官方的 CHANGELOG，和套件有关，**没有在真的 Claude Code 上验过**：

- 2.1.277：项目里没有 CLAUDE.md 时读 AGENTS.md。子代理的结果带着"这是子代理的输出"的标头、正文缩进送回主代理（套件认审查结论的正则没有锚定行首；端到端里审查记账在 2.1.289 上是过的）。去掉了 TaskOutput 工具。
- 2.1.281：`--dangerously-skip-permissions` 和自动模式下，危险的 `rm` 等 2 分钟没人答就拒绝并给改法，无人值守的会话不再一直挂着。`settings.json` 加了 `"attribution": false`（注意：老版本碰到这一项会跳过整个设置文件，跨版本共用的文件要写成对象的形式）。
- 2.1.283：`/doctor prompt-audit` 能审 CLAUDE.md、技能、代理里给旧模型写的提示写法。
- 2.1.284：压缩之后还是"Prompt is too long"会再压一次、少留一些。2.1.288：上一次回复报的 token 用量是 0 时，不再直接报"Prompt is too long"，会去压缩。
- 2.1.288：**带 `paths` 的规则和子目录的 CLAUDE.md，Write、Edit 建了或改了范围里的文件也会加载**（以前只有 Read）。PreToolUse 钩子匹配失败或者输入没法序列化时不再跳过，直接拦下。
- 2.1.287：Windows 上 Bash 工具每条命令前少起一个子 shell，快了一些。Opus 4.7 以后和 Fable 在网关上默认 1M 窗口。
- 2.1.271：`cd` 加 git、两次 cd、子 shell 这类命令在跳过权限模式下的确认框，和 `permissions.blockReadsOutsideWorkingDirectories` 有关。
