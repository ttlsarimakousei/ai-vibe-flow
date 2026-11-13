# 交接：现在的状态

更新于 2026-11-13。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。最近一次发版 20261113.1921（main 和标签 v20261113.1921 在 GitHub），带的是问题表第 90、91 条：自动实施时询问没人回，等 10 分钟替用户收掉；开发库执行 SQL 只有还原不了的删才问，redis 一起放开。核对、仓库主人定的四件事、自审、Sonnet 复审的处理（R1—R7，R5 不成立）、发版结果都在 [feedback-20261113-2.md](feedback-20261113-2.md)。

## 待仓库主人做的

- 内网 GitLab 发布：解压 `vibe-kit-20261113.1921.zip`，双击发布的 bat，或在包目录里跑 `node publish.js --now`（马上装）。20261113.1001 没发过的话不用单发，直接发这一版。同事升级后要重开一次 Claude Code，新钩子才登记得上（更新说明里写了）。
- 系统临时目录里 11-03、11-04、11-05、11-11 留下的 `vkt-*`/`vke-*`（86 个）要自己删，不清的话 `run-all` 结尾报退出码 1。
- 发布后留意下一批导出议题里 #458—#461、#465（钩子预算用完）还剩多少、用时明细里是哪几条 git。

## 要注意的

- `hooks/ask-timeout.js`（PermissionRequest）：不走 `cli()` 的 12 秒预算；会话的自动开关没开（`readConfig().autoApply`）直接退，不算流程状态；安装器写 `timeout: 7500`，要比能配的最长等待（120 分钟）长。提问框到点是 `deny` 带 message，不用 `allow` + `answers`（会被当成用户表态）。推送、发布、跑 `db.py`、`redis.js` 的确认框到点按不允许：后两个工具认"用户在不在"看两分钟内的条子，框挂久了条子过期（复审 R1）。
- 查库 `db.py` 的 `write_policy`：留不下备份、又会删东西、删的又不是这个项目里工具 7 天内自己建的（`_qual` 比带不带 schema 的原样写法），才要人点头。确认串登记里记 `note`（ask / free）。`op.json` 的 `auto` 是"没人确认就做的"，`unattended` 是"做的时候是不是全自动"，全自动报告按 `unattended` 列。
- 实测：框显示以后 PermissionRequest 钩子的决定照样作数，用户先答了钩子进程不会被结束（docs/claude-code-facts.md 最后一节，探针 `dev/probes/cc-ask-timeout.js`，可以直接给内网 2.1.316 的 exe 路径）。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；带引号、反斜杠的补丁用 Write 写成脚本再跑；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261113.1921/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
