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
| 跑命令之前（Bash/PowerShell） | `guard-commit.js` | 提交检查（信息格式、整仓 add、新文件没 add、像密码的内容）、push 核对预览后的真人确认，内网发布单独确认、读令牌和 key 的拦下、改套件的命令拦下、cd 串命令拦下、起服务要走 devserver、归档门槛（含用户没说归档）、不走 OpenSpec 的提交要用户点头 |
| 提问框、调技能和审查代理之前 | `guard-ask.js` | 提问始终允许；人工审查、自测先有明确要求；双自动且已探索、逐点审修、定稿提交后可衔接 apply，其余需要开工许可 |
| 搜文件内容之前（Grep） | `guard-read.js` | 搜的范围里有令牌、key 且要输出内容时拦下；IDEA 读取复用相同范围判断 |
| 工具成功或失败后 | `after-tool.js` | 核对实际完成结果；成功才登记验证证据、推送预览和消费许可；失败或后台启动不算通过；已适配 IDEA 完成输出先遮盖凭据 |
| 模型说做完了 | `verify-gate.js` | 自动阶段按产物或整组任务催审修，人工阶段 Ask；提醒提交与自动提交分开；核对材料、修订链和实际验证结果，交付用例及结果，用户决定验收归档 |

钩子的写法：每个文件导出 `handle(j)`，返回对象（JSON 输出）、字符串（原样输出，进模型的上下文）或 `null`（放行）。文件底部 `if (require.main === module) cli(handle)`，命令方式就是直接跑这个文件。拦截用 `lib/session.js` 的 `blockOut(event, reason)`，要用户确认用 `askOut(reason)`。

**HTTP 方式**：装了路由时，改文件、跑命令、提问框、搜文件、收工这五个高频钩子登记成 `type: "http"`，打到路由的 `/vibe-kit/hook/<名字>`，在路由的工作线程里跑（最多 3 个线程，一次几毫秒；命令方式一次 0.3 到 0.9 秒）。25 秒没结果当放行。用户开口时 `hook-health.js` 自检：上一轮改过文件、跑过命令，路由却没收到调用，就把路由拉起来，还不行就切回命令方式。开关 `hookTransport`。

**兜底放行**：流程类的检查拦下时，提示末尾带〔拦截编号〕。模型确信是套件拦错了，用 `tools/feedback.js bypass <编号> --why "…"` 申请，再做一次那一步时弹确认框（全自动模式下直接放行并记进报告）。改套件、读令牌、关钩子、结束路由、非 UTF-8 文件、整仓 add、push 没有编号，什么模式都不能放行。见 `lib/feedback.js` 开头。

## 库（kit/lib）

| 文件 | 管什么 |
|---|---|
| `session.js` | 公共入口：开关与封条、会话记录、变更、壳子、审查记账、阶段展示、真人动作和压缩窗口。状态锁、调用缓存、意图与范围指纹拆到专用模块，保持旧调用方接口 |
| `flow-policy.js` | 两阶段资格、逐产物与整组任务审查点、独立轮数与关联指纹、人工 Ask 去重、定稿后的 apply 衔接 |
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
| `idea-mcp.js` | 本机 IDEA MCP 身份核验和用户级登记；安装、同步、后台更新共用；只管理自己加的连接 |
| `idea-tools.js` | IDEA 直接工具和工具路由的入口适配；复用终端、读文件、单文件编辑的既有保护；未适配的脚本和数据库入口拦下 |
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

IDEA MCP 的归属、检查时间和连接状态存在 `state/idea-mcp.json`，属于跨会话状态。`idea-mcp.lock` 防止同一份套件并发登记，异常遗留锁一分钟后可接手。Claude Code MCP 写在用户目录的 `.claude.json`；显式设置 `CLAUDE_CONFIG_DIR` 时写该目录内部的 `.claude.json`。首次选定的位置保存在归属状态里，后台安装器传配置目录时仍沿用。修改前重新读最新内容，临时文件替换前再次比较原文；无法解析或发现并发变化就保留原文件，状态只返回固定原因，不输出原始配置。

