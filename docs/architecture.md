# vibe-kit 的架构

这篇讲套件由哪几块组成、各在什么时机起作用、状态记在哪。每块的细节以源码开头的注释为准。

## 一张图看全

```
Claude Code ──请求──▶ 模型路由 router.js（127.0.0.1:15730）──▶ 公司网关后面的各个模型
     │                    │
     │                    ├─ 配置页 /ui（ui.html + kit-api.js）：模型、角色、开关、本机环境、驱动、更新和上报
     │                    └─ HTTP 钩子 /vibe-kit/hook/<名字>（hook-host.js，工作线程里跑钩子）
     │
     ├─ 钩子（命令方式：node kit/hooks/<名字>.js；高频的几个装了路由时走 HTTP）
     ├─ 状态栏 kit/statusline.js
     └─ ~/.claude 里的约定、规范、技能、审查代理（install.js 装进去）
```

装好之后的位置：套件在 `~/.claude/vibe-kit/`，路由的程序在 `~/.claude/vibe-kit/router/`，路由的数据（模型、key、用量）在 `~/.claude/vibe-kit/router-data/`。

## 钩子：什么时机做什么

| 时机 | 钩子 | 做什么 |
|---|---|---|
| 会话开始（新开、/clear、压缩后、恢复） | `session-start.js`（一直走命令） | 送项目说明、只读就绪摘要和壳子结构；压缩恢复时核对当前事实；不自动续接旧交接许可；记启动目录、核对套件指纹、清过期文件、数使用情况 |
| 用户开口 | `task-anchor.js`（一直走命令） | 打断后提醒刚才在做哪条指令；进行中的变更做到第几项；交接线；定"这一句算不算进了 OpenSpec 流程、在写提案还是做任务那一段"；开工时告诉用户全自动开没开（systemMessage）；进流程时先拉代码；约定和技能变了就把变了的部分带给模型；HTTP 钩子自检 |
| 改文件之前（Edit/Write/MultiEdit） | `pre-edit.js` | 依次跑五道检查：`guard-kit`（套件的文件不许改）→ `guard-vibe`（过程文件放 `.vibe/tmp`）→ `guard-output`（代码之外的产出放哪要先定）→ `guard-encoding`（会写坏中文的编辑）→ `guard-spec`（OpenSpec 产物的门槛、打勾前要跑过验法） |
| 跑命令之前（Bash/PowerShell） | `guard-commit.js` | 提交检查（信息格式、整仓 add、新文件没 add）、按提交方式（关 / 询问 / 自动）管提交、push 要用户当场说推送，内网发布单独确认、读令牌和 key 的拦下、改套件的命令拦下、cd 串命令拦下、起服务要走 devserver、归档门槛（含用户没说归档）；都过了再把 `openspec …` 改成调用自带的 OpenSpec（updatedInput） |
| 提问框、调技能和审查代理之前 | `guard-ask.js` | 提问始终允许；人工审查、自测先有明确要求；双自动且已探索、逐点审修、定稿提交后可衔接 apply，其余需要开工许可 |
| 搜文件内容之前（Grep） | `guard-read.js` | 搜的范围里有令牌、key 且要输出内容时拦下；IDEA 读取复用相同范围判断 |
| 工具成功或失败后 | `after-tool.js` | 核对实际完成结果；成功才登记验证证据和消费许可；失败或后台启动不算通过；IDEA 工具的返回原样给模型（2026-10-25 起不再遮口令） |
| 模型说做完了 | `verify-gate.js` | 自动阶段按产物或整组任务催审修，人工阶段 Ask；提醒提交与自动提交分开；核对材料、修订链和实际验证结果，交付用例及结果，用户决定验收归档 |

钩子的写法：每个文件导出 `handle(j)`，返回对象（JSON 输出）、字符串（原样输出，进模型的上下文）或 `null`（放行）。文件底部 `if (require.main === module) cli(handle)`，命令方式就是直接跑这个文件。拦截用 `lib/session.js` 的 `blockOut(event, reason)`，要用户确认用 `askOut(reason)`。

