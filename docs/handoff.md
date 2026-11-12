# 交接：现在的状态

更新于 2026-11-13。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

问题表第 88、89 条 + 导出议题 #458—#467，仓库主人说改完直接打包发版。核对、定的四件事、改法、测试、自审都在 [feedback-20261113.md](feedback-20261113.md)。

做到哪：代码和测试 8 笔提交已推（63dfe55…6b7892d），文档跟着提交。**还差**：独立复审的结论和处理（报告放 `reviews/claude/20261113-第88-89条和议题458-467-复审.md`）、全量回归、打包、验收、`release` 提交和标签。

## 待仓库主人做的

- 发版后在维护的那台电脑上发布到内网 GitLab（解压新包，双击发布的 bat，或 `node publish.js --now`）。
- 系统临时目录里以前几次留下的 `vkt-*`/`vke-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- 核验期"每次先问"（第 88 条）：套件自己关自动时记 `autoFix`（大任务在 `big-task.json`，表外的在流程记录），`auto-run.askPending` 按"这一轮开头那句话的指纹"（`fixAskTurn`）一个用户回合问一次；套件关自动的那一轮不问，`autoStopped` 的不问。选项的字样仍是"自动实施""实施（每步问我）"，`session-config.autoAnswerOf` 认，改了两边一起改。
- 催够了关自动：全面自测、没开始的代码审查同一个状态催 3 次（`flow-policy.upTo`），`verify-gate` 的 `closeIdle`、`reviewIdle` 只在任务都做完、自动在生效时关。
- `flowView` 的 `effective`、`waiting`、`awaitingUser` 是用到才算的 getter：要用就读出来放进变量，别把整个对象传走；读的时候可能抛预算用完的错。
- 进流程：`session-voice.entryAnswer(x, strict)`。模型正要进流程时宽（答案里有"探索"就算），钩子自己记（`syncEntryAnswer`）时严（要点了 /opsx、openspec、vk 流程）。
- 验证证据：`evidence.current` 把目录下面别的仓库名下的也算上，各按自己的指纹比。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；查语法只用 `node --check`；带引号、反斜杠的补丁用 Write 写成脚本再跑；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261112.1523/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
