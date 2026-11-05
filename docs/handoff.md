# 交接：现在的状态

更新于 2026-11-05 晚上。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261105.1257，已推到 GitHub（main 和标签 v20261105.1257），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。审查时机放宽（第 57、58 条，[feedback-20261105.md](feedback-20261105.md)）。

## 发版之后提交了、还没发的

第 59—70 条，[feedback-20261105-2.md](feedback-20261105-2.md)，复审 [reviews/claude/20261105-第59至63条-复审.md](../reviews/claude/20261105-第59至63条-复审.md)。1257 上开着 `/vk-auto` 会被拦下"看一看"、写完四份还问要不要审（第 67、68 条），要发一版才解决。更新说明里写的是 `@@VER@@`。跑过相关测试和一个版本的端到端，没跑全量。

第 68 条的条件：`plan.md` 那一节少"探索记录："一行（老任务）、"还没定的"写成"（无）"，仓库主人的两份记录（桌面）里都有。第 59 条根因是工具结果写"Spawned successfully"，`sweep` 认不出。这种"mailbox"模式下 SubagentStop 交不交得上结论没实测，发版后要他实际跑一次确认。

## 待仓库主人做的

- 第 66 条子代理的名字是猜的（原话没说完），确认一下。第 64 条省了多少时间要实际跑了才知道。
- 定要不要发版。发了要在内网 GitLab 发布：解压包，在包目录里跑 `node publish.js --now`。

## 要注意的

- 审查点：`flow-policy.js` 的 `points` 只有必审的（`tasks`、`change`、`cross-*`），`written` 是写好了哪几份，`reviewable` 加上用户点名才审的单份文档和组。`change` 的指纹分"文档和任务 : 代码"两段，后面的变更开工了只比前一段（`sameInput`）。
- 基线记真正开工那一刻，大任务只记现在要做的 change（`apply-scope.grant`）；`change` 审查不送"开工前就有改动、开工后没动过"的文件。
- 子代理死活按心跳（`review-runner.heartbeat`，子代理跑 Bash、Grep 时记），半小时没动静才算没交；上一轮还有活的，`prepare` 返回 `running`。
- 开着 `/vk-auto`：开始写文档以后只有探索记录里真有没定的才不生效（`session-flow.flowView`、`big-task.exploreOpen`），插话不取消；在流程里审查不用先问（`flow-policy.actionIssue`）。
- `keepCurrent`：`/vk-resume` 切到全勾完的 change，算在做它，等用户说下一步。
- 补录和归属：`lib/plan-link.js` 只给线索，`plan.js link` 才写；问过的记在 `state/plan-link.json`。`planAddUnlisted` 不再并进全部归档的大任务。
- 审查代理 `model: sonnet`。没设 `ANTHROPIC_DEFAULT_SONNET_MODEL` 时 2.1.120 发 `claude-sonnet-4-6`，2.1.259 发 `claude-sonnet-5`，2.1.289 发 `claude-sonnet-5-5`；仓库主人说内网网关认。
- `oldDone`：这个会话碰它之前就勾完的 change，只改文档不催审（第 69 条）；接回不算碰过。
- 审查的边界（第 70 条）：`review-scope.js` 的 `lensesFor`、`SCOPE_NOTE`，`review-runner.js` 的 `areasOf`、`pathFacts`，`vk-reviewer.md` 的"只审这次需求"。都是给模型的要求。
- 新测试文件要跑 `node dev/contracts.js --write`，加进 `dev/run-all.js` 的 suites。新测试里别写旧名字 `ttls-`，残留扫描会报。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`，用 Write 写成文件再跑；Bash 里不要 `cd`。`.bat` 按字节改。全量跑着的时候别的终端、窗口可能让"桌面没冒窗口"那项偶尔不过，重跑确认。
- 钩子出错放行会藏住"名字没定义"：改了钩子入口要跑真 CLI（`dev/probes/cc-vk-config.js`、`cc-vk-resume.js`，Git Bash 下参数写 `//vk-…`）。
- OpenSpec 1.16.0 要 Node 22.12，仓库主人定了先不升。
- 测试里拿旧版比：`dev/baseline/20261105.1257/vibe-kit`（最新）。`hooks/` 下的文件不能删。这台电脑没装 vibe-kit。系统临时目录里有 11-04 留下的 `vkt-*` 目录，要清的话仓库主人自己删。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