**HTTP 方式**：装了路由时，改文件、跑命令、提问框、搜文件、收工这五个高频钩子登记成 `type: "http"`，打到路由的 `/vibe-kit/hook/<名字>`，在路由的工作线程里跑（最多 3 个线程，一次几毫秒；命令方式一次 0.3 到 0.9 秒）。25 秒没结果当放行，记问题反馈，同线程排队的换线程重跑一次；例外：guard-commit 没跑成、命令里有 push / publish / 发布到 字样的回 ask（2026-10-30，push 只留钩子一道确认）。路由整个不在时 Claude Code 当放行，所以 HTTP 方式另登记命令钩子 `guard-push.js <端口>`，带 `if`（`Bash(*push*)` 等六条，实测见 claude-code-facts.md）：`/version` 不答话就自己跑一遍 guard-commit，出错回 ask。HTTP 钩子写 `timeout: 30`。用户开口时 `hook-health.js` 自检：上一轮改过文件、跑过命令，路由却没收到调用，就把路由拉起来，还不行就切回命令方式。开关 `hookTransport`。

**兜底放行**：流程类的检查拦下时，提示末尾带〔拦截编号〕。模型确信是套件拦错了，用 `tools/feedback.js bypass <编号> --why "…"` 申请，再做一次那一步时弹确认框（全自动模式下直接放行并记进报告）。改套件、读令牌、关钩子、结束路由、非 UTF-8 文件、整仓 add、push 没有编号，什么模式都不能放行。见 `lib/feedback.js` 开头。

## 库（kit/lib）

| 文件 | 管什么 |
|---|---|
| `session.js` | 公共入口：开关与封条、会话记录、变更、壳子、审查记账、阶段展示、真人动作和压缩窗口。状态锁、调用缓存、意图与范围指纹拆到专用模块，保持旧调用方接口 |
| `flow-policy.js` | 两阶段资格、逐产物与整组任务审查点、独立轮数与关联指纹、人工 Ask 去重、定稿后的 apply 衔接 |
| `openspec.js` | 套件自带的 OpenSpec（`kit/openspec/`，2026-10-17 集成）：能不能用（Node 版本）、把命令里的 `openspec` 改成调用自带的那份、项目没初始化时 `init --tools none`、安装时生成用户级 `/opsx:*` 命令和技能 |
| `feedback.js` | 问题反馈的记录（`~/.claude/vibe-kit/feedback/`），拦截编号和通行证，拦得最多的规矩、放行记录、开关改动记录 |
| `report.js` | 全自动模式的报告 |
| `lessons.js` | 经验规则：审查里反复出现的问题沉淀成 `.claude/rules/ttls-lessons-*.md` |
| `outputs.js` | 代码之外的产出位置 |
| `tidy.js` | `.vibe` 的整理和过程文件的清理 |
| `archive-extract.js` | 直接归档解包与查看结果落盘的目标检查，复用 guard-commit 的拆词和工作目录；只读查看放行，项目内临时条目放 `.vibe/tmp/<事由>/`，目录联接核对真实位置 |
| `onboard.js`、`discover.js` | 后台自动探索：认工程、推命令和端口、找开发环境的数据库和 redis 连接 |
| `drivers.js`、`toolstats.js` | 多版本驱动登记、默认和单版删除；查库、查 redis 的匿名类别计数 |
| `gitlab.js`、`updater.js`、`issues.js` | 内网 GitLab：自动更新、问题上报、导出议题、使用情况上报 |
| `usage.js` | 使用情况：每天数次数，第二天传到 GitLab |
| `pull.js` | 开工前拉代码 |
| `idea-mcp.js` | 撤回套件以前登记的 IDEA MCP（2026-10-28 起不再登记）：装新版、卸载时删掉套件加的、没被改过的 `vibe-idea-端口`；老版本代码调的 `due`、`sync` 留着（due 恒为假，sync 只撤回） |
| `idea-tools.js` | 用户自己登记的 IDEA MCP（名字 jetbrains、老的 vibe-idea-端口，或带 IDEA 特有工具名）的入口：终端按 Bash、改文件按 Edit、读令牌照拦；认不出是 IDEA 的 MCP 只查写明的路径读不读令牌 |
| `hook-host.js`、`hook-worker.js`、`hook-health.js` | HTTP 钩子：路由里跑钩子、自检 |

