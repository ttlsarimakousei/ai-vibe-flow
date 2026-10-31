# 交接：现在的状态

更新于 2026-10-31。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261031.1436，已推到 GitHub（main 和标签 v20261031.1436）。包在仓库根目录 `vibe-kit-20261031.1436.zip`，也拷了一份到 C:\WorkSpace\vibe-tools\packages。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。20261028.1834 不能用（转发去掉了 model，网关报 400），别发。

这一版是 10-30、10-31 的统一修改：问题表第 19—28 条、Claude 审核（P）、Codex 三轮审核（C）。核对、计划、每项的提交号和测试在 [feedback-20261030.md](feedback-20261030.md)；仓库主人定的、Claude 按 10-31 授权定的在 decisions.md 2026-10-30、10-31 两节。复审报告：reviews/claude/20261030-A与B批-复审.md、reviews/claude/20261031-C至J批-复审.md。

## 待仓库主人做的

- 内网 GitLab 发布 20261031.1436（20261028.2041 若还没发，直接发这一版即可）。
- 看一眼 decisions.md 10-31 一节里 Claude 定的几条（挪到下一批的 K、J2、J4 后半、F8、E1、E3、H 剩下的；计划里两处没照做；I4 的结论），不同意的说。
- 同事升级后：自动模式改成每个会话敲 `/vk-auto` 打开，配置页上两个自动开关没了，要跟同事说一声（更新说明第一条写了）。

## 下一批

- 按 backlog.md 的顺序：K（先拆 guard-commit）→ J2 → J4 后半（先做"自动压缩之后重送规矩"）→ F8 → E1、E3（E3 先用真 Claude Code 加假网关探 SSE error）→ H 剩下的。
- 做法不变：每项先写测试，拿上一版跑应当不过；一项一笔提交；改了钩子、路由的批次请别的模型复审。

## 要注意的

- 测试里拿旧版比：`dev/baseline/20261031.1436/vibe-kit`（或 `git archive v20261031.1436 vibe-kit` 解到临时目录）。
- 一个文件里有两件事的改动要分开提交：生成只含其中一件的临时文件，`git hash-object -w` + `git update-index --cacheinfo` 放进暂存区先提交（不用交互式 add）。
- 回归跑着时别改被测文件。桌面上有人开 Windows Terminal / PowerShell 时，测试会记成"冒出窗口"，单独重跑确认。
- devserver 认"自己起的"只认往上找得到看管进程的；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着；`hooks/` 下的文件不能删。
- 这台电脑没装 vibe-kit，看不到真实的拦截和耗时。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
