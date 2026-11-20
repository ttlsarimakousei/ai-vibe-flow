# 交接：现在的状态

更新于 2026-11-20。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

问题表第 92—94 条（仓库主人 11-20 提的、说了现在做）做完了：代码、测试、文档提交推送（cfb1c1b、ab0e609、bf8ec6c、e575b31、fb97934），Sonnet 独立复审 9 条处理完（报告 28af1e0，修复 53892c8、bc862bd；R4 不成立）。核对、定的事、改法、回归、复审处理在 [feedback-20261120.md](feedback-20261120.md)。没打包发版。

- 第 94 条：探索阶段询问没人回等 60 分钟（新开关 `askTimeoutExploreMin`），写需求、实施照旧 10 分钟；到点替用户定的事记进启动目录 `.vibe/auto-decisions.json`（`lib/auto-decisions.js`，模型用 `tools/decided.js` 登记定了什么），大任务全部做完时收工钩子一次列出。
- 第 93 条：任务做完第一次审代码多一个"复用和简化"角度（`review-scope.CLEANUP_LENS`），报的强制 P3、kind 清理，改了要复审。
- 第 92 条：写大任务第一个提案前探索记录先过一轮多角度讨论（`lib/explore-panel.js`，`review.js run --mode explore --task <大任务>`），问题写进"还没定的"；`guard-spec` 新建提案时查。

## 待仓库主人做的

- 定要不要打包发版（这批没打包）。发版要先跑全量回归（这批只跑了相关的 28 个测试和钩子比对）。
- 内网 GitLab 发布：20261119.0611 没发过的话照旧要发（解压 `vibe-kit-20261119.0611.zip` 跑发布的 bat）。
- 系统临时目录里 11-03—11-05、11-11 留下的 `vkt-*`/`vke-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- 第一次审代码现在多一个角度：测试里手工交审查回复的，要把"复用和简化"也交上（例：`test-feedback1111.js`、`test-review-flow.js`）。
- 写大任务第一个提案前要讨论过：测试里要"探索记录写好了就放行"的，先 `big-task.setTaskState(task, { panel: { at: Date.now() } })`（例：`test-flow-entry.js`）。
- 等多久看阶段：`ask-timeout.exploring` 要会话在流程里、大任务 `phaseOf` 是 explore；测试用 `VIBE_KIT_ASK_EXPLORE_TIMEOUT_MS` 顶替探索阶段的等待。
- 替你定的事分四组：task（大任务做完列）、change（变更做完列）、flow（在流程里还没大任务，到时候按记它的会话再认）、plain（不在流程里，只在记它的会话收工时列）。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；带引号、反斜杠的补丁用 Write 写成脚本再跑；PowerShell 5.1 的 `Set-Content -Encoding UTF8` 带 BOM，给 node 读的 JSON 用 Write 写；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261119.0611/vibe-kit`，下一版的钩子比对用例写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装目录里已经放了 2.1.327（C:\WorkSpace\内网安装ClaudeCLI）。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