## 给模型看的东西（vibe-kit/claude）

- `CLAUDE.md`：全局约定的模板。里面的 `{{AUTO_COMMIT}}`、`{{AUTO_MODE}}` 这类占位由 `install.js` 的 `fill()` 按开关生成。生成后放在 `~/.claude/CLAUDE.md` 两行标记之间，每个请求都带着，所以要短。
- `rules/`：规范，启用的并进全局约定（`10-openspec.md`、`20-git-commit.md`）。文件名前加下划线就停用。
- `skills/`：六个技能，都带 `ttls-` 前缀：`ttls-onboard`、`ttls-see-page`、`ttls-cross-review`、`ttls-handover`、`ttls-db-crud`、`ttls-redis`。
- `agents/ttls-reviewer.md`：审查代理。审查提示第一行写"模式：提案 / 代码 / 复审提案 / 复审代码"，第二行统一写裸变更名（兼容目录、完整路径）；审查者最后一行写"结论：问题 N 条"，钩子靠这两处记账。前台结果和带 result 的后台通知都认，不存在的变更不借用材料里另一个变更。

## 模型路由（vibe-kit/router）

- `router.js`：本机常驻，按"角色"把请求分给各个模型（opus 主会话、sonnet 审查、haiku 后台小任务），限流先等再换、额度用完停用到重置时间、大请求超时不换模型、粘住同一个会话的模型（不破坏提示缓存）。只用 Node 自带模块。
- `service.js`：后台启动（没有窗口）、停止、登录后自启（"启动"文件夹里的 `.vbs`）。
- `ui.html` + `kit-api.js`（+ `kit-worker.js`）：本机配置页 `http://127.0.0.1:15730/ui`。只认本机连接、本机 Host，不收别的网站的页面发来的请求（按 Sec-Fetch-Site 认，`router.js` 的 `apiAllowed`），改东西还要带自定义请求头。开关只传改过的项，保存后跑一次 `install.js --sync` 让约定和钩子跟着变。
- 路由每 20 秒写一次 `router-data/usage-daily.json`、`usage-today.json`（状态栏第三行读后者）。

## 状态放在哪

IDEA MCP：2026-10-28 起套件不再登记、不再探测（用户定的）。`state/idea-mcp.json` 只剩以前登记时记下的归属（`owned`），装新版、卸载时 `idea-mcp.retract` 按它把套件加的、没被改过的 `vibe-idea-端口` 从 Claude Code 的用户配置（`.claude.json`，设了 `CLAUDE_CONFIG_DIR` 时是那个目录里的）删掉，删完状态记成 `off`；用户配置解析不了或正在变化就不改，归属留着下次再撤。`idea-mcp.lock` 防并发，异常遗留锁一分钟后可接手。不输出原始配置。

`guard-commit` 的匹配器有 `mcp__.*`。`idea-tools` 认 IDEA：名字 `jetbrains`、老的 `vibe-idea-端口`，或者工具名是 IDEA 特有的（`execute_terminal_command`、`get_file_text_by_path`、`replace_text_in_file` 这类）。认出来的：工具路由先解析为实际操作，终端经过 Bash 和 PowerShell 两种检查，所有路径字段、文件列表和项目路径调用 `guard-read`（读令牌、`.claude.json`），编辑类调用 `pre-edit`；别的不拦（2026-10-25 定的）。认不出的 MCP 只查写明的路径参数读不读令牌（套件不再记登记名，令牌保护不能因此放松）。`after-tool` 不改写 MCP 工具的返回。

