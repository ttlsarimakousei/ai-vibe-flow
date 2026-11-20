# 交接：现在的状态

更新于 2026-11-21。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261121.0243（main 和标签 v20261121.0243 在 GitHub），带的是问题表第 92—94 条：
- 写大任务第一个提案前，探索记录先过一轮多角度讨论。
- 任务做完第一次审代码，多一个"复用和简化"角度。
- 询问没人回：探索阶段等 60 分钟，别的阶段 10 分钟；到点替用户定的事记进 `.vibe/auto-decisions.json`，大任务做完时一次列出。

Sonnet 独立复审 9 条处理完。核对、复审处理、发版结果都在 [feedback-20261120.md](feedback-20261120.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261121.0243.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261119.0611 没发过的话直接发这一版。
- 系统临时目录里 11-03—11-05、11-11 留下的 `vkt-*`、`vke-*`、`vkz-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。
- 下一批导出议题里看：#479—#481（审查只吐思考、复审 20 分钟没交）要那台的 `.vibe/reviews`；钩子超时剩下的是 git 本身慢的电脑（#484）和 6 个仓库的壳子（#483）。

## 要注意的

- 第一次审代码多一个角度：测试里手工交审查回复的，要把"复用和简化"也交上（例：`test-feedback1111.js`、`test-review-flow.js`）。
- 写大任务第一个提案前要讨论过：测试里要"探索记录写好了就放行"的，先 `big-task.setTaskState(task, { panel: { at: Date.now() } })`（例：`test-flow-entry.js`）。
- 替你定的事分四组：
  - task：大任务做完列。
  - change：变更做完列。
  - flow：在流程里、还没有大任务，按记它的会话再认。
  - plain：不在流程里，只在记它的会话收工时列。
- `ask-timeout.exploring` 要会话在流程里。测试用 `VIBE_KIT_ASK_EXPLORE_TIMEOUT_MS` 顶替探索阶段的等待。
- 配置页一句话说明不能超过 90 个字（`ui-kit-0929`、`ui-data-0930` 查），细节放 `<details>`。
- 老规矩照旧：
  - Bash 不 `cd`；`.bat` 按字节改。
  - 带引号、反斜杠的补丁用 Write 写成脚本再跑。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 带 BOM，给 node 读的文件用 Write 写。
  - 新测试要 `node dev/contracts.js --write`，加进 `run-all.js`。
  - `hooks/` 下的文件不能删。
  - 拿旧版比用 `dev/baseline/20261121.0243/vibe-kit`；下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装目录里已经放了 2.1.327（C:\WorkSpace\内网安装ClaudeCLI）。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
