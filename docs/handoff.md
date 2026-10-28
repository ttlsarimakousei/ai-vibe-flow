# 交接：现在的状态

更新于 2026-10-28。只写现在的状态，做完的事看 git log 和 docs/ 里对应的文档。

## 最近一次发版

20261025.0653，已推到 GitHub。内网 GitLab 的发布要仓库主人在维护的那台电脑上做，还没做。

## 这一批（1028）已改完、没打包

2026-10-28 导出的 #225—#234 和问题表第 6—17 条，核对、修复结果、说法冲突审查都在 **docs/feedback-20261028.md**；提交 `7c916a8..09a278e`（加后面的文档提交），已推 GitHub。主要变化：去掉 IDEA MCP 接入和 IDEA 起服务、去掉合并推送工具（用户自己说合并推送照做）、路由不带模型名和 Bearer、审查不截断超时上报、审查和提交同一句许可一轮里多次用、devserver 看日志等起来、认得自己起过的服务（全机登记 state/devserver.json）且热更新的不重启、用量页精简。用户定的写在 docs/decisions.md 2026-10-28。

只跑了和改动相关的测试（都过了，钩子对比 262 项对 0653 全过），没跑全量回归，没打包。

## 没做完的

- #229—#232（神通 SQL 报错、找不到神通驱动）证据不足，没动；要在出错的电脑上跑 `tools/diagnose.js`。
- 以前的 #221—#224、#220、feedback-20261021.md 末尾那批旧议题照旧没再核（见各自文档）。

## 待仓库主人做的

- 定要不要打包发版（照 docs/release.md：全量回归带 `--since v20261025.0653`、打包、验收）。
- 内网 GitLab 发布 20261025.0653（或者直接发下一版）。

## 要注意的

- 新测试 `dev/test-feedback1028.js`（端口 18797）；删了 `test-idea-run.js`、`test-feedback1024-idea.js`、`test-push-preview.js`、`test-feedback1012-push.js`、`probes/idea-devserver.js`；`test-idea-mcp.js` 改成测撤回登记。
- `lib/idea-mcp.js` 只剩撤回；`due()`、`sync()` 要留着（自动更新时内存里的旧代码会调）。删掉的库文件靠 `install.js` 的 `DROPPED_FILES` 在装新版时清掉，`hooks/` 下的文件照旧不能删。
- devserver 认不出日志标志的服务，端口通了 3 秒才发第一次请求，`test-devserver-0929.js` 比以前慢一些。`--port auto` 的起点 2026-10-28 起按运行目录（--cwd）算，带 --cwd 起的服务新挑的端口和以前不同（已有记录的照旧用原端口）。
- 《更新说明.md》的 `@@VER@@` 必须正好两处（stamp-and-pack.js 会查）。
- 改提示说法、行为之后先跑 `node dev/stale-asserts.js`。回归跑着时别改被测文件。
- 手工试探用的假用户目录（`vkt-*`）用完要删。

## 环境

- IDEA 测试项目：C:\WorkSpace\TestIdea（套件已不用 IDEA 起服务，留着做别的验证）。
- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。旧版安装包：C:\WorkSpace\vibe-tools\packages。
- 这台电脑 8 GB 内存，IDEA 开着时只剩约 1 GB；端到端三路同时跑内存紧，不够就 `--e2e-lanes 2`。