| 东西 | 位置 |
|---|---|
| 开关 | `~/.claude/vibe-kit/config.json`（放松保护的三个开关另有封条 `state/config-seal.json`） |
| 本机环境（JDK、Maven、Tomcat） | `~/.claude/vibe-kit/local.json`，sync 后生成到全局约定的"本机环境"一节 |
| 小状态 | `~/.claude/vibe-kit/state/<名字>.json`。按会话的（`<会话>.json`、`<会话>-flow.json`（在不在流程里、写提案还是做任务）、`<会话>-auto-switch.json`（这个会话的自动模式开没开，用户敲 /vk-auto 时开口钩子写，2026-10-31 起替代配置里的两个自动开关）、`<会话>-report.json`……）过几天自动删；跨会话的名字在 `session.js` 的 `GLOBAL_STATE` 里，可以按时间清的固定名字在 `DISPOSABLE_STATE` 里。代码里每个固定名字都要落在这两份之一（`dev/test-auto-mode-kept.js` 扫代码查）：2026-10-30 以前迁移标记 `defaults-1017-migration` 两边都不在，3 天后被删，之后每次更新都把用户的开关改回默认 |
| 钩子流水账 | `state/hooks.log`（出问题先看它） |
| 问题反馈 | `~/.claude/vibe-kit/feedback/`（装新版、卸载都不删），对应的议题记在 `feedback/issues.json` |
| 安装清单 | `~/.claude/vibe-kit/installed.json`：套件往 settings.json 里加了什么，卸载时只收回这些 |
| 项目里的 | 子项目的 `.vibe/`（项目说明、交接记录、过程文件、报告），自动加进那个仓库的 `.gitignore`；经验规则 `.claude/rules/ttls-lessons-*.md` 跟着仓库提交 |

## 安装、更新、上报

- `install.js`：先检查后动手（settings.json 读不懂、全局 CLAUDE.md 不是 UTF-8 就什么都不动）；只往 `~/.claude` 里添加，覆盖前备份；`--sync` 只重新生成约定、重新登记钩子（配置页保存开关时调）；`--uninstall` 只收回自己加的。它替用户写进 settings.json 的 Claude Code 设置有三样，都跟着开关走、记在安装清单里：自动压缩窗口 `autoCompactWindow`、关自动记忆的环境变量、关自带自动模式的 `permissions.disableAutoMode`。
- 自动更新：团队的内网 GitLab 仓库里放着解开的安装包。钩子看一眼"该检查了没有"，该了就甩一个后台进程（`updater.js run`）：拉仓库、等路由空闲、跑新版的 `install.js`、自检，不过就装回上一版。
- 问题上报：本机记下的问题反馈由后台进程建成 GitLab 的议题，不重复建；使用情况一台电脑一条议题、一天一条补充。维护的那台电脑在配置页导出开放中的议题（浏览器下载），导出后关掉这一批。
- 发布：维护的人打包、解压，双击 `发布到 GitLab（双击我）.bat`（`publish.js`：先在本机装一遍、自检，再推一个提交加一个标签 `v<版本号>`）。

## 看页面（vibe-kit/kit/page）

立项时把浏览器验证分成四档（1 系统 Edge 无头命令行、2 Playwright 脚本、2.5 场景执行器、3 Playwright MCP 让模型直接驱动），套件带的是第 2 档和第 2.5 档：模型写场景文件、脚本执行（`scenario-run.js`，默认的验证通道），以及取布局树、像素比对（`layout-tree.js`、`pixel-diff.js`）。浏览器用系统自带的 Edge，不下载浏览器。还原设计稿靠数字对比，不靠让模型读截图。

## 1010 补充：许可、审查和合并 push

真实 AskUserQuestion 的答案配对给 lastUserVoice，包括两种前缀和结构化 answers；用户后发取消优先。confirmApply 在 apply 和打勾前补读开工答案，解决答案不触发 UserPromptSubmit 的状态遗漏。verify-gate 的 <会话>-plancommit 状态只去重该轮提案确认，新建未跟踪的产物也计算。

