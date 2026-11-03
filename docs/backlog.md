# 未结清单

所有来源（问题表、导出议题、自审、第三方审查）里还没结的都在这里。结了就删那一行，历史看各批 feedback 文档和 git。规矩见 AGENTS.md"问题、审查、修复怎么记"。

| 编号 | 问题 | 状态 | 在哪分析 | 下一步 |
|---|---|---|---|---|
| 问题表第 39 条 | 删除本地路由/模型配置，删除用量管理 | 后做 | [owner-issues.md](owner-issues.md) 第 39 条 | 11-03 定了连路由进程一起删，下一批做，见 [decisions.md](decisions.md) 2026-11-03 |
| 问题表第 41 条 | 开着 vk-auto，早上发现还是卡在问是否开工 | 待修 | [owner-issues.md](owner-issues.md) 第 41 条 | 仓库主人说修时再核对 |
| 问题表第 42 条 | guard-commit 拦截提案的自动提交，全自动模式下提案也无法自动提交 | 待修 | [owner-issues.md](owner-issues.md) 第 42 条 | 仓库主人说修时再核对 |
| 问题表第 43 条 | 禁止发散：需求没说、探索阶段也没说过的点，需求、编码和自测阶段不许自己加 | 待修 | [owner-issues.md](owner-issues.md) 第 43 条 | 仓库主人说修时再核对 |
| 问题表第 44 条 | vk-auto 开着还在询问，Claude 说现在是需求阶段，但已经在动代码 | 待定 | [owner-issues.md](owner-issues.md) 第 44 条 | 等仓库主人定 |
| 复审 20261102 K-R8 | 跑 commit.js 的票只绑会话和仓库，"询问"模式用户拒绝后票还在，guard 认不出的写法能凭旧票提交，不再过提交方式这道检查 | 后做 | [reviews/claude/20261102-K批-复审.md](../reviews/claude/20261102-K批-复审.md) | 要特意构造，只影响提交方式 |
| 复审 20261031 D-R6 | 壳子里 `mvn -f 子项目` 记的证据按子仓库记，review-runner 登记"修了"时按壳子查，对不上 | 后做 | [reviews/claude/20261031-C至J批-复审.md](../reviews/claude/20261031-C至J批-复审.md) | `evidence.commands` 认壳子下各子仓库的证据 |
| 复审 20261031 D-R9 | `.vibe/db-crud.ini` 读改写没锁（换驱动记 driver_jar 和后台探索同时写） | 后做 | 同上 | 照 drivers.js 用 state-store 的锁 |
| feedback-20261030 C8 | 前后端只能串行起；命名管道认看管进程 | 后做 | 同上 | 这批做完再商量 |
| Codex V01 | 改库快照和写入之间别人改了同一行，还原脚本可能对不上 | 后做 | 同上 D6 | 这批只在手册写明限制；有各家数据库的测试环境再做 |
| #232 | 找不到神通驱动 | 证据不足 | [feedback-20261028.md](feedback-20261028.md) 第 12、13 类 | 在出错的电脑上跑 `tools/diagnose.js` |
| #223、#224 | Oracle 28001；redis NO_CONN | 证据不足 | [feedback-20261024.md](feedback-20261024.md) 第 10 类 | 同上 |
| #268 | redis NO_CONFIG，只有一次；项目没配 redis 或者连接名写错都会这样 | 证据不足 | [feedback-20261102-1543.md](feedback-20261102-1543.md) | 同上 |
| #252、#256、#259、#265 | 审查只回思考到上限，重试后拿到 | 后做 | [feedback-20261102-1543.md](feedback-20261102-1543.md) | 重试兜住了，只是多花时间。等新的审查机制上线后的数据再看 |
| #190—#195、#133、#140 | 查库、redis 报错 | 证据不足 | [feedback-20261021.md](feedback-20261021.md) 第 8 类 | 同上 |
| #181 | guard-commit 卡在"开始"阶段 | 证据不足 | feedback-20261021.md | 要现场的钩子日志 |
| tmx.epoch | 仓库根目录出现过 `tmx.epoch`（仓库主人看到的），仓库代码、Claude/Codex 的程序和日志、shell 启动脚本、git 钩子都查不到来源；10-30 03:00—06:00 只读监视根目录没再出现 | 待核 | 无 | 再出现时记下时间和当时在跑的命令 |
| #73、#74 | 数据库问题 | 待核 | [feedback-20261013.md](feedback-20261013.md)（当时按用户范围排除，没再核） | 下次修数据库时一起核 |
