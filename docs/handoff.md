# 交接：现在的状态

更新于 2026-11-18。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261118.1047（main 和标签 v20261118.1047 在 GitHub），带的是 11-17 导出的议题 #468—#482 和仓库主人当天定的三件事：起服务不拦；自己起的服务测完留着、要关先弹框问；状态栏第三行改成在跑的服务和端口。另有跨壳子开工（#476、#478）、壳子根验证证据只算会话改过的子项目（#468、#470、#471、#473）、#472 提交认法、#477 收工认"不用"。核对、Sonnet 复审的处理、发版结果在 [feedback-20261117.md](feedback-20261117.md) 和 [reviews/claude/20261117-起停服务和跨壳子开工-复审.md](../reviews/claude/20261117-起停服务和跨壳子开工-复审.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261118.1047.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261113.1921 没发过的话直接发这一版。
- 系统临时目录里 11-03—11-05 留下的 `vkt-*`/`vke-*`（86 个）要自己删，不清的话 `run-all` 结尾报退出码 1。
- 11-18 10:51 桌面上有一个 `内网安装ClaudeCLI\1-外网下载（双击我）.bat` 的 cmd 窗口开着（从资源管理器双击的，不是测试起的），没动它。
- 下一批导出议题里看：#479—#481（审查只吐思考、复审 20 分钟没交）要那台的 `.vibe/reviews` 和网关模型能不能关思考；钩子超时还剩的是不是"会话没改过子项目、在壳子根跑验证"那一类。

## 要注意的

- 关服务：`flow-policy.stopIssue` 只认 `devserver.js stop`（含套在 bash -c 里的），同一条里又 start 算重启；用户原话 `intent.stopService`、提问框问关服务答了关就放行；人工 `askOut`，全自动拦下，`ask-timeout` 到点按不允许。`taskkill`、`Stop-Process` 认不出。
- 验证证据：壳子根、会话改过子项目的按子项目各记一条（同一个 `cmd`、`parts`），从壳子根查时几条都对才算；没改过子项目的照旧整个指纹。
- 跨壳子：`session-projects.nearChanges` 只按话里带连字符的词查上一级、上两级目录下的 `openspec/changes/<名字>`，找到唯一一个才认。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；带引号、反斜杠的补丁用 Write 写成脚本再跑；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261118.1047/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
