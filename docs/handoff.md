# 交接：现在的状态

更新于 2026-11-11。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 先处理这件事

**套件被误装进了这台开发电脑真实的 `C:\Users\admin\.claude`**（11-11 11:46，经过和被改的东西见 [feedback-20261111.md](feedback-20261111.md)"出的事"）。它的钩子现在在这台电脑所有会话里生效：跑测试被拦"用户这一轮没说要自测"，提交被它的"提交方式：关"拦，推送要用户说推送。卸载命令被 Claude Code 的自动模式拦了，要仓库主人自己跑：

1. `node "%USERPROFILE%\.claude\vibe-kit\install.js" --uninstall`
2. 核对 `~/.claude/settings.json`、`~/.claude/CLAUDE.md` 和 `~/.claude/vibe-kit/backup/20261111-114622/` 里的一样（原来的 settings.json 161 字节、CLAUDE.md 360 字节）
3. 删掉剩下的 `~/.claude/vibe-kit`、空的 `~/.claude/commands/opsx`、`~/.claude/skills/openspec-*`

卸载之前不要在这台电脑上跑测试、提交。

## 在做

问题表第 77—84 条和 1111 导出的议题（#443—#457），核对、修了哪些、欠什么都在 [feedback-20261111.md](feedback-20261111.md)。

- 已提交、还没推到 GitHub 的（四笔都在本地）：c5bc271（第 77 条、#456）、5e8896c（#455、#457）、8ef87a8（第 78 条）、da713b9（第 82 条）。到 f0f5c11 为止的文档提交推了。
- 工作区里没提交的：第 79 条 a、b 的代码（`lib/session-out.js`、`lib/flow-policy.js`、`install.js`）、`install.js` 防误装的那一行、`dev/test-feedback1111.js`（新）、`dev/test-feedback1024-review-scope.js`、`docs/` 四份（decisions、feedback-20261111、backlog、这份）。第 79 条的 8 项测试写了没跑。
- 没动的：第 80、83 条；第 81、84 条等仓库主人确认"修改计划"里的固定模式。

## 待仓库主人做的

- 上面的卸载。
- 确认第 81、84 条的固定模式（当前 change 只往后走、回改的审查归当前 change、状态栏带大任务名）。
- 内网 GitLab 发布 20261110.1852 照旧没发的话直接等下一版。
- 系统临时目录里 11-03、11-04 留下的 `vkt-*`/`vke-*`/`vkz-*` 测试目录要自己删。

## 要注意的

- **查语法只用 `node --check <文件>`**，不 require、不运行会改东西的脚本。`install.js` 现在被 require 时什么都不做（没提交）。
- 补丁带反斜杠的用 Write 写成脚本文件再跑：这次 heredoc 里的 `/\\/g` 又坏了一次。
- 第 77 条之后审查点 change 的指纹只算这个 change 的文件；测试里要让文件算进来，用 `after-tool` 记一次，或者在 tasks.md 里点名。
- `apply-scope.valid` 会改状态、"用户开口的那一轮"看 `<会话>-last-stop`，见上一批的 feedback-20261110.md。
- 老规矩照旧：Bash 不 `cd`；`.bat` 按字节改；新测试要 `node dev/contracts.js --write`、加进 `run-all.js`；`hooks/` 下的文件不能删；拿旧版比用 `dev/baseline/20261110.1852/vibe-kit`，下一版的钩子比对用例先写 `NEXT`。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。2.1.312 离线安装文件在 C:\WorkSpace\内网安装ClaudeCLI。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
