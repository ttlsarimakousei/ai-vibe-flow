# 交接：现在的状态

更新于 2026-11-04。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做的

下个版本（新流程、删路由、审查子代理、状态栏）。计划和定下的 7 条在 [feedback-20261103.md](feedback-20261103.md)，由 Opus 5.5 Max 规划，批 0～7 共 8 批。

- 批 0～4 提交、推送了：大任务、三种进流程的门、/vk-resume、多 change 串行、全面自测和核验放最后、归档前预演、审查全用子代理（SubagentStop 入账，新钩子 review-stop.js）、取消次数和文件上限。
- 批 5 在做：删路由和 idea-mcp、配置页用时才起。已写未接上（未提交）：`kit/lib/router-retire.js`、`kit/lib/config-page.js`、`kit/lib/guard-mcp.js`，测试 `dev/test-router-retire.js`、`test-config-page.js`、`test-guard-mcp.js`。
- 批 6 状态栏步骤条、批 7 清残留、首页放图、文档、自审、复审没开始。
- **仓库主人 2026-11-04 说：这一版做完直接打包发版**（docs/release.md：全量回归、打包、验收升级、release 提交和标签）。`publish.js` 发内网 GitLab 仍由仓库主人做。

## 待修的

- `dev/e2e-auto-0929.js`、`dev/e2e-lessons.js` 要改提示（话里不再按句子进流程，要敲 `/opsx:apply`、`/vk-resume`）。e2e-subagent 三个版本都过。

## 要注意的

- 审查：`review.js prepare` 备材料、输出 agents；子代理交的结论由 review-stop.js 入账；交齐才算；连续 3 次没交不再催不算过（`flow-policy.halted`）。假结论的测试用 `H.fakeReview`，只要结果文件的用 `H.reviewedTurn`。
- 收回路由的时机：手动安装装完当场；自动更新（env `VIBE_KIT_AUTO_UPDATE`）等新代码第一次跑 session-start，更新器的锁还在时不收，自检不过装回旧版路由还在。
- `dev/lib/harness.js` 的 makeHome 默认 `reviewLenses: 1`、autoHandover 开，和产品默认不一样。测试里同一个点第二次审文件没变不开子代理，要整份再审加 `full: true`。
- session.js、guard-commit.js、router.js 现在只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js。
- 开关只在 `kit/lib/config-fields.js` 定义。手册的开关表 `node dev/config-doc.js --write` 生成。
- 测试里拿旧版比：`dev/baseline/20261102.2248/vibe-kit`。几个会话同时跑测试会撞固定端口。回归跑着时别改被测文件。
- 补丁脚本里带反斜杠的不要用 heredoc 写，用 Write 写成文件再跑。Bash 里不要 `cd`。
- `hooks/` 下的文件不能删。这台电脑没装 vibe-kit。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