安装器和 `--sync` 检查已开启的 IDEA 本机 HTTP MCP；`updater.kick/run` 每五分钟最多触发一次后台检查，更新和上报关闭也照常检查。配置页只展示状态白名单，手动检测由子进程执行，不阻塞路由。只发握手和工具列表请求，不执行项目操作；只探测回环地址，有端口、超时和回复大小上限。IDEA 自身的开关、客户端工具审批、项目运行策略保持各自现有约定。

未安装 IDEA 或未启用 MCP 时，不为这项检测启动后台进程。已有自有登记仍会定期核对。`guard-commit` 的匹配器增加 `mcp__.*`，由 `idea-tools` 识别自有或已发现的 IDEA 登记名及 `jetbrains`；其它 MCP 放行。工具路由先解析为实际操作，终端经过 Bash 和 PowerShell 两种检查，读取和索引调用 `guard-read`，可还原文本的单文件编辑调用 `pre-edit`。必须明确项目路径；脚本、表达式、批量补丁、运行参数覆盖和数据库入口不复用。该适配不改变 `verify-gate` 的验证记账。

关闭接入开关但还有自有登记时，后台保留撤回重试；全部撤回后不再为这项功能启动进程。卸载遇到无法解析的客户端配置会提示连接未撤回，不输出原始配置。

| 东西 | 位置 |
|---|---|
| 开关 | `~/.claude/vibe-kit/config.json`（放松保护的三个开关另有封条 `state/config-seal.json`） |
| 本机环境（JDK、Maven、Tomcat） | `~/.claude/vibe-kit/local.json`，sync 后生成到全局约定的"本机环境"一节 |
| 小状态 | `~/.claude/vibe-kit/state/<名字>.json`。按会话的（`<会话>.json`、`<会话>-flow.json`（在不在流程里、写提案还是做任务）、`<会话>-report.json`……）过几天自动删；跨会话的名字在 `session.js` 的 `GLOBAL_STATE` 里 |
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

`merge-push.js` 在普通 push 指令时也核对远端并生成预览，按确定事件分组。`after-tool` 只有成功生成实际计划才写会话 `<sid>-push-preview`；`guard-commit` 核对预览后另一条真人确认、计划编号及当前目标指纹。独立 index 重建并比 tree，备份 ref 后原子更新当前分支，再普通 push。含 merge、签名或标签时保留原历史。计划在项目 `.vibe/tmp/merge-push/`，会话预览凭据按会话清理，不恢复跨会话许可；它不修改已推送历史。

`proposal-files.js` 只检查四个产物引用的临时材料，以及变更内 assets/references 文件的存在、忽略规则和链接归属，不读取材料内容、不自动拷入秘密。guard-spec 查新改行；verify-gate 查触碰变更的完整产物；guard-commit 补查命令写入和暂存区，旧引用仍在 index 时不能提交。相对材料路径以变更目录为准，设计检查同时支持产物所在目录。

## 20261011 优化模块

`session.js` 逐步只保留公共入口，状态原子写与锁拆到 `state-store.js`，一次调用缓存拆到 `invocation.js`。`intent.js`、`apply-scope.js`、`permissions.js` 统一真人意图、范围和版本许可；`flowView` 供执行与展示共用。

`after-tool.js` 登记 PostToolUse 和 Failure，消费成功操作许可并采集本机证据；IDEA 结果仅适配已识别工具。`evidence.js`、`workspace.js` 计算当前输入与环境指纹。`task-types.js` 区分审查、意见处理和用户验收，不制造审查循环。

`review-runner.js` 与 `tools/review.js` 管有限材料、独立请求、总预算、取消与意见处理；`readiness.js`、`workflow.js` 提供就绪、交付、提交计划、自测和恢复事实；`work-sessions.js` 提示同变更冲突。`connection-lifecycle.js` 留无凭据退役记录；`redact.js` 统一诊断出口；`local-backup.js` 和 `entry-check.js` 管本地恢复与入口行为自检。

