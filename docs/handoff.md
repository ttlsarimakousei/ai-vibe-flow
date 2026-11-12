# 交接：现在的状态

更新于 2026-11-12。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261112.1523（main 和标签 v20261112.1523 在 GitHub），带的是问题表第 85—87 条：需求一次写到 tasks 并强制审修、自动只管实施在提问框里选、全部通过后自己关、删 /vk-auto。核对、定的事、Sonnet 复审的 9 条处理、发版结果都在 [feedback-20261112.md](feedback-20261112.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261112.1523.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261112.0003 没发过的话不用单发，直接发这一版。
- 系统临时目录里 11-03、11-04、11-05、11-11 留下的 `vkt-*`/`vke-*`（87 个）要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- 自动开关只在提问框里开：`session-config.autoAnswerOf` 只认套件给的选项开头（"自动实施""自动接着做"开，"实施（每步问我）""人工接着做""先不实施"关），改提示里的选项要两边一起改；只认流程里的答案（`session-flow.syncAutoAnswer`，先看会话记录最后 256KB 有没有提问框答案）。
- 写需求那一段永远不算自动；第一次打勾前要审过，两种模式都查：老测试里直接打勾的夹具要先 `H.reviewPoints(h, dir, 'proposal')`。
- `lib/auto-run.js` 管说停关自动（只认明说的停、暂停、等等）、全部通过关自动、核验期改代码按代码指纹重新打开、开工前先问；选过的记在 `big-task.json` 的 `asked`。
- 跑测试时 test-1007、test-1008 的"桌面上没有冒出窗口"会被 Claude 桌面应用自己的窗口弄不过，看进程名是 claude 就不是套件的问题。
- **查语法只用 `node --check <文件>`**，不 require、不运行会改东西的脚本（11-11 require 了 `install.js`，装进了真实的 `~/.claude`）。
- 补丁带反斜杠、引号的用 Write 写成脚本文件再跑，heredoc 里会坏。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`，改了测试的节名要同步 `dev/contracts.md` 里手写的契约表；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261112.1523/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
