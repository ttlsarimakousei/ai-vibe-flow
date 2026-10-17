# 交接：现在的状态

更新于 2026-10-18 02:3x。只写现在的状态，做完的事看 git log 和 docs/ 里对应的文档。

## 最近一次发版

20261018.0051，已推到 GitHub（main 和标签）。内网 GitLab 的发布要在维护的那台电脑上双击发布脚本，不在这边做。

## 正在做：发版提速的前三项（仓库主人 10-18 选的，依据见 docs/release-timing.md）

1. 钩子对比用模板复制仓库：`dev/diff-hooks.js` 的 `project()` 已改（同样的文件只建一次 git 仓库，之后复制）。还没量、没提交。改之前单独一份对 0051 的耗时正在量。
2. run-all 分路调度：`dev/run-all.js` 已改（`--lanes` 默认 3、`--solo`、`--e2e-lanes`、按上一轮耗时排、结尾打印各段用时）。还没试出"怕机器忙"的套，SOLO 名单是空的。没提交。
3. 端到端每个 Claude Code 版本端口错开 100（e2e-update、e2e-0930）：`run-all.js` 已改，没量。

做完的标准：三项各量一次时间写进 docs/release-timing.md；dev/README.md、docs/release.md 跟着改；分开提交；问仓库主人要不要 push（本地还有一笔没推：5242e49 发版耗时文档改正）。

## 待仓库主人定

- docs/release-timing.md 里其余几项提速（测试支架用工作线程调钩子、跳过没动过的模块等）。

## 环境

- IDEA 测试项目：C:\WorkSpace\TestIdea（boot-demo 18081、mvc-pom 18082、mvc-plain 运行配置有错）。
- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。旧版安装包：C:\WorkSpace\vibe-tools\packages。
- 这台电脑 8 GB 内存，IDEA 开着时只剩约 1 GB，同时跑端到端要留意内存。