跨会话状态加入 GLOBAL_STATE：evidence、review-jobs、work-baselines、review-local-metrics、work-sessions、readiness、usage-device。许可仍按会话清理。使用情况按持久随机设备标识分组；旧议题复用编号并改名，历史补充保留。审查材料和诊断明细不上传，耗时仅留本机。用户可见行为以 vibe-kit/开发流程.md 为准，旧表中的自动交接和 archive 算 apply 已被这版替代。

`state-store.atomicWrite` 写结构化对象，`atomicText` 写 Markdown 等原文；调用方检查保存结果。`workspace` 的相同只读 Git 查询只在一次钩子调用内复用，下一次调用重新核对。审查读材料前检查真实路径、文件类型和编码，范围外链接与未覆盖材料不会算作完整审查。

审查重开预算的许可在本次启动时消费，失败或取消也不能反复重用；已用时间跨重试累计。新的完整审查清除上一轮意见处理状态，修复意见须有当前版本的成功复验。零问题或仅驳回意见不能批准后来修改的代码。

本地恢复包只包含受管程序，清单记录文件哈希和目录集合；额外文件、敏感文件、目录链接、清单变化均使恢复包失效。新版失败优先使用可验证的本地上一版，保留原来的远端恢复政策。活进程锁不因续期丢失随机身份。

## 20261012 反馈修复

计划汇总改为只读；`refreshPlan(openspecDir, true)` 仅由显式 plan 工具和初始化调用，写回后随当前工作提交。全勾状态仍检查代码审查和意见处理，不表示用户已批准归档。

推送完成钩子支持保留完整 JSON 的只读管道，拒绝静默漏登记；执行钩子在 8 秒 Git 总预算内检查分支、工作区、远端配置和提交端点，完整历史检查留在 CLI 执行前。提交对象不变时无需在每次钩子里重复读取每个提交。分组结果带 reason，明确点名的文档修订可包含 docs/ 和 plan.md，未知归属仍保留。

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

跨会话 `review-points.json` 以变更目录和产物名／任务组编号为键：启动时计一轮，完成时记录状态、材料指纹、意见和本机报告路径。中断不退回轮数，分片不增加轮数。proposal/specs/design/tasks 各算一点，代码按完成的 1.x 组计算；上游文字或组内文件修改使关联结果失效。只有当前输入的完整零问题结果或有依据的逐条处理结果才结束该点。

`workflow-v2-migration.json` 是一次安装迁移标记，关闭旧自动和两个新自动开关，不清理任务进度。以上两类状态在 `GLOBAL_STATE` 中保留。`<会话>-workflow-prompts.json` 只用于同输入提示去重，随会话清理，不存放弃待办。完整流程图和验收用例见 [流程与验收依据](workflow-20261014.md)。

推送 state 支持空远端及新分支，首次保留本地历史；仅一笔且目标可确定的普通 push 可使用真人许可，预览中需整理历史的仍另行确认。反馈正文不参与 apply 命令判断。放行额度按检查、目标和理由去重；重现信息另记最近版本和项目，最多保留二十条四千字补充。

下午清单补充：提案审查按 design 的 Context、现状、背景章节区分探索依据和实际文件材料。章节全文仍送审，探索路径列入结果 `contextOnly`；同一行明确“审查材料：”和随变更交付的 assets/references 文本仍读取。其它章节沿用当前引用，代码模式不缩小范围。`materialInputs` 保存实际读取的变更内 assets/references 文件、根目录和内容哈希，`proposalReviewed` 核对路径边界和内容，防止材料变了仍借旧结论；实施源码变化仍由代码审查核对，新审查清除旧材料记录。诊断与材料脱敏支持 JSON 字面值及转义引号。
