# 交接：现在的状态

更新于 2026-11-10。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

问题表第 76 条（做到一半改需求，阶段、下一步、拦截都乱）：核对和复现做完了，代码没改。结论、要定的、修改计划在 [feedback-20261110.md](feedback-20261110.md)；复现脚本 `node dev/probes/owner76-repro.js`（六个场景，只打印行为）。

根因：写需求还是做任务是整个会话一个值（`<会话>-flow.json` 的 `stage`），拦截按它判；状态栏的步骤条另从文件算。回改、新开 change 时几个 change 各在各的阶段，对不上。

最近一次发版 20261110.0152（main 和标签 v20261110.0152 在 GitHub），带的是第 75 条，见 [feedback-20261109-2.md](feedback-20261109-2.md)。

## 待仓库主人做的

- 第 76 条"要定的"1～4 点：人工模式改需求后要不要重新说开工（替代 10-30 的规矩）、写需求阶段什么时候能改代码（第 44 条）、提交方式"自动"时中途小改动算不算一件事、开工前这个会话自己改的文件算不算用户改动。定了才动代码。
- 内网 GitLab 发布：解压 `vibe-kit-20261110.0152.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`。
- #426/#428"一直说上一轮在跑"的确切路径没复现；内网再碰到，看 `review.js status` 的 `running`。
- #427 那台网关的模型映射没核实。
- 系统临时目录里 11-03、11-04 留下的 87 个 `vkt-*`/`vke-*`/`vkz-*` 测试目录：Claude 删被权限拦了，要清得仓库主人自己删。不清的话 `run-all` 结尾会因此报退出码 1。

## 要注意的

- 第 76 条改的是 `apply-scope.js`、`session-flow.js`、`guard-spec.js`、`guard-git.js`、`big-task.js`，都是钩子的主干：改完要别的模型复审，`test-multi-change.js`、`test-workflow-state.js`、`test-statusline-bar.js` 先跑。
- decisions.md:183（10-30"改需求才退回"）、:81（11-03 大任务回改）、第 44 条（需求阶段不动代码）是用户定的，没定之前不改回去。
- 跑通的启动、账号表（第 75 条）的注意点见 feedback-20261109-2.md；**不要在 devserver 里改 `.gitignore`**。
- 起服务 0929"连着重启三次"同时跑时偶发不过，单独重跑过。
- OpenSpec 1.16.x 要 Node 22.12，还留在 1.15.0。
- 老规矩照旧：补丁带反斜杠的用 Write 写成文件再跑；Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261110.0152/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
