# 交接：现在的状态

更新于 2026-10-18 清晨。只写现在的状态，做完的事看 git log 和 docs/ 里对应的文档。

## 最近一次发版

20261018.0051，已推到 GitHub（main 和标签）。内网 GitLab 的发布要在维护的那台电脑上双击发布脚本，不在这边做。之后的提交（发版提速两批、交接、授权记录）都在测试和文档上，还没打包，下次发版带上。

## 刚做完：发版提速剩下的几项

docs/release-timing.md"后面几项"一节有实测数据，用法在 dev/README.md、docs/release.md。

- 测试支架在工作线程里调钩子（dev/lib/hook-thread.js）：调钩子多的套单独跑快 20%—75%，钩子对比 239→165 秒。基础回归 3 路这一轮墙上时间没变（13 分 43 秒），原因见文档。怀疑它引起失败就设 `VIBE_TEST_HOOK_SPAWN=1` 对比。
- dev/stale-asserts.js：找测试里的旧说法、旧默认值。发版流程（docs/release.md）改成：改了说法、默认值之后先跑它，再跑一个版本的端到端和一份钩子对比；确定发版直接全量。
- accept-packages.js 给几个旧包就同时走几条升级路。
- run-all.js `--since <标签>` 和 dev/lib/affected.js：没动过的独立模块不测。
- 查库（H2）那套慢的原因分析完了：每条命令起 Java 约 0.95 秒、Python 每次重新编译约 0.4 秒（Claude Code 给命令行设了 PYTHONDONTWRITEBYTECODE=1）。

## 待仓库主人定

- "没动过的模块不测"的规则：按现在的严格规则最近 11 版一次都跳不了；放宽到只看模块自己的文件，查库能跳 4—6 次。数据在 docs/release-timing.md 表下。定了之后把 `--since` 加进 docs/release.md 的发版命令。
- 查库技能的字节码缓存放到技能目录外面（改技能行为，用户每条查库命令也快 0.2—0.4 秒），做不做。

## 要注意的

- 起服务 0929 在 3 路同时跑时挂过一次（"连着重启三次"），单独重跑全过。再挂就写进 run-all.js 的 SOLO。
- 回归跑着的时候别在同一台电脑上建 git 工作区、签出整个仓库：会把同时跑的长套拖慢 10%—16%。

## 环境

- IDEA 测试项目：C:\WorkSpace\TestIdea（boot-demo 18081、mvc-pom 18082、mvc-plain 运行配置有错）。
- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。旧版安装包：C:\WorkSpace\vibe-tools\packages。
- 这台电脑 8 GB 内存，IDEA 开着时只剩约 1 GB；端到端三路同时跑内存紧，不够就 `--e2e-lanes 2`。
