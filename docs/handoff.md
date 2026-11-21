# 交接：现在的状态

更新于 2026-11-21。规矩见 AGENTS.md"交接"；没结的问题看 [backlog.md](backlog.md)。

## 在做

没有在做的。多角度全量审核（[报告](../reviews/claude/20261121-vibe-kit-多角度全量审核.md)）查出的问题修完了，Sonnet 独立复审 4 条处理完，都推到了 GitHub。核对、定的事、真机实测、改法、复审处理都在 [feedback-20261121.md](feedback-20261121.md)。

- 修了：
  - 坏锁收回（B1）、guard-ask 出错记反馈（B2）、guard-commit 载入崩时 push 要确认（B3）。
  - 查库副作用函数，名单认带引号的写法（A4、R2）。
  - Read 换写法读令牌（A3、R1，新登记了 Read 的钩子）。
  - 安装器拷文件改成先写临时文件再改名（R3）。
- 说法改了：到点放行的范围（A1）、6 处过时文档、删了 `lib/pull.js`（C1—C6）。
- 不改（仓库主人定的）：A2 到点放行范围维持现状；B4 命令跑得久时多记一条，关闭；R4 锁、等待类函数不进名单。
- 最近一次发版还是 20261121.0243，这一批没打包。更新说明最上面一节写的是 `@@VER@@`。

## 待仓库主人做的

- 定要不要打包发版。这一批改了钩子登记（Read），装完要重开 Claude Code。发版照 `docs/release.md` 走全量回归，拿旧版比用 `dev/baseline/20261121.0243`。
- 内网 GitLab 发布：20261121.0243 没发过的话照旧要发。
- 系统临时目录里 11-03—11-05、11-11 留下的 `vkt-*`、`vke-*`、`vkz-*` 要自己删，不清的话 `run-all` 结尾报退出码 1。
- 下一批导出议题里看：#479—#481 要那台的 `.vibe/reviews`；钩子超时剩下的是 git 本身慢的电脑（#484）和 6 个仓库的壳子（#483）。

## 要注意的

- 探针、临时脚本别直接 require 源码里的 `kit/lib`：等锁的诊断会写进 `vibe-kit/kit/state/`（被忽略、看不见），`makeHome` 拷进假用户目录，`test-diag` 就出错。用 `H.makeHome` 的假目录。
- Python 跑技能脚本加 `-B`，不然 `__pycache__` 留在技能目录里，打包会拒。Python 改文件用 `write_bytes`，`write_text` 参数错了会先清空文件。
- 带反斜杠的内容（`\\?\`、正则）别塞进 heredoc，用 Write 写成脚本再跑。
- Read 的钩子每次读文件都起进程：guard-read 顶上只载 `session-kitfiles`，别往里加重的 require。
- 老规矩照旧：
  - Bash 不 `cd`；`.bat` 按字节改。
  - 新测试要 `node dev/contracts.js --write`，加进 `run-all.js`。
  - `hooks/` 下的文件不能删。
  - 下一版的钩子比对用例写 `NEXT`。
  - 配置页一句话说明不超过 90 个字。

## 环境

- Claude Code 测试版本：%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120 / 2.1.259 / 2.1.289。内网在用 2.1.316，安装目录里已经放了 2.1.327（C:\WorkSpace\内网安装ClaudeCLI）。
- Python 3.12、JDK 17（%LOCALAPPDATA%\Programs\…）、H2 在 ~/.m2。8 GB 内存，端到端用 `--e2e-lanes 2`。
