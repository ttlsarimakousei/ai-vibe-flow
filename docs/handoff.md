# 交接：现在的状态

更新于 2026-11-05 下午。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261105.1257，已推到 GitHub（main 和标签 v20261105.1257），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages（4.8 MB）。和 2337 比：审查时机放宽（第 57、58 条，[feedback-20261105.md](feedback-20261105.md)，复审 [reviews/claude/20261105-审查时机-复审.md](../reviews/claude/20261105-审查时机-复审.md)）。

全量回归（`--since v20261104.2337`，查库 H2、起服务、查 redis 没动过没测）116 套 6461 项，1 项是测试索引没登记新测试，重写索引后单独过了，没有重跑全量。端到端 2.1.120、2.1.259、2.1.289 都过。从 1301、2337 验收升级各 33 项过。

## 待仓库主人做的

- 内网 GitLab 发布 20261105.1257：解压包，在包目录里跑发布（要马上装加 `node publish.js --now`）。
- 第 59—62 条只记了原话，没查（backlog 里待核）。说修再核对、分析、改。

## 要注意的

- 审查点：`flow-policy.js` 的 `points` 只有必审的（整套文档 `tasks`、整个 change `change`、跨 change 的 `cross-*`），`written` 是写好了哪几份文档，`reviewable` 加上用户点名才审的单份文档和组。`group-rest` 取消了。
- `change` 的指纹分"文档和任务 : 代码"两段，同一项目后面的变更开工了只比前一段（`sameInput`、`laterStarted`）。基线记真正开工那一刻，大任务只记现在要做的 change（`apply-scope.grant`）；`change` 审查不送"开工前就有改动、开工后没动过"的文件。
- 人工模式用户选了不审，`nextStepTodo` 照样引导接下一个 change、全面自测，不再停住（旧版就停住，这批顺手修的）。
- 第 59 条的现象是在老的逐份审查流程上看到的（内网装的版本），新流程没验证过会不会再出现，也没查原因。
- 套件可以改了（硬规矩 6 改了措辞）：读 secrets.json、router-data 照拦（命令、Grep、MCP；复制、打包整个套件目录也拦，只看源不看目标），别的保护模型改得掉。`hooks/guard-kit.js` 是空壳。
- 技能、审查代理、经验规则文件都是 `vk-` 开头；认旧名字 `ttls-` 的地方在 `test-no-leftovers.js` 白名单里，写了能删的条件。新测试里别写旧名字，残留扫描会报。
- 新测试文件要跑 `node dev/contracts.js --write` 登记，不然全量回归那一项不过（这次就是）。
- 钩子会写 `openspec/plan.md`（表外的 change 补成一行，第 55 条），只在那一处插入，读写之间变了不写。
- `/vk-resume` 不写名字只出提问框；答案由收工钩子 `verify-gate` 调 `task-anchor.resumePicked` 认。
- 审查子代理同一个项目里最多 3 个在跑（`review-runner.claim`），满了先清已结束没交的。
- OpenSpec 1.16.0 要 Node 22.12，仓库主人定了先不升；下次发版再看。
- 钩子出错放行会藏住"名字没定义"：改了钩子入口要跑真 CLI（`dev/probes/cc-vk-config.js`、`cc-vk-resume.js`，Git Bash 下参数写 `//vk-…`）。
- 测试里拿旧版比：`dev/baseline/20261105.1257/vibe-kit`（最新）。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`，用 Write 写成文件再跑；Bash 里不要 `cd`，当前目录会跟着变。`.bat` 按字节改。
- `hooks/` 下的文件不能删。这台电脑没装 vibe-kit。系统临时目录里有 11-04 测试崩了留下的 `vkt-*` 目录，要清的话仓库主人自己删。推 GitHub 偶尔 TLS 握手失败，重试就好。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
