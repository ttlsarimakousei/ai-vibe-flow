# 交接：现在的状态

更新于 2026-11-09。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)（这批之后是空的）。

## 在做

20261109 这批改完、提交推送了，在发版：全量回归 → 打包 → 从最近两版验收升级 → `release` 提交和标签。核对、改法、每条的提交号见 [feedback-20261109.md](feedback-20261109.md)。

这批改了：0234 上报的 #420、#421（连 #339、#349、#358）、#422、#425—#429、#413；去掉 `ccAutoMode`（第 74 条，开关去掉，Claude Code 自带的自动模式固定关着）；第 71 条第 1 点做了三样（`run --decisions`、cd 改写、钩子跑 validate）；未结清单修 6 行、关 11 行。审查不再指定 Sonnet，用用户默认的模型（替代第 63 条）。

## 待仓库主人做的

- 发版后内网 GitLab 发布：解压包，在包目录里跑 `node publish.js --now`。
- #426/#428"一直说上一轮在跑"的确切路径没复现，修的是两种可能的原因；内网再碰到，看 `review.js status` 的 `running` 里是哪个审查点、哪个进程。
- #427 那台网关的模型映射没核实（套件这边已不指定模型）。

## 要注意的

- git 跨钩子缓存（`workspace.crossCall`）：只在钩子里；`state/git-cache.json`、`state/git-epoch.json`；PostToolUse（不改文件的工具除外）、用户开口、会话开始换代。测试默认 `VIBE_KIT_NO_GIT_CACHE=1`，`dev/lib/harness.js` 加载时也给测试进程设上。
- cd 改写在 `guard-commit.handle` 里先做（`guard-process.cdRewrite`），改写后的命令整条再过 `handleOne`。只改两种：cd 到当前目录；cd 之后只有 git（可带 echo、管道给 head/tail/wc/sort/uniq）。
- 钩子跑 validate：`lib/spec-validate.js`，after-tool 调，按内容去重记在 `<会话>-spec-validate.json`。要自带的 OpenSpec 能用，测试家目录要 `makeHome(..., { openspec: true })`。
- 审查：`review-scope.matchLabel`；复审轮分批；`status` 按角度汇总；"上一轮在跑"只看同一审查点、进程活着；`run --decisions` 在任务上记 `decided`，重跑同一条命令不重复登记；代码审查没有代码改动报错，`--docs-only` 放过。
- 同名 change：`big-task.ofChange` 给目录只按目录认；流程状态 `current` 旁边有 `currentDir`。
- `db-crud.ini` 的锁：Node 用 `state-store.acquire(<ini>.lock)`，Python 的 `dbconf._ini_lock` 同格式，60 秒以前的算没人管。
- 探针：`dev/probes/cc-cd-rewrite.js`、`hook-git-count.js`。
- 老规矩照旧：补丁带反斜杠的用 Write 写成文件再跑；Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261106.0234/vibe-kit`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
