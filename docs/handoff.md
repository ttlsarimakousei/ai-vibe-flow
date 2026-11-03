# 交接：现在的状态

更新于 2026-11-04。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261104.0435（新流程、删路由、审查子代理、状态栏），已推到 GitHub（main 和标签 v20261104.0435），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。这一版做了什么、提交号、测试、自审：[feedback-20261103.md](feedback-20261103.md)。复审：[reviews/claude/20261104-下个版本-复审.md](../reviews/claude/20261104-下个版本-复审.md)。

全量回归 116 套、三个 Claude Code 版本的端到端：6473 项全过。从 0653、1436、2248 三个包验收升级都过；`dev/probes/up-no-router.js` 用 2248 的真路由走了自动更新和手动安装两条路，38 项过。

## 在做的

没有。未结的见 backlog，有一条待定：`/vk-auto 带需求` 要不要算第四种进流程的门。

## 待仓库主人做的

- 内网 GitLab 发布 20261104.0435（`publish.js`，只能仓库主人做）。发之前先用 cch 切走：升级时路由、`router-data/` 里的 key 一起删。

## 要注意的

- 模型路由删了：`vibe-kit/router/` 没了，配置页在 `kit/ui/`，`kit/lib/config-page.js` 起（优先 15731 端口，敲 `/vk-config`）。测试里起配置页用 `H.configPage(h, 端口)`。
- 收回旧东西只放在 `kit/lib/router-retire.js`。令牌保护里的 `router-data` 字样不删（硬规矩 6）。
- 删了的名字由 `dev/test-no-leftovers.js` 扫（`dev/pack.js` 打包前也跑）：留着的进它的白名单，写理由和能删的条件。
- 钩子出错放行会藏住"名字没定义"：这一版真 CLI 实测抓到 `task-anchor` 的 `blockOut` 没引入（`dev/probes/cc-vk-config.js`），老测试没覆盖。改了钩子入口要跑真 CLI。
- winpty 在 Git Bash 下会把 `/vk-config` 改写成路径，探针里写 `//vk-config`。
- 审查：脚本只备材料（`review.js prepare`），子代理审，`hooks/review-stop.js` 入账。没有上限，连续 3 次没交结论才断路。
- 测试里同一个点第二次 `R.run` 文件没变不发请求，要整份再审加 `full: true`；`H.fakeReview`、`H.reviewedTurn` 代替真子代理。
- session.js、guard-commit.js 只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js。
- 开关只在 `kit/lib/config-fields.js` 定义（硬规矩 10）。手册的开关表 `node dev/config-doc.js --write` 生成。
- 按会话的状态在 state/session/<会话号>/，全局的照旧在 state/。
- 测试里拿旧版比：`dev/baseline/20261102.2248/vibe-kit`；基线删了的用 `H.baselineDir(版本)` 从 git 标签取。
- 几个会话同时跑测试会撞固定端口，报端口被占的先单独重跑。回归跑着时别改被测文件。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`（`\n` 会变成真换行），用 Write 写成文件再跑。
- `hooks/` 下的文件不能删（`guard-push.js`、`source-hint.js` 是空壳）。这台电脑没装 vibe-kit。
- 系统临时目录里有测试崩了留下的 `vkt-*` 目录（通配删除被权限拦了），要清的话仓库主人自己删。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
