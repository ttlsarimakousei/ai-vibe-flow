# 交接：现在的状态

更新于 2026-11-04 傍晚。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 最近一次发版

20261104.1301，已推到 GitHub（main 和标签 v20261104.1301），包在仓库根目录和 C:\WorkSpace\vibe-tools\packages。提交号、测试、自审：[feedback-20261104.md](feedback-20261104.md)。

## 在做的（提交了，没打包）

1. 安装包瘦身到约 4.8 MB（[feedback-20261104-1345.md](feedback-20261104-1345.md)）。
2. 套件可以改、拦了直接放行（两个开关去掉）；状态栏不带序号；第 52—55 条；`ttls-` 改成 `vk-`（[feedback-20261104-1730.md](feedback-20261104-1730.md)）。复审见那份文档"自审"一节。

发版前要做：全量回归（带 `--claude` 三个版本、`--old`）、从 1301 和更早的包验收升级（改名搬迁、`vk-lessons-*`）。

## 待仓库主人做的

- 内网 GitLab 发布（`publish.js`，只能仓库主人做）。从 1301 之前的版本升上来，发之前先用 cch 切走：升级时路由、`router-data/` 里的 key 一起删。

## 要注意的

- 套件可以改了（硬规矩 6 改了措辞）：读 secrets.json、router-data 照拦，别的保护模型改得掉。`hooks/guard-kit.js` 是空壳。
- 技能、审查代理、经验规则文件都是 `vk-` 开头；`guard-ask` 只把六个技能名以外的 `vk-*` 当"给用户敲的命令"。认旧名字 `ttls-` 的地方在 `test-no-leftovers.js` 白名单里，写了能删的条件。
- 钩子会写 `openspec/plan.md`（表外的 change 补成一行，第 55 条），以前是只读。
- `/vk-resume` 不写名字只出提问框；答案由收工钩子 `verify-gate` 调 `task-anchor.resumePicked` 认。
- 审查子代理同一个项目里最多 3 个在跑（`review-runner.claim`）。
- 删了的名字由 `dev/test-no-leftovers.js` 扫（`dev/pack.js` 打包前也跑）。
- 钩子出错放行会藏住"名字没定义"：改了钩子入口要跑真 CLI（`dev/probes/cc-vk-config.js`、`cc-vk-resume.js`，Git Bash 下参数写 `//vk-…`）。
- 测试里拿旧版比：`dev/baseline/20261104.1301/vibe-kit`；对比用例的输入要写那一版的名字（`ttls-handover` 这类）。
- 补丁脚本里带反斜杠的不要用 heredoc 或 `node -e`，用 Write 写成文件再跑。`.bat` 按字节改。
- `hooks/` 下的文件不能删。这台电脑没装 vibe-kit。系统临时目录里有测试崩了留下的 `vkt-*` 目录，要清的话仓库主人自己删。
- 推 GitHub 偶尔 TLS 握手失败，重试就好。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289（exe 在 `node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`）。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
