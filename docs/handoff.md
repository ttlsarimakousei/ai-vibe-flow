# 交接：现在的状态

更新于 2026-11-06 凌晨。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

第 71 条的第 1 点（能用脚本的不请求模型）这版没做，仓库主人说先不看。方案和数字在 [feedback-20261105-3.md](feedback-20261105-3.md)：读代码占主会话请求 40—43%，压缩窗口是最大的 token 杠杆。内网报告带内网路径，不进仓库。

## 最近一次发版

20261106.0234，已推到 GitHub（main 和标签 v20261106.0234），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。和 0052 比（第 73 条，[feedback-20261105-3.md](feedback-20261105-3.md)）：`claude -p` 不连 MCP、不带全局约定、少一个请求，角度数按差异算；子代理代码删了；升级时清残留。上一版 0052（第 72 条）审查改成 `claude -p`。**这两版都没做别的模型复审，代码审查的质量对比没做完，真网关没跑过**，仓库主人定的先发。

全量回归（`--since v20261106.0052`）121 套 6987 项全过。从 1915、0052 验收升级各 33 项过。

## 待仓库主人做的

- 内网 GitLab 发布 20261106.0234：解压包，在包目录里跑 `node publish.js --now`（要马上装；不加等 24 小时）。
- 发布后实际审一次，看用时、问题数，审查记录里每轮写了 token；`claude` 在同事电脑上找不找得到（先用 `CLAUDE_CODE_EXECPATH`，没有就找命令行的 `claude`）。
- 内网网关认 `claude-sonnet-5`、`claude-sonnet-5-5`（2.1.263、2.1.316 跑过）；2.1.120 的 `claude-sonnet-4-6` 还没确认。

## 要注意的

- 审查点：`flow-policy.js` 的 `points` 只有必审的（`tasks`、`change`、`cross-*`），`written` 是写好了哪几份，`reviewable` 加上用户点名才审的单份文档和组。`change` 的指纹分"文档和任务 : 代码"两段，后面的变更开工了只比前一段（`sameInput`）。
- 基线记真正开工那一刻，大任务只记现在要做的 change（`apply-scope.grant`）；`change` 审查不送"开工前就有改动、开工后没动过"的文件。
- 审查（第 72、73 条）：`review.js run` → `review-runner.run`：`prepare` 备材料和提示（`<角度>.prompt.md`），每个角度一个后台进程 `review.js worker` 跑 `claude -p`（`--tools ""`、`--strict-mcp-config`、`disableAllHooks`、`CLAUDE_CODE_DISABLE_CLAUDE_MDS`），交齐 `finish` 入账（只让一个进程做）。最多等 9 分钟，返回 `running` 再跑一次。`guard-commit` 把 timeout 改成 10 分钟。测试支架默认 `VIBE_KIT_REVIEW_NO_RUN=1`（只备材料），`VIBE_KIT_CLAUDE_EXE` 指定 claude。
- `review-stop.js` 是空壳。两次代码审查的范围文件没列代码文件的疑点还没查（`materials` 基线之后没改动时只剩文档，也不报错），见未结清单。升级残留用 `dev/probes/upgrade-residue.js` 查。
- 审查的边界（第 64、70 条）：`review-scope.js` 的 `lensesFor`（按 `reviewSmallChars` 定 1～3 个）、`SCOPE_NOTE`，`review-runner.js` 的 `areasOf`、`pathFacts`，`kit/review-prompt.md`，`review-facts.js`。测试支架默认 `reviewSmallChars: 0`（不分大小）。
- 开着 `/vk-auto`：开始写文档以后只有探索记录里真有没定的才不生效（`session-flow.flowView`、`big-task.exploreOpen`），插话不取消；在流程里审查不用先问（`flow-policy.actionIssue`）。
- `keepCurrent`：`/vk-resume` 切到全勾完的 change，算在做它，等用户说下一步。`oldDone`：这个会话碰它之前就勾完的 change，只改文档不催审；接回不算碰过。
- 补录和归属：`lib/plan-link.js` 只给线索，`plan.js link` 才写；问过的记在 `state/plan-link.json`。`planAddUnlisted` 不再并进全部归档的大任务。
- 新测试文件要跑 `node dev/contracts.js --write`，加进 `dev/run-all.js` 的 suites。新测试里别写旧名字 `ttls-`，残留扫描会报。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`，用 Write 写成文件再跑；Bash 里不要 `cd`。`.bat` 按字节改。"桌面没冒窗口"那项偶尔不过（今天在两套端到端上各一次，重跑都过），原因没查，重跑确认。
- 钩子出错放行会藏住"名字没定义"：改了钩子入口要跑真 CLI（`dev/probes/cc-vk-config.js`、`cc-vk-resume.js`，Git Bash 下参数写 `//vk-…`）。
- OpenSpec 1.16.0 要 Node 22.12，仓库主人定了先不升。
- 测试里拿旧版比：`dev/baseline/20261106.0234/vibe-kit`（最新）。`hooks/` 下的文件不能删。这台电脑没装 vibe-kit。系统临时目录里有 11-04 留下的 `vkt-*` 目录，要清的话仓库主人自己删。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