后台审查以真实启动调用登记 agentId，task-id 通知关联最近调用；通知没有 result 时只读启动结果登记的有限大小输出文件。SendMessage 只续已知审查代理，保留变更与模式；最新结论记账，相同通知去重。

推送（用户 2026-10-25、2026-10-28 定的）：用户当场说了"推送""push"（"合并推送"也算）就直接推，几笔都一样、每个仓库一次。`guard-commit.plainPush` 只核对参数和目标（当前分支推到它跟踪的远端分支，不要求工作区干净）；强推、删远端分支、推到别的分支、目标里有变量的弹确认。合并推送（预览、计划、合成一条，原来的 `merge-push.js`）2026-10-28 取消，装新版时删掉旧文件；用户自己说合并推送的（`intent.mergeIntent`），开口提示让 Claude 用 git 自己合，提交检查把合并时的重新提交算在这句话里；会话里留下的 `<sid>-push-preview` 不再读，随会话清理。

`proposal-files.js` 只检查四个产物引用的临时材料，以及变更内 assets/references 文件的存在、忽略规则和链接归属，不读取材料内容、不自动拷入秘密。guard-spec 查新改行；verify-gate 查触碰变更的完整产物；guard-commit 补查命令写入和暂存区，旧引用仍在 index 时不能提交。相对材料路径以变更目录为准，设计检查同时支持产物所在目录。

## 20261011 优化模块

`session.js` 逐步只保留公共入口，状态原子写与锁拆到 `state-store.js`，一次调用缓存拆到 `invocation.js`。`intent.js`、`apply-scope.js`、`permissions.js` 统一真人意图、范围和版本许可；`flowView` 供执行与展示共用。

`after-tool.js` 登记 PostToolUse 和 Failure，消费成功操作许可并采集本机证据；IDEA 结果仅适配已识别工具。`evidence.js`、`workspace.js` 计算当前输入与环境指纹。`task-types.js` 区分审查、意见处理和用户验收，不制造审查循环。

`review-runner.js` 与 `tools/review.js` 管有限材料、独立请求、超出预期用时的上报、取消与意见处理；`readiness.js`、`workflow.js` 提供就绪、交付、提交计划、自测和恢复事实；`work-sessions.js` 提示同变更冲突。`connection-lifecycle.js` 留无凭据退役记录；`redact.js` 统一诊断出口；`local-backup.js` 和 `entry-check.js` 管本地恢复与入口行为自检。

跨会话状态加入 GLOBAL_STATE：evidence、review-jobs、work-baselines、review-local-metrics、work-sessions、readiness、usage-device、devserver（2026-10-28，devserver 的全机服务登记：端口 → 项目里的记录文件、运行目录、命令；start 找不到同名记录时按运行目录和命令认出之前起的服务，status、stop、会话开始的提醒也看它）。许可仍按会话清理。使用情况按持久随机设备标识分组；旧议题复用编号并改名，历史补充保留。审查材料和诊断明细不上传，耗时仅留本机。用户可见行为以 vibe-kit/README.md 和 vibe-kit/手册/ 为准（开发流程.md、验收清单.md 2026-10-30 删了，用户定的）。

`state-store.atomicWrite` 写结构化对象，`atomicText` 写 Markdown 等原文；调用方检查保存结果。`workspace` 的相同只读 Git 查询只在一次钩子调用内复用，下一次调用重新核对。审查读材料前检查真实路径、文件类型和编码，范围外链接与未覆盖材料不会算作完整审查。

审查不限时（2026-10-28 用户定的）：每批都送完，配置页的 `reviewBudgetSeconds` 是预期用时，审完超了、有批次只回思考或没拿到结论，`reportReview` 记一条问题反馈（总用时、每批用时、重试、输出 token、停止原因、原因，不带材料原文）；`--new-budget` 不再需要。单批请求只有 30 分钟的保险（防本机路由整个没了）。不带变更名的审查（`.vibe/reviews/plain/code.json`）也能 `resolve` 登记决定，"接受"按项目目录核对用户许可（#234）。新的完整审查清除上一轮意见处理状态，修复意见须有当前版本的成功复验。零问题或仅驳回意见不能批准后来修改的代码。

