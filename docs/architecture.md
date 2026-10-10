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
| 会话开始（新开、/clear、压缩后、恢复） | `session-start.js`（一直走命令） | 把项目说明、交接记录、壳子结构交给模型；记下会话的启动目录；套件代码的指纹对不对；清过期的过程文件；数使用情况 |
| 用户开口 | `task-anchor.js`（一直走命令） | 打断后提醒刚才在做哪条指令；进行中的变更做到第几项；交接线；定"这一句算不算进了 OpenSpec 流程、在写提案还是做任务那一段"；开工时告诉用户全自动开没开（systemMessage）；进流程时先拉代码；约定和技能变了就把变了的部分带给模型；HTTP 钩子自检 |
| 改文件之前（Edit/Write/MultiEdit） | `pre-edit.js` | 依次跑五道检查：`guard-kit`（套件的文件不许改）→ `guard-vibe`（过程文件放 `.vibe/tmp`）→ `guard-output`（代码之外的产出放哪要先定）→ `guard-encoding`（会写坏中文的编辑）→ `guard-spec`（OpenSpec 产物的门槛、打勾前要跑过验法） |
| 跑命令之前（Bash/PowerShell） | `guard-commit.js` | 提交检查（信息格式、整仓 add、新文件没 add、像密码的内容）、push 没当场授权就确认，内网发布单独确认、读令牌和 key 的拦下、改套件的命令拦下、cd 串命令拦下、起服务要走 devserver、归档门槛（含用户没说归档）、不走 OpenSpec 的提交要用户点头 |
| 提问框、调技能之前 | `guard-ask.js` | 全自动模式下拦提问框，问题记进报告；模型自己调 OpenSpec 技能时算进流程（propose 算写提案那一段，archive 算做任务那一段）；用户没说开工就调 /opsx:apply 拦下 |
| 搜文件内容之前（Grep） | `guard-read.js` | 搜的范围里有放令牌、key 的地方，而且要把内容搜出来的，拦下 |
| 模型说做完了 | `verify-gate.js` | 改了代码要验证、改了页面要看页面、任务全打勾要审代码、改了的文件要提交、改了产物要记修订、到交接线问要不要交接；全自动模式下催着往下做（不催归档）、收工时出报告；提案阶段、审查没审完不催提交；变更都归档了记成出流程 |

钩子的写法：每个文件导出 `handle(j)`，返回对象（JSON 输出）、字符串（原样输出，进模型的上下文）或 `null`（放行）。文件底部 `if (require.main === module) cli(handle)`，命令方式就是直接跑这个文件。拦截用 `lib/session.js` 的 `blockOut(event, reason)`，要用户确认用 `askOut(reason)`。

**HTTP 方式**：装了路由时，改文件、跑命令、提问框、搜文件、收工这五个高频钩子登记成 `type: "http"`，打到路由的 `/vibe-kit/hook/<名字>`，在路由的工作线程里跑（最多 3 个线程，一次几毫秒；命令方式一次 0.3 到 0.9 秒）。25 秒没结果当放行。用户开口时 `hook-health.js` 自检：上一轮改过文件、跑过命令，路由却没收到调用，就把路由拉起来，还不行就切回命令方式。开关 `hookTransport`。

**兜底放行**：流程类的检查拦下时，提示末尾带〔拦截编号〕。模型确信是套件拦错了，用 `tools/feedback.js bypass <编号> --why "…"` 申请，再做一次那一步时弹确认框（全自动模式下直接放行并记进报告）。改套件、读令牌、关钩子、结束路由、非 UTF-8 文件、整仓 add、push 没有编号，什么模式都不能放行。见 `lib/feedback.js` 开头。

## 库（kit/lib）

| 文件 | 管什么 |
|---|---|
| `session.js` | 最底层的公共库：读开关（`readConfig`，带放松保护的开关的封条校验）、读写状态文件、读会话记录、找 OpenSpec 变更、壳子识别、审查记账、全自动模式的"在不在流程里、在写提案还是做任务那一段"、用户最后一句话（归档、提交要他点头）、自动压缩窗口的算法。别的库都依赖它，它不依赖别人 |
| `feedback.js` | 问题反馈的记录（`~/.claude/vibe-kit/feedback/`），拦截编号和通行证，拦得最多的规矩、放行记录、开关改动记录 |
| `report.js` | 全自动模式的报告 |
| `lessons.js` | 经验规则：审查里反复出现的问题沉淀成 `.claude/rules/ttls-lessons-*.md` |
| `outputs.js` | 代码之外的产出位置 |
| `tidy.js` | `.vibe` 的整理和过程文件的清理 |
| `onboard.js`、`discover.js` | 后台自动探索：认工程、推命令和端口、找开发环境的数据库和 redis 连接 |
| `drivers.js`、`toolstats.js` | 多版本驱动登记、默认和单版删除；查库、查 redis 的匿名类别计数 |
| `gitlab.js`、`updater.js`、`issues.js` | 内网 GitLab：自动更新、问题上报、导出议题、使用情况上报 |
| `usage.js` | 使用情况：每天数次数，第二天传到 GitLab |
| `pull.js` | 开工前拉代码 |
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

`merge-push.js` 库核对远端与线性本地历史，按确定事件分组，独立 index 重建并比 tree，备份 ref 后原子更新当前分支，再普通 push。工具计划在项目 `.vibe/tmp/merge-push/`，不是跨会话套件状态；guard-commit 只接受最新真人“合并push”的专门授权。它不修改已推送历史。

`proposal-files.js` 只检查四个产物引用的临时材料，以及变更内 assets/references 文件的存在、忽略规则和链接归属，不读取材料内容、不自动拷入秘密。guard-spec 查新改行；verify-gate 查触碰变更的完整产物；guard-commit 补查命令写入和暂存区，旧引用仍在 index 时不能提交。相对材料路径以变更目录为准，设计检查同时支持产物所在目录。
