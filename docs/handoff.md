# 交接：现在的状态

更新于 2026-11-12。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261112.0003（main 和标签 v20261112.0003 在 GitHub），带的是问题表第 77—84 条和 1111 导出的议题里的 #455、#456、#457。核对、改法、测试、自审、复审、发版结果都在 [feedback-20261111.md](feedback-20261111.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261112.0003.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261110.1852 没发过的话不用单发，直接发这一版。
- 这台电脑：开着的这个 Claude 会话里还带着 11-11 误装时加的环境变量（`JAVA_TOOL_OPTIONS`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`、`CLAUDE_CODE_ENABLE_TODO_TOOLS`、`OPENSPEC_*`），settings.json 已经还原，重开会话就没了。没重开之前跑起服务编码的测试会不过。
- 系统临时目录里 11-03、11-04 留下的 `vkt-*`/`vke-*`/`vkz-*` 测试目录要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- **查语法只用 `node --check <文件>`**，不 require、不运行会改东西的脚本（11-11 require 了 `install.js`，把套件装进了真实的 `~/.claude`，经过在 feedback-20261111.md"出的事"）。
- 第 77 条之后代码审查只收这个 change 的文件：测试、端到端里先审再改的，要么在 tasks.md 里点名，要么用 `after-tool` 记一次，要么加 `--all`。
- 第 81、84 条之后"当前 change"按"做完过"（`state/big-task.json` 里大任务那一条的 `finished`）算；测试里要让一个 change 算做完过，先在它全勾完时调一次 `B.phaseOf` 或 `B.finishedMap`。
- `state-store` 的 `DURABLE` 那几份写的时候会多出 `.prev`；比开机时间早 2 分钟以上的锁、进程记录按失效算，测试里用开机前 5 分钟。
- 补丁带反斜杠、反引号的用 Write 写成脚本文件再跑：这一批在 heredoc、`node -e`、补丁脚本的字符串里各坏过一次。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261112.0003/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
