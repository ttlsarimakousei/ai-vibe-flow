# 交接：现在的状态

更新于 2026-11-09 晚。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)（现在是空的）。

## 在做

没有在做的。最近一次发版 20261109.1612（main 和标签 v20261109.1612 在 GitHub）。之后做完了问题表第 75 条（换个需求就忘了怎么启动、用哪个账号），已提交推送，**还没打包发版**：核对、改法、提交号、复审见 [feedback-20261109-2.md](feedback-20261109-2.md)。

这批：devserver 起来后把命令写进项目说明的"跑通的启动"一行（stop 不删）；测试账号表 `.vibe/login.json` 定格式（`lib/login.js`、`tools/login.js`）；会话开始带账号汇总、开口提醒记账号；场景引用 `{{login.名字.字段}}`；tmp 里的账号、登录场景拦一次。只跑了相关测试（第 75 条 72 项、相关老测试 19 套、钩子比对 297 项），没跑全量回归。

## 待仓库主人做的

- 定要不要打包发版（发版前按 docs/release.md 跑全量回归，`--since v20261109.1612`）。
- 发版后内网 GitLab 发布：解压包，在包目录里跑 `node publish.js --now`。
- #426/#428"一直说上一轮在跑"的确切路径没复现；内网再碰到，看 `review.js status` 的 `running`。
- #427 那台网关的模型映射没核实（套件这边已不指定模型）。

## 要注意的

- 跑通的启动：`devserver.noteStartLine`，键"跑通的启动（名字，日期）"比 `onboard` 的 12 字键长，探索不碰它。不在 git/svn 里又不像项目的目录不写；GBK 的项目说明不动；BOM、CRLF 照原样。**不要在 devserver 里改 `.gitignore`**：下次 start 会当成代码改过而重启（第一轮 `test-feedback1028.js` 就挂在这）。
- 账号表的口令不进任何汇总、提示、场景输出；坏 JSON 的报错不带原文（Node 的报错会引出口令）。
- 开口的账号识别（`login.promptHint`）误报漏报的例子都在 `test-feedback1109-login.js`"用户给了账号"一节，改正则先跑它。
- git 跨钩子缓存、cd 改写、钩子跑 validate、审查分批这些见 [feedback-20261109.md](feedback-20261109.md)。
- 老规矩照旧：补丁带反斜杠的用 Write 写成文件再跑（heredoc 会吃掉反斜杠，这批又踩了一次）；Edit 写 `\uFEFF` 这类转义会变成字符本身，用 `String.fromCharCode`；Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261109.1612/vibe-kit`。
- 临时目录里有 11-04、11-05 留下的 vkt-pkg-*、vkt-t1017-* 等测试目录，`run-all` 结尾会因此报退出码 1，不是这批留的。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