本地恢复包只包含受管程序，清单记录文件哈希和目录集合；额外文件、敏感文件、目录链接、清单变化均使恢复包失效。新版失败优先使用可验证的本地上一版，保留原来的远端恢复政策。活进程锁不因续期丢失随机身份。

## 20261012 反馈修复

计划汇总改为只读；`refreshPlan(openspecDir, true)` 仅由显式 plan 工具和初始化调用，写回后随当前工作提交。全勾状态仍检查代码审查和意见处理，不表示用户已批准归档。

推送完成钩子、合并推送的分组和预览 2026-10-28 随合并推送一起取消。

`page/probe-run.js` 统一运行导出函数形式的页面探针，提供系统浏览器、断言和执行期限。父进程计时，脚本加载或执行卡住时结束进程树；浏览器关闭后才输出成功读值。临时目录链接不能指向项目外。Stop 与工具完成证据识别探针结果。待用户提交的新文件使用非阻塞 systemMessage；过程文件仍由既有检查处理。

`review.js diagnose` 只读会话尾部的兼容审查识别结果，不输出提示词或审查正文，不登记通过。原现场送达记录缺失时不能据此声称原问题已修。

## 20261013 反馈修复

`invocation` 为命令与 HTTP 钩子提供 12 秒检查预算和阶段标记；会话读取、Git、文件指纹及完成证据共用。HTTP 工作线程将阶段送给 host，25 秒兜底记录最后阶段并放行；反馈另有 3 秒记录预算，不能因检查预算已用完而漏掉错误。状态锁和不能静态判断的磁盘等待仍按原 fail-open。`tools/diagnose.js` 只读阶段、推送回执与钩子统计白名单。

`apply-scope` 绑定选中答案中的目标，缺目标时只取问题里的唯一变更或唯一当前变更。失效范围的产物修订清除旧实施范围并进入 plan/waiting=scope，保留开工答案指纹，防止重用；业务代码和打勾仍受当前许可约束。暂不提交记在会话 `-commit-declined`，同一输入不重复催问。

真人消息指纹由 `session.voiceKey` 统一计算，优先用消息 UUID，提问框缺 UUID 时用工具调用编号，旧记录再用时间与正文；不使用尾部截取后的相对位置。许可记录使用 `voiceSchema: 2`，开工范围对应 `applyVoiceSchema: 2` 和 `lastApplyAt`。升级旧许可保留消费状态，旧开工答案不重新授权，旧推送预览须重新生成。

审查材料按文件计上限，大文件按 40000 字符片段送出，全部片段成功后增加覆盖；4MB 以上、外部链接及不可读材料保留未覆盖。结果区分尝试、回复和成功批次，脱敏解析诊断仅存本机。兼容完成事件经 after-tool 登记；sync 扫描较大的有限会话尾部，只有可核对的完整结论记账。

人工放弃不再写 `review-waivers.json`、不标任务，也不算审查通过。旧文件只保留兼容读取，不再用于放行。resolve 的 accepted 表示用户明确接受某条问题，仍检查真人决定和输入版本。

## 两阶段审查状态（2026-10-14）

`flow-policy.js` 与 `session.flowView` 共用阶段计算。需求阶段先由 `workflow.js qualify` 核对描述、范围、验收、未决问题和真实探索记录；符合条件才启用需求自动。Apply 自动依赖当前实施范围许可；双自动的定稿提交可由策略生成当前范围许可，取消和需求变化仍使它失效。

