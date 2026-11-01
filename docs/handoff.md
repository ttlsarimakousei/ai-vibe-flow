# 交接：现在的状态

更新于 2026-11-01（仓库主人周额度快用完，换账号接着做）。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261031.1436，已推到 GitHub（main 和标签 v20261031.1436），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。20261028.1834 不能用，别发。

## 在做的：K 批（11-01 这一批，一次发版）

- 计划、做完的（提交号、测试）、**没做完的和怎么接着做**都在 [feedback-20261101.md](feedback-20261101.md) 的"修复结果"和"交接细节"两节，先读它。
- 已做、已推送：拆 guard-commit、session、router；E1、E3；H2、H4、H5；一次调用一份上下文（K1-5）；状态分目录（K1-3）；F8；依赖清单（K1-6）；测试契约索引（K1-7）。
- 没做完：
  - K2：分支 `worktree-agent-a7c23950c55ccf840`，固定、跳过这一版做了一半。
  - K3：分支 `worktree-agent-a95aa8abeac21f606`，SQL 核对、团队的坑没提交，doctor.js 没开始。
  - 主会话还没动代码，设计已定：J4 后半、K1-8 诊断指标、K1-4 开关字段表 + J2（要等 K2 合并以后做）。
- 都做完以后：自审 → 请别的模型复审 → 全量回归（带端到端，K1-3、K1-5 还没跑过）→ 写更新说明 → 打包发版。仓库主人 11-01 定了这一批全做完一次发版。

## 待仓库主人做的

- 内网 GitLab 发布（等这一批发版后发新的那版）。
- 定：审核 H 节第 6 项（更新时套件钩子条目、状态栏刷新间隔被重写，用户改过的要不要保留），见 backlog.md。

## 要注意的

- session.js、guard-commit.js、router.js 现在只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js、router/*.js。
- 按会话的状态在 state/session/<会话号>/，全局的照旧在 state/。
- 测试里拿旧版比：`dev/baseline/20261031.1436/vibe-kit`；基线删了的用 `H.baselineDir(版本)` 从 git 标签取。
- 几个会话同时跑测试会撞固定端口，报端口被占的先单独重跑。回归跑着时别改被测文件。
- 一个文件里有两件事的改动要分开提交：生成只含其中一件的临时文件，`git hash-object -w` + `git update-index --cacheinfo` 放进暂存区先提交。
- `hooks/` 下的文件不能删；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着。这台电脑没装 vibe-kit。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
