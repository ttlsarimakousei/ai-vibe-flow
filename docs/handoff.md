# 交接：现在的状态

更新于 2026-10-30。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261028.2041，已推到 GitHub（main 和标签 v20261028.2041）。包在仓库根目录 `vibe-kit-20261028.2041.zip`，也拷了一份到 C:\WorkSpace\vibe-tools\packages。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。20261028.1834 不能用（转发去掉了 model，网关报 400），别发。

## 在做的：统一修改

- 计划和核对：[feedback-20261030.md](feedback-20261030.md)。来源是问题表第 19—22 条、Claude 审核（P）、Codex 三轮审核（C），分 A—L 批；"商量结果"一节和 decisions.md 2026-10-30 是仓库主人定的。
- 做到：L、A1—A3、B1—B4 已提交推送（提交号见 feedback-20261030.md"修复结果"）。A、B 两批的独立复审（Sonnet）在跑，结论写 reviews/claude/20261030-A与B批-复审.md，成立的照修。下一步 A4（提交、推送、归档认本轮最后一次明确表态）—A13，然后 C 批。
- 做法：每项先写测试，拿 20261028.2041 跑应当不过；一项一笔提交；不跑全量回归、不打包，全做完问仓库主人要不要发版。改了钩子、路由的批次提交前另请别的模型复审，报告放 reviews/claude/。
- K（结构性大改、新机制）这次一起做，排在正确性问题后面。
- 口令明文相关的（P24、P25、P26 的手册）、本机接口（P21）仓库主人定了不改。

## 待仓库主人做的

- 内网 GitLab 发布 20261028.2041。

## 要注意的

- devserver 认"自己起的"只认往上找得到看管进程（`devserver.js __keep`）的，不认 claude.exe。按命令认同一个服务，只用在别的目录起的记录上。
- `lib/idea-mcp.js` 只剩撤回；`due()`、`sync()` 要留着（自动更新时内存里的旧代码会调）。删掉的库文件靠 `install.js` 的 `DROPPED_FILES` 清，`hooks/` 下的文件照旧不能删。
- 拿旧版手工跑会起服务的测试，别用 `timeout` 截断，会留下服务进程和 `vkt-*` 临时目录。
- 改提示说法、行为之后，先跑 `node dev/stale-asserts.js`。回归跑着的时候别改被测文件。
- 全量回归时桌面上别处开终端会被记成"冒出窗口"，单独重跑那一套确认。
- 这台电脑没装 vibe-kit（`~/.claude/vibe-kit` 不存在），看不到真实的拦截和耗时统计。
- Codex 的复现脚本在 `reviews/codex/*.cjs`，只用假用户目录，可以直接重跑；`supplemental.cjs` 要传 Python 路径。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。旧版安装包：C:\WorkSpace\vibe-tools\packages。
- Python：%LOCALAPPDATA%\Programs\Python\Python312；JDK 17：%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-17.0.20.1-hotspot；H2 在 ~/.m2。
- 这台电脑 8 GB 内存；IDEA 开着时只剩约 1 GB，端到端测试用 `--e2e-lanes 2`。
