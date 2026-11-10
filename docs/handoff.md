# 交接：现在的状态

更新于 2026-11-10。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。刚做完的一批：问题表第 76 条（做到一半改需求，阶段、下一步、拦截都乱）和 1110 导出的议题里的 #435、#436、#438。核对、仓库主人定的四点、改法、测试、自审、复审都在 [feedback-20261110.md](feedback-20261110.md)。**还没打包发版**，`更新说明.md` 最上面是 `@@VER@@`。

最近一次发版 20261110.0152（main 和标签 v20261110.0152 在 GitHub），带的是第 75 条。

## 待仓库主人做的

- 这一批要不要打包发版。发版前按 docs/release.md 跑全量回归。
- #432 那一组（钩子等 git 超时）：要那台电脑上 `node "%USERPROFILE%\.claude\vibe-kit\tools\doctor.js"` 的输出。
- 内网 GitLab 发布 20261110.0152（还没发的话）：解压包，双击发布的 bat，或 `node publish.js --now`。
- #426/#428、#427 照旧没复现、没核实。
- 系统临时目录里 11-03、11-04 留下的 87 个 `vkt-*`/`vke-*`/`vkz-*` 测试目录要仓库主人自己删，不清的话 `run-all` 结尾报退出码 1。

## 要注意的

- 第 76 条没有把阶段整个改成按 change 算：`<会话>-flow.json` 的 `stage` 还是会话一个值，改的是会让它出错的几处。再碰到"阶段不对"先看 `apply-scope.js` 开头的注释。
- `apply-scope.valid` 现在会改状态（用户开口的那一轮、开着自动时重定范围）。"用户开口的那一轮"看 `<会话>-last-stop`；测试里要走"收工之后模型自己改"那条路，先 `S.writeState(sid + '-last-stop', { at: Date.now() })`（支架的时钟在一小时前）。要和 git 提交时间比先后的，用真的时间写会话记录（`test-feedback1110.js` 的 `sayNow`）。
- 写需求时不改代码的拦截没有拦截编号了（用户定的），别给它加回去。
- 用户定的：decisions.md 11-10 一节。10-30"改需求才退回"已被替代。
- 第 75 条的注意点见 feedback-20261109-2.md；**不要在 devserver 里改 `.gitignore`**。
- 起服务 0929"连着重启三次"同时跑时偶发不过，单独重跑过。OpenSpec 1.16.x 要 Node 22.12，还留在 1.15.0。
- 老规矩照旧：补丁带反斜杠的用 Write 写成文件再跑（这次 heredoc 里带反引号的也坏了）；Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261110.0152/vibe-kit`，这一版的钩子比对用例写的是 `NEXT`，发版时换成版本号。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
