# 交接：现在的状态

更新于 2026-11-03。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261102.2248，已推到 GitHub（main 和标签 v20261102.2248），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。这一版做了什么、提交号、测试、自审：[feedback-20261102-1543.md](feedback-20261102-1543.md)。复审：[reviews/claude/20261102-1102批-复审.md](../reviews/claude/20261102-1102批-复审.md)。

全量回归 108 套、三个 Claude Code 版本的端到端：6398 项过，2 项是用户的 Windows Terminal 弹的提示窗被算成多出的窗口，单独重跑过了。从 1436、0255、0540 三个包验收升级都过。0255、0540 没发内网，直接发这一版。20261028.1834 不能用，别发。

## 在做的

在和仓库主人谈流程：探索→需求→apply→自测→人工核验，中途任意打断不影响，针对 CLI 2.1.120 起。已定的见 decisions.md 2026-11-03；别的还在谈，代码没改。实测见 claude-code-facts.md 最后一节。下一批等仓库主人说；第 39 条（删除本地路由/模型配置，删除用量管理）仓库主人说下个版本再说，还没查代码；第 41 条（开着 vk-auto 还卡在问是否开工）、第 42 条（全自动下 guard-commit 拦提案的自动提交）、第 43 条（需求没说的不许自己加）、第 44 条（vk-auto 开着还在询问，说是需求阶段却在动代码）只记了，没改，都见 [owner-issues.md](owner-issues.md)。

## 待仓库主人做的

- 内网 GitLab 发布 20261102.2248。

## 要注意的

- 审查分轮在 `lib/review-scope.js`：第一轮几个角度、后面只审修改点。上一轮存在 `.vibe/reviews/<变更>/<模式>-<点>.snapshot.json`，过程记在同目录的 `审查记录.md`。每个审查点自动审到 10 轮就停，不是设置。
- `dev/lib/harness.js` 的 makeHome 默认 `reviewLenses: 1`、审查上限 3 轮、autoHandover 开，和产品默认不一样，是为了老测试。测试里同一个点第二次 `R.run` 文件没变不发请求，要整份再审加 `full: true`。
- session.js、guard-commit.js、router.js 现在只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js、router/*.js。
- 开关只在 `kit/lib/config-fields.js` 定义（AGENTS.md 硬规矩 10）。手册的开关表 `node dev/config-doc.js --write` 生成。
- OpenSpec 规范不在全局约定里了：`rules/10-openspec.md` 开头有标记，安装器写成 `hook-rules.md`，`lib/stage-rules.js` 送。测试里查规范文字要读 hook-rules.md。
- 配置页"快满时怎么办"两项不存文件，文件里存的是四个旧字段（`contextStrategy` 等），钩子读旧字段。
- 按会话的状态在 state/session/<会话号>/，全局的照旧在 state/。
- 测试里拿旧版比：`dev/baseline/20261102.2248/vibe-kit`；基线删了的用 `H.baselineDir(版本)` 从 git 标签取。
- 几个会话同时跑测试会撞固定端口，报端口被占的先单独重跑。回归跑着时别改被测文件。
- 补丁脚本里带反斜杠的不要用 heredoc 写（`\n` 会变成真换行），用 Write 写成文件再跑。
- 已合并、可以清掉的 worktree：`.claude/worktrees/agent-a7c23950c55ccf840`、`agent-a95aa8abeac21f606`。
- `hooks/` 下的文件不能删；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着。这台电脑没装 vibe-kit。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
