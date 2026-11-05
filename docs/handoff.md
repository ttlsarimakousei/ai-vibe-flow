# 交接：现在的状态

更新于 2026-11-05 晚上。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

下一步两件事（第 71 条原话）：能用脚本的不请求模型；审查提速。内网两台电脑的报告回来了，核对和方案在 [feedback-20261105-3.md](feedback-20261105-3.md)：审查慢在子代理每一步的思考，两台复现；effort 没效果。等仓库主人定"要定的"四条。套件代码还没动。内网报告带内网路径，不进仓库。

## 最近一次发版

20261105.1915，已推到 GitHub（main 和标签 v20261105.1915），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages（4.8 MB）。和 1257 比：第 59—70 条，[feedback-20261105-2.md](feedback-20261105-2.md)，复审 [第 59—63 条](../reviews/claude/20261105-第59至63条-复审.md)、[第 64—69 条](../reviews/claude/20261105-第64至70条-复审.md)（第 70 条没复审）。

全量回归（`--since v20261105.1257`，没动过的独立模块没测）120 套 6944 项，1 项不过：`test-feedback1013-context` 抓到 design 现状里的探索路径算进了审查涉及的目录，修了（提交"design 现状里列的探索路径"那条），之后重跑受影响的 6 套和三个版本的审查子代理端到端都过，没有再跑一遍全量。从 2337、1257 验收升级各 33 项过。

## 待仓库主人做的

- 内网 GitLab 发布 20261105.1915：解压包，在包目录里跑 `node publish.js --now`（要马上装；不加等 24 小时）。
- 发布后实际跑一次确认：开着 `/vk-auto` 写到 tasks 自动审；审查用时（第 64 条，backlog 里证据不足）；工具结果写"Spawned successfully … mailbox"的环境里子代理的结论交不交得上（只用构造的文本测过）。
- 第 66 条子代理的名字是猜的（原话没说完），确认一下。
- 内网网关认 `claude-sonnet-5`、`claude-sonnet-5-5`（2.1.263、2.1.316 跑过）；2.1.120 的 `claude-sonnet-4-6` 还没确认。

## 要注意的

- 审查点：`flow-policy.js` 的 `points` 只有必审的（`tasks`、`change`、`cross-*`），`written` 是写好了哪几份，`reviewable` 加上用户点名才审的单份文档和组。`change` 的指纹分"文档和任务 : 代码"两段，后面的变更开工了只比前一段（`sameInput`）。
- 基线记真正开工那一刻，大任务只记现在要做的 change（`apply-scope.grant`）；`change` 审查不送"开工前就有改动、开工后没动过"的文件。
- 子代理死活：`sweep` 按工具结果认结束（`launchedText`），`heartbeat` 记子代理跑 Bash、Grep 的动静，半小时没动静才算没交；上一轮还有活的，`prepare` 返回 `running`。`stale` 也写快照，第二轮只审改过的。
- 审查的边界（第 64、70 条）：`review-scope.js` 的 `lensesFor`（按 `reviewSmallChars` 定 1～3 个）、`SCOPE_NOTE`，`review-runner.js` 的 `areasOf`、`pathFacts`，`vk-reviewer.md` 的"只审这次需求"。都是给模型的要求，它读文件钩子拦不到。测试支架默认 `reviewSmallChars: 0`（不分大小）。
- 开着 `/vk-auto`：开始写文档以后只有探索记录里真有没定的才不生效（`session-flow.flowView`、`big-task.exploreOpen`），插话不取消；在流程里审查不用先问（`flow-policy.actionIssue`）。
- `keepCurrent`：`/vk-resume` 切到全勾完的 change，算在做它，等用户说下一步。`oldDone`：这个会话碰它之前就勾完的 change，只改文档不催审；接回不算碰过。
- 补录和归属：`lib/plan-link.js` 只给线索，`plan.js link` 才写；问过的记在 `state/plan-link.json`。`planAddUnlisted` 不再并进全部归档的大任务。
- 新测试文件要跑 `node dev/contracts.js --write`，加进 `dev/run-all.js` 的 suites。新测试里别写旧名字 `ttls-`，残留扫描会报。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`，用 Write 写成文件再跑；Bash 里不要 `cd`。`.bat` 按字节改。"桌面没冒窗口"那项偶尔不过（今天在两套端到端上各一次，重跑都过），原因没查，重跑确认。
- 钩子出错放行会藏住"名字没定义"：改了钩子入口要跑真 CLI（`dev/probes/cc-vk-config.js`、`cc-vk-resume.js`，Git Bash 下参数写 `//vk-…`）。
- OpenSpec 1.16.0 要 Node 22.12，仓库主人定了先不升。
- 测试里拿旧版比：`dev/baseline/20261105.1915/vibe-kit`（最新）。`hooks/` 下的文件不能删。这台电脑没装 vibe-kit。系统临时目录里有 11-04 留下的 `vkt-*` 目录，要清的话仓库主人自己删。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
