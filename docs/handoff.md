# 交接：现在的状态

更新于 2026-11-02。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261031.1436，已推到 GitHub（main 和标签 v20261031.1436），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。内网 GitLab 的发布要仓库主人在维护的那台电脑上做。20261028.1834 不能用，别发。

## 在做的：K 批（11-01 这一批，一次发版）

- 计划、做完的（提交号、测试）、**没做完的和怎么接着做**都在 [feedback-20261101.md](feedback-20261101.md) 的"修复结果"和"交接细节"两节，先读它。"交接细节"第 1、2 节（K2、K3）已做完，看"修复结果"表。
- 已做、已推送：拆 guard-commit、session、router；E1、E3；H2、H4、H5；K1-5；K1-3；F8；K1-6；K1-7；K2（尝鲜组、观察期、固定、跳过）；K3（commit.js、失败摘要、检查点、SQL 对表结构、团队的坑、doctor.js）。
- 做到一半：J4 后半（规范改由钩子送，lib/stage-rules.js），代码和测试写完（test-stage-rules 44 项），还没提交；test-1008 里 3 项断言要改成读全局约定加 hook-rules.md；手册"上下文和 token"的字数、dev/README 没改。
- 没做：K1-8 诊断指标；K1-4 开关字段表 + J2（设计见交接细节第 5 节，下面"K1-4、J2 的想法"）。
- 都做完以后：自审 → 请别的模型复审 → 全量回归（带端到端，K1-3、K1-5 还没跑过）→ 写更新说明 → 打包发版。仓库主人 11-01 定了这一批全做完一次发版。

## K1-4、J2 的想法

- 字段表放 `kit/lib/config-fields.js`。没装路由的电脑没有 router/ 目录，所以只能放 lib；`router/kit-api.js` 先找 `../lib/`（装好的），再找 `../kit/lib/`（源码）。AGENTS.md 硬规矩 10 要跟着改。
- J2：`contextAction`（compact / off / remind / ask）+ `contextPercent`。钩子、状态栏不改，照旧读旧的 contextStrategy、handoverAsk、handoverPercent、autoCompactPercent，由这两项算出来；旧名字继续写进 config.json，自动更新装回旧版时照样读得懂。remind、ask 的压缩线是百分比加 15，封顶 95。

## 待仓库主人做的

- 内网 GitLab 发布（等这一批发版后发新的那版）。
- 定：审核 H 节第 6 项（更新时套件钩子条目、状态栏刷新间隔被重写，用户改过的要不要保留），见 backlog.md。
- 删 `%TEMP%\vkt-*` 残留的临时目录（10-31 的 26 个删除时被权限挡了）。

## 要注意的

- session.js、guard-commit.js、router.js 现在只是出口和调度，改逻辑去 lib/session-*.js、lib/guard-*.js、router/*.js。
- 按会话的状态在 state/session/<会话号>/，全局的照旧在 state/。
- 测试里拿旧版比：`dev/baseline/20261031.1436/vibe-kit`；基线删了的用 `H.baselineDir(版本)` 从 git 标签取。
- 几个会话同时跑测试会撞固定端口，报端口被占的先单独重跑。回归跑着时别改被测文件。
- K2、K3 的 worktree（`.claude/worktrees/agent-a7c23950c55ccf840`、`agent-a95aa8abeac21f606`）已合并，可以清掉。
- `hooks/` 下的文件不能删；`lib/idea-mcp.js` 的 `due()`、`sync()` 要留着。这台电脑没装 vibe-kit。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
