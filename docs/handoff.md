# 交接：现在的状态

更新于 2026-10-30。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261028.2041，已推到 GitHub（main 和标签 v20261028.2041）。包在仓库根目录 `vibe-kit-20261028.2041.zip`，也拷了一份到 C:\WorkSpace\vibe-tools\packages。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。20261028.1834 不能用（转发去掉了 model，网关报 400），别发。

## 在做的：统一修改

- 计划、核对、商量结果、修复结果都在 [feedback-20261030.md](feedback-20261030.md)；仓库主人定的在 decisions.md 2026-10-30。来源：问题表第 19—23 条、Claude 审核（P）、Codex 三轮审核（C）。
- 已提交推送：L、A1—A8、B1—B4、D1、D2、D4、P33（提交号见"修复结果"）。
- A、B 批复审（Sonnet）8 条都成立，报告 reviews/claude/20261030-A与B批-复审.md。改动已写好、测试 `test-push-gate.js` 63 项过，相关老测试在跑，**还没提交**：session.js（`pushFailOut`、`cli` 的 onError）、guard-commit.js（S1、S2、S3）、guard-push.js、hook-host.js、router.js（`hookFailOut`）、router-smoke.js（`-p`、真调 guard-commit）、updater.js（refused 退避、反馈、status）、statusline.js、ui.html、install.js（S6）、run-all.js（S8）、手册、更新说明。
- 接下来：A9—A13（审查意见一个框列全、不改不作废审查许可、规矩前置、斜杠命令、propose 只写 proposal、说法统一）→ D3、D5（驱动连不上自己换）、D7 → C 批（devserver 判断改过、查进程、启动命令、耗时上报 M04、第 23 条老 SpringMVC 起 Tomcat 中文乱码）→ E、F、G、H、I、J → K（结构性大改，这次一起做）。
- 做法：每项先写测试，拿 20261028.2041 跑应当不过；一项一笔提交；改了钩子、路由的批次请别的模型复审。不跑全量回归、不打包，全做完问仓库主人要不要发版。

## 待仓库主人做的

- 内网 GitLab 发布 20261028.2041。

## 要注意的

- 测试里拿旧版比：`git archive v20261028.2041 vibe-kit` 解到临时目录，或者用 `dev/baseline/20261028.2041/vibe-kit`。
- 一个文件里有两件事的改动要分开提交：生成一份只含其中一件的临时文件，`git hash-object -w` + `git update-index --cacheinfo` 放进暂存区先提交，再 add 剩下的（不用交互式 add）。
- 回归跑着时别改被测文件。桌面上有人开 Windows Terminal / PowerShell 时，测试会记成"冒出窗口"，单独重跑确认。
- devserver 认"自己起的"只认往上找得到看管进程的；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着；`hooks/` 下的文件不能删。
- 这台电脑没装 vibe-kit，看不到真实的拦截和耗时。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
