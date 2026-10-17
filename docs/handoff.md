# 交接：现在的状态

更新于 2026-10-18 早上。只写现在的状态，做完的事看 git log 和 docs/ 里对应的文档。

## 最近一次发版

20261018.0051，已推到 GitHub（main 和标签）。内网 GitLab 的发布要在维护的那台电脑上双击发布脚本，不在这边做。之后的提交（发版提速、交接、授权记录）还没打包，下次发版带上。

## 刚做完：发版提速的前三项

钩子对比复制仓库、单元测试分 3 路、端到端三个版本同时跑。发版全量回归从 72 分钟降到 32 分 43 秒，全过。数据和做法在 docs/release-timing.md，用法在 dev/README.md。

## 待仓库主人定

- docs/release-timing.md"优化建议"里剩下的几项：测试支架用工作线程调钩子、没动过的模块不测、查库（H2）那套为什么要 9 分钟。

## 规矩里新加的（细节在 docs/decisions.md）

- 这个仓库的提交和 push 到 GitHub 直接做，不用问；打包发版照旧等仓库主人说；publish.js 发内网由他做。
- 新会话自动带上这份交接（CLAUDE.md 导入）。做完一件事提交之后就覆盖更新它。

## 环境

- IDEA 测试项目：C:\WorkSpace\TestIdea（boot-demo 18081、mvc-pom 18082、mvc-plain 运行配置有错）。
- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。旧版安装包：C:\WorkSpace\vibe-tools\packages。
- 这台电脑 8 GB 内存，IDEA 开着时只剩约 1 GB；端到端三路同时跑内存紧，不够就 `--e2e-lanes 2`。
