# 交接：现在的状态

更新于 2026-11-13。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261113.1001（main 和标签 v20261113.1001 在 GitHub），带的是问题表第 88、89 条和导出议题 #458—#467：核验期每报一次问题先问、审查和自测催够了自己关自动、选探索主要看答案、壳子里认子项目的验证证据、提交的祈使句、只让启动时改代码前拦一次、审查超时只报套件这头慢的、读开关不再每次算审查指纹。核对、定的四件事、自审、Sonnet 复审的处理、发版结果都在 [feedback-20261113.md](feedback-20261113.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261113.1001.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261112.1523 没发过的话不用单发，直接发这一版。
- 系统临时目录里 11-03、11-04、11-05、11-11 留下的 `vkt-*`/`vke-*`（86 个）要自己删，不清的话 `run-all` 结尾报退出码 1。
- 发布后留意下一批导出议题里 #458—#461、#465（钩子预算用完）还剩多少、用时明细里是哪几条 git：定要不要把验证证据的指纹挪到后台算。

## 要注意的

- 核验期"每次先问"（第 88 条）：套件自己关自动时记 `autoFix`（大任务在 `big-task.json`，表外的在流程记录），`auto-run.askPending` 按"这一轮开头那句话的指纹"（`fixAskTurn`）一个用户回合问一次；套件关自动的那一轮不问，`autoStopped` 的不问。选项的字样仍是"自动实施""实施（每步问我）"，`session-config.autoAnswerOf` 认，改了两边一起改。
- 催够了关自动：全面自测、没开始的代码审查同一个状态催 3 次（`flow-policy.upTo`），`verify-gate` 的 `closeIdle`、`reviewIdle` 只在任务都做完、自动在生效时关。
- `flowView` 的 `effective`、`waiting`、`awaitingUser` 是用到才算的 getter：要用就读出来放进变量，别把整个对象传走；读的时候可能抛预算用完的错。
- 进流程：`session-voice.entryAnswer(x, strict)`。模型正要进流程时宽（答案里有"探索"就算），钩子自己记（`syncEntryAnswer`）时严（只认 `/opsx:explore` 这几个命令、"vk 流程"、openspec 挨着"流程、探索、提案"）。
- 验证证据：`evidence.current` 把目录下面别的仓库名下的也算上（最近 8 个），各按自己的指纹比。
- 配置页每个开关的一句话说明不超过 90 个字（`ui-kit-0929.js` 查），多的放进"细节"。
- 跑测试时 test-1007、test-1008 的"桌面上没有冒出窗口"会被 Claude 桌面应用自己的窗口弄不过，看进程名是 claude 就不是套件的问题。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；查语法只用 `node --check`；带引号、反斜杠的补丁用 Write 写成脚本再跑；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261113.1001/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
