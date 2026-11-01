# 交接：现在的状态

更新于 2026-11-02。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261102.0540，已推到 GitHub（main 和标签 v20261102.0540），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。和 20261102.0255 比只修了配置页的显示，见 [feedback-20261102.md](feedback-20261102.md)。全量回归 103 套 5676 项全过，从 1436、0255 两个包验收升级都过。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。0255 没发内网，直接发 0540。20261028.1834 不能用，别发。

K 批和问题表第 29—31 条（0255 那一版）做了什么、提交号、测试、自审：[feedback-20261101.md](feedback-20261101.md)。复审：[reviews/claude/20261102-K批-复审.md](../reviews/claude/20261102-K批-复审.md)。

## 在做的

没有。下一批等仓库主人说。

## 待仓库主人做的

- 内网 GitLab 发布 20261102.0540。
- 定：审核 H 节第 6 项（更新时套件钩子条目、状态栏刷新间隔被重写，用户改过的要不要保留），见 backlog.md。
- 删 `%TEMP%\vkt-*` 残留的 33 个临时目录（10-31、11-01 留的，删除时被权限挡了）。

## 要注意的

- session.js、guard-commit.js、router.js 现在只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js、router/*.js。
- 开关只在 `kit/lib/config-fields.js` 定义（AGENTS.md 硬规矩 10）。手册的开关表 `node dev/config-doc.js --write` 生成。
- OpenSpec 规范不在全局约定里了：`rules/10-openspec.md` 开头有标记，安装器写成 `hook-rules.md`，`lib/stage-rules.js` 送。测试里查规范文字要读 hook-rules.md。
- 配置页"快满时怎么办"两项不存文件，文件里存的是四个旧字段（`contextStrategy` 等），钩子读旧字段。
- 不做开关的几项（`config-fields.js` 的 FIXED）代码还认手写的值，测试靠它们关检查；`dev/lib/harness.js` 的 makeHome 默认审查上限 3 轮、autoHandover 开，和产品默认不一样，是为了老测试。
- 按会话的状态在 state/session/<会话号>/，全局的照旧在 state/。
- 测试里拿旧版比：`dev/baseline/20261102.0540/vibe-kit`；基线删了的用 `H.baselineDir(版本)` 从 git 标签取。
- 几个会话同时跑测试会撞固定端口，报端口被占的先单独重跑。回归跑着时别改被测文件。
- 补丁脚本里带反斜杠的不要用 heredoc 写（`\n` 会变成真换行），用 Write 写成文件再跑。
- 已合并、可以清掉的 worktree：`.claude/worktrees/agent-a7c23950c55ccf840`、`agent-a95aa8abeac21f606`。
- `hooks/` 下的文件不能删；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着。这台电脑没装 vibe-kit。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
