# 交接：现在的状态

更新于 2026-11-19。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261119.0611（main 和标签 v20261119.0611 在 GitHub），带的是 11-18 导出的议题 #483—#489 和仓库主人当天的三条使用体验：提问框、确认框没人回任何时候都到点替他定；实施一律自动（需求审过问"开始实施 / 先不实施"，到点开工）；状态栏不显示自动开关。另有 #484、#487、#488、#489 和 Bash 改需求文档拦下。核对、Sonnet 复审的处理、发版结果在 [feedback-20261118.md](feedback-20261118.md) 和 [reviews/claude/20261118-提问框到点和实施一律自动-复审.md](../reviews/claude/20261118-提问框到点和实施一律自动-复审.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261119.0611.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261118.1047 没发过的话直接发这一版。
- 系统临时目录里 11-03—11-05、11-11 留下的 `vkt-*`/`vke-*`（86 个）要自己删，不清的话 `run-all` 结尾报退出码 1。
- 下一批导出议题里看：#479—#481（审查只吐思考、复审 20 分钟没交）要那台的 `.vibe/reviews`；钩子超时剩下的是 git 本身慢的电脑（#484 那台装了文档加密）和 6 个仓库的壳子（#483）。

## 要注意的

- 实施一律自动：开自动的入口是 `auto-run.autoOn`（task-anchor 说开工、说过停又继续、`/vk-resume` 接回；pre-edit 的 `autoOnEdit` 核验期重开；`confirmApply` 提问框答了开工）。老选项"实施（每步问我）"点了照旧按关。说停记到大任务上（`stopped`），接回不自己开。
- 提问框到点（`ask-timeout`）：任何时候都等；开工那一问要会话记录里找得到、问题里点名唯一一个变更、需求审过才替用户开工；确认框到点按允许，推送、发布、查库和 redis、关服务、还原不了的删（`DESTRUCTIVE`）除外。
- 会话的自动现在开工就开，测试里要"人工"前提的，自己把会话开关设成关（`S.setSessionAuto(j, false)`），不要靠配置开关；diff-hooks 里开工那几条用了自己的会话，免得 sess-diff 后面的拦截都带上"全自动模式"。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；带引号、反斜杠的补丁用 Write 写成脚本再跑（heredoc 里的 `\\`、`\W` 会被吃掉）；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261119.0611/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
