# 交接：现在的状态

更新于 2026-11-11。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

问题表第 77—84 条和 1111 导出的议题（#443—#457）：代码、测试、文档都改完提交了，没发版。核对、修了什么、测试、自审在 [feedback-20261111.md](feedback-20261111.md)。

- 在等别的模型（Sonnet）的独立复审，报告写到 `reviews/claude/20261111-第77-84条-复审.md`。回来之后逐条核对、改、回填 feedback 文档的"别的模型的复审"一节。
- 复审处理完问仓库主人要不要打包发版。

## 待仓库主人做的

- 要不要发版（发版前先问 backlog 里有没有要定的：现在没有"待定"）。
- 内网 GitLab 发布：20261110.1852 没发过的话直接等下一版。
- 系统临时目录里 11-03、11-04 留下的 `vkt-*`/`vke-*`/`vkz-*` 测试目录要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- **查语法只用 `node --check <文件>`**，不 require、不运行会改东西的脚本。11-11 `require` 了 `install.js`，把套件装进了这台电脑真实的 `~/.claude`（已收回，经过在 feedback-20261111.md"出的事"）。现在 `install.js` 被 require 时什么都不做。
- 补丁带反斜杠、反引号的用 Write 写成脚本文件再跑：这一批在 heredoc、`node -e`、补丁脚本的字符串里各坏过一次。
- 第 81、84 条之后"当前 change"按"做完过"（`state/big-task.json` 里大任务那一条的 `finished`）算，测试里要让一个 change 算做完过，先在它全勾完时调一次 `B.phaseOf` 或 `B.finishedMap`。
- 审查点 change 的指纹只算这个 change 的文件（`flow-policy.changeScope`）；测试里要让文件算进来，用 `after-tool` 记一次，或者在 tasks.md 里点名。
- `state-store` 的 `DURABLE` 那几份写的时候会多出 `.prev` 文件。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261110.1852/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