跨会话 `review-points.json` 以变更目录和产物名／任务组编号为键：启动时计一轮，完成时记录状态、材料指纹、意见和本机报告路径。中断不退回轮数，分片不增加轮数。proposal/specs/design/tasks 各算一点，代码按完成的 1.x 组计算；上游文字或组内文件修改使关联结果失效。只有当前输入的完整零问题结果或有依据的逐条处理结果才结束该点；`review.js resolve --point` 只接受状态为 completed 的结果，失败、部分覆盖、超时、取消的结果不能处理成已结束。收工检查和提交检查对"审查没收尾"用同一口径：旧多轮记录未完成，或某个点审过之后输入变了还没复审完。

2026-10-17 起（审核报告问题 4—7）：轮数只数"审出问题、修了再审"这一串，上一轮零问题通过或已处理完的点因为输入变了重审时从 1 数起；记录带变更目录的创建时间 `born`，同名变更重建后旧记录不认；没有 1.1 编号的任务归到前一个有编号的组，开头就没编号的算第 1 组；所有组做完后，开工基线以来改过、没被任何一组点名的代码文件并成审查点 `group-rest`（有哪一组一个文件都没点名的，那一组本来就审全部改动，不设）。`review-points` 的条目和其他全局审查记录一样 60 天后清掉。

`flowView` 另给 `awaitingUser`：Apply 自动开着、任务都打勾且代码审查点都过了，就是等用户按验收用例自测（2026-10-17 起不再要求有一条没勾的用户验收任务）。此时自动不再生效（`effective` 为假），但 `verify-gate` 仍为本会话跑过的那一轮交一次全自动报告；交过之后不重复交，也不覆盖已接上的最后交代。

`workflow-v2-migration.json` 是一次安装迁移标记，关闭旧自动和两个新自动开关，不清理任务进度。`auto-session-migration.json` 是 2026-10-31 自动模式改成按会话开的迁移标记：配置里旧的两个自动开关清掉一次，当时在流程里的会话补一个会话开关；在 GLOBAL_STATE 里。`defaults-1017-migration.json` 是 1017 强制默认值的迁移标记；标记丢了、装之前的版本已经是 20261018.0051 或更新的，安装器补写标记、不再改配置。以上状态在 `GLOBAL_STATE` 中保留。开工范围（`<会话>-flow.json` 的 `applyScope`）记两个指纹：`hash` 是整套文档的（提案审查也用它），`req` 只算 proposal.md 和 specs；做任务时只有 `req` 变了才退回提案阶段，改 design、tasks 记进全自动报告（2026-10-30）。`<会话>-workflow-prompts.json` 只用于提示去重，随会话清理，不存放弃待办。人工模式的提示记 `{ sig: 内容指纹, turn: 用户消息编号 }`：同一个用户要求里不再问，只把指纹跟到最新；新要求时指纹变了才再问（2026-10-16）。不走 OpenSpec 的代码改动另记 `<会话>-plain-declined.json`（review、test 各一个时间）：用户答过不用的那一样，这个会话后面不再问（2026-10-30）。自动模式的提示仍按"指纹 + 轮数"记。人工模式问审查、自测时，`verify-gate` 另算"改了代码、最后一次修改后还没跑过快检"，成立就在同一问里加上要不要跑快检，只在真要发提示时才去查证据。完整流程图和验收用例见 [流程与验收依据](workflow-20261014.md)。

普通推送支持空远端及新分支（`-u` 照常放行）。放行额度按检查、目标和理由去重；重现信息另记最近版本和项目，最多保留二十条四千字补充。

下午清单补充：提案审查按 design 的 Context、现状、背景章节区分探索依据和实际文件材料。章节全文仍送审，探索路径列入结果 `contextOnly`；同一行明确“审查材料：”和随变更交付的 assets/references 文本仍读取。其它章节沿用当前引用，代码模式不缩小范围。`materialInputs` 保存实际读取的变更内 assets/references 文件、根目录和内容哈希，`proposalReviewed` 核对路径边界和内容，防止材料变了仍借旧结论；实施源码变化仍由代码审查核对，新审查清除旧材料记录。诊断与材料脱敏支持 JSON 字面值及转义引号。

## 自带的 OpenSpec 和提交方式（2026-10-17）

