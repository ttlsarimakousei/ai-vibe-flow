# 交接：现在的状态

更新于 2026-11-13。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

第 90、91 条修完、提交了，没发版（上一次发版 20261113.1001）。核对、仓库主人定的四件事、自审在 [feedback-20261113-2.md](feedback-20261113-2.md)。

- 第 90 条 fc377ee：新钩子 `hooks/ask-timeout.js`（PermissionRequest），自动实施时框发出 `askTimeoutMin` 分钟（默认 10）没人回就收掉。
- 第 91 条 c5c7476（查库）、7bfc117（redis）：开发库上只有还原不了的删要人确认。

## 待仓库主人做的

- 定要不要打包发版。发版前按规矩请别的模型复审这批（未结清单里有一行）。
- 内网 GitLab 发布 20261113.1001（没发过的话，等这一版一起发也行）。
- 系统临时目录里 11-03、11-04、11-05、11-11 留下的 `vkt-*`/`vke-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- `ask-timeout` 不走 `cli()` 的 12 秒预算（它本来就要等），读开关单独给 12 秒；安装器写 `timeout: 7500`，要比能配的最长等待（120 分钟）长。新加的钩子升级后要重开 Claude Code 才登记得上（更新说明里写了）。
- 提问框到点是 `deny` 带 message，不用 `allow` + `answers`：替用户选了，会话记录里就是"用户答了"，开工、推送、归档认表态的检查会当成用户点了头。
- 查库 `db.py` 的 `write_policy`：留不下备份、又会删东西、删的又不是这个项目里工具 7 天内自己建的，才要人点头。确认串登记里记 `note`（ask / free），有人在时第二步照它算。`op.json` 的 `auto` 现在是"没人确认就做的"。
- 实测：框显示以后 PermissionRequest 钩子的决定照样作数，用户先答了钩子进程不会被结束（docs/claude-code-facts.md 最后一节，探针 `dev/probes/cc-ask-timeout.js`）。
- 第 88、89 条那批的注意事项照旧：`flowView` 的 getter 用到才算；进流程看 `session-voice.entryAnswer`；配置页一句话说明不超过 90 字。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；带引号、反斜杠的补丁用 Write 写成脚本再跑；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261113.1001/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装文件在 C:\WorkSpace\内网安装ClaudeCLI（探针可以直接给这个 exe 的路径）。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
