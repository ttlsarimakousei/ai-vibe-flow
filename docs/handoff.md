# 交接：现在的状态

更新于 2026-11-12。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

问题表第 85—87 条（需求一次写到 tasks 并强制审修、自动只管实施在提问框里选、删 /vk-auto）：代码、测试、文档提交在 a0dbc50，核对和定的事在 [feedback-20261112.md](feedback-20261112.md)。等 Sonnet 独立复审（报告 `reviews/claude/20261112-第85-87条-复审.md`），复审的结论逐条处理后回填 feedback 的"自审"。没发版。

## 待仓库主人做的

- 定要不要打包发版（发版前先看 backlog 里"待定"的）。
- 内网 GitLab 发布：20261112.0003 没发的话，等下一版一起发。
- 这台电脑：11-11 误装留在会话里的环境变量，重开会话就没了；系统临时目录里 11-03、11-04 的 `vkt-*`/`vke-*`/`vkz-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- 自动开关现在只在提问框里开：`session-config.autoAnswerOf` 认选项字样（"自动实施""自动接着做"开，"实施（每步问我）""人工接着做""先不实施"关），改提示里的选项要两边一起改；`session-flow.syncAutoAnswer` 在 `readConfigFor` 里读。
- 写需求那一段永远不算自动（`flowView.effective` 只看做任务那一段）；第一次打勾前要审过，两种模式都查：老测试里直接打勾的夹具要先 `H.reviewPoints(h, dir, 'proposal')`。
- `lib/auto-run.js` 管说停关自动、全部通过关自动、核验期改代码重新打开、开工前先问；表外 change 的自测记录在 `state/change-selftest.json`。
- 跑测试时 test-1007、test-1008 的"桌面上没有冒出窗口"会被 Claude 桌面应用自己的窗口弄不过，看进程名是 claude 就不是套件的问题。
- **查语法只用 `node --check <文件>`**，不 require、不运行会改东西的脚本（11-11 require 了 `install.js`，装进了真实的 `~/.claude`）。
- 补丁带反斜杠、引号的用 Write 写成脚本文件再跑，heredoc 里会坏（这一批又坏过两次）。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261112.0003/vibe-kit`，下一版的钩子比对用例写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