**自带的 OpenSpec**：安装包里带一份 OpenSpec（`kit/openspec/node_modules`，打包时的最新版）。安装器用它生成 `/opsx:explore、propose、new、continue、apply、verify、archive`（1.14.3 还会带上 `sync`）的命令和技能，装成用户级，清单 `installed.json` 的 `openspec` 记着装了哪些文件，卸载、换版本时按它收回。guard-commit 的 `handle` 先跑原有的全部检查（`check`），拦下、要问的照旧；放行的命令里以 `openspec` 开头的段，用 PreToolUse 的 `updatedInput` 改成 `node "<自带的 openspec.js>"`，项目还没有 `openspec/` 的先 `init --tools none`。Node 低于它要求的版本时 `usable()` 为假：不生成命令、不改写，用同事自己装的。使用统计由 settings.fragment.json 的 `OPENSPEC_TELEMETRY=0` 关掉。

**提交方式** `commitMode`（关 / 询问 / 自动，默认关，`session.commitModeOf`）替代以前的 `autoCommit`（只管 Apply 自动）和 `plainCommit`（不走 OpenSpec 的改动），人工和自动都用。guard-commit 的 `consentIssue` 管能不能提交：关——用户说了才提交；询问——用户在就让它问、自动模式下用户不在就不提交并记进报告；自动——做完一件完整的事（新勾完任务、审查修复收尾、需求文档四份定稿）才提交。verify-gate 收工时按同样三档提醒；需求文档四份都写完才提醒提交。

**需求文档一份一份来**：guard-spec 新建下一份产物前查上一份。自动模式要上一份审修过；人工模式要上一份最后一次写入之后用户说过话（停下给用户看过）。

## 1024 议题修复（2026-10-25）

核对和改法见 [feedback-20261024.md](feedback-20261024.md)。结构上的变化：

- **用户开口**：`session.voiceAt` 认单条记录是不是用户开口，`lastUserVoice` 取最后一次，`turnVoices` 取这一轮的原话加之后每个提问框答案。`userSaid` 对审查、自测往回看本轮（最后一次表态为准），归档、提交、推送仍只看最后一句；`userDeclined` 给收工检查认"这一轮最后说的是不审、不测"。提问框答案按 `answerSays` 判断（动作词不要求在句首、去掉"（推荐）"、问题里点了这件事时认"跑""重试""提""推"）。`intent` 加 `has`、`mentions`、`pushStyle`。
- **许可**：`<会话>-permissions.json` 的每个动作各自记 `voice`（以前整份一个，换一次开口就清掉别的动作）；提交、推送同一句可用在几个仓库上，每个仓库一次，点了子项目名的只用在点名的；"改完然后提交"开口时不登记版本。
- **开工**：`apply-scope.grant` 多认技能参数、模型刚才那段话（`session.saidBefore`）、这一步要改的变更或文件；认不下来把原因记进流程状态的 `applyRefused`（绑定那次开口），`refusal()` 给拦截提示用。`confirmApply` 在旧开工范围失效时也能凭新答案重新开工，pre-edit 拦业务代码前先补读。
- **收工检查**：只认 openspec 命令（status、instructions、new、archive……）里点名的变更算"在做"；人工提示按每一份文档最后写入时间和用户表态时间比，不审之后没再改的不再问。
- **审查执行器**：输出上限 16000，只回思考、停在上限的同一批 32000、加"少想"再试，还不行拆成两半各审一次（2026-10-28，#226）；诊断记 `stopReason`、`outputTokens`、`model`，没结论时结果带 `hint`。`--base` 可写几次（`仓库=提交`），未跟踪文件只送基线之后改过的（结果的 `excluded` 记跳过了几个），不带变更名的审查按基线分开记。
- **指纹**：没改过的已跟踪文件直接用 `ls-files -s` 的哈希，链接（120000）和子模块（160000）照旧逐个核对；阶段名带仓库名。工作线程载入钩子模块放到预算外。
