# 修改指导：两套审查记账并成一套

2026-10-17 由 Claude 写，给下一批实现用。动手前先读 [开发交接](handoff-20261015.md) 和 [架构](architecture.md) 两阶段一节。

## 为什么要做

现在有两套记账并存，判断"审过没有、收尾没有"时各处用的口径不一样。10-16 一天修的问题里，至少 4 个出在这里：

- 收工检查和提交检查对"审查收尾了没有"判断不一致（`cab5632` 修）：一边催提交，一边拦提交。
- 全自动报告只认旧记账，审了几轮、报了几条写不出来（`7dbac1c` 修）。
- 两个端到端还按旧流程走，10-14 之后一直没跑过。
- `resolve` 对逐点结果不查是否完整完成（`7fd1624` 修）。

两套各自修补，下次还会出同类问题。目标是所有"审过没有"的判断只走一个入口。

## 现在的两套

| | 新：逐点审查 | 旧：整套审查和多轮记账 |
|---|---|---|
| 状态文件 | `review-points.json`（按变更目录和点）、`review-jobs.json`（执行中的任务） | `reviewed.json`、`reviewed-proposal.json`（每个变更一条）、`review-rounds.json`（多轮）、`review-waivers.json`（只读兼容） |
| 写入 | `review-runner.run` 带 `--point` 时，经 `flow-policy.begin/noteResult` | 兼容代理：`session.syncReviews` 从会话记录里认出审查结论后 `recordReview`；`review-runner.run` 在所有点都过了、或不带 `--point` 时也写一条 |
| 判断函数 | `flow-policy`：`points` `record` `passed` `settled` `pending` `allPassed` | `session`：`reviewRecord` `codeReviewed` `proposalReviewed` `codeReviewIssue` `syncReviewRounds` `reviewLoopIssue`；`task-types.tickIssue` |
| 谁在用 | 自动模式的审查点提示、打勾前查上一组、收工的人工提示、报告（10-16 起） | 归档门槛、提交检查的"审查没收尾"、收工检查的 `reviewOpenFor`、报告、计划状态（`session.js:1493`）、开工提示（`task-anchor.js:322`）、旧审查任务打勾 |
| 两套的连接点 | `reviewAllowed` = `allPassed` 或旧记录；`codeReviewIssue`、`reviewLoopIssue` 先看 `allPassed` | |

已经没有人用的：`verify-gate.js` 里的 `reviewLoopTodo`（只定义、没有调用）。配置里还留着 `reviewLoop`、`reviewMaxRounds`：`readConfigFor` 把 `reviewLoop` 强制设成自动模式开没开，但 `session.js:1493` 读的是原始配置（默认关），`kit-api.js` 的 `cleanConfig` 还按 1—5 收 `reviewMaxRounds`。

## 第一步：所有判断走一个入口（不改行为）

1. 在 `flow-policy.js` 加一个只读的汇总函数，例如 `reviewState(dir, mode)`，返回：
   - `points`：每个点的 `{ id, rounds, issues, status, settled }`；
   - `open`：有审过、还没收尾的点（`rounds > 0 && !settled`）；
   - `pending`：自动模式下一个该审的点；
   - `allSettled`：所有点都收尾；
   - `legacy`：旧记录给出的结论（兼容代理审过的、旧版本留下的），单独一个字段，不和新结论混在一起；
   - `summary`：给报告和状态栏用的一句话，例："审查点 group-1 审了 1 轮，上一轮报了 1 条，还没复审"。
2. 下面这些地方改成只读这个结果，判断条件照现在的逻辑写进汇总函数，**行为不变**：
   - `guard-commit.js` 提交检查里的 `open`（约 1458 行）和归档门槛（`archiveIssue`）；
   - `verify-gate.js` 的 `reviewOpenFor`；
   - `report.js` 的 `changeView`；
   - `session.js` 的计划状态（约 1493 行）、`reviewAllowed`、`codeReviewIssue`；
   - `task-anchor.js:322` 的开工提示。
3. 删掉 `reviewLoopTodo`。`kit/hooks/` 的文件不能删，删的只是里面没人调用的函数。
4. **验收**：全量回归不变（这一步只是改由同一个入口判断）。新加一组测试，在同一份状态下比对各处的结论：收工、提交、归档、报告、状态栏对同一个变更给的"收尾没有"必须一致。用 10-16 那几个缺陷的场景造数据：审过的文件又改了、部分覆盖、两个组一个过一个没过。

## 第二步：兼容代理的结论怎么算（要主人定）

AGENTS.md 硬规矩 9 允许"明确选择兼容方式时用审查代理，每个变更提案、代码各一次"。它审的是整套，没有点。两个选择：

- **A. 保留兼容代理**：它的结论按"整套"记，映射到当时所有已完成的点上，记录里标明来自兼容代理。之后某个点的输入变了，只让那个点失效。
- **B. 去掉兼容代理**：`reviewExecutor` 只留 `direct`，旧的 `reviewed*`、`review-rounds` 只读兼容一个版本后删掉；`syncReviews`、`reviewsIn`、`pendingReviewsIn` 跟着删。改动大，但以后只剩一套。

建议 B：10-14 以后自动模式已经不许用代理，人工模式也默认 `direct`。选 B 要改 AGENTS.md 硬规矩 9 和 decisions.md，所以先问主人。主人选定之前，第一步照样能做。

## 第三步：清理配置遗留

- `DEFAULT_CONFIG` 和 `kit-api.js` 里的 `reviewLoop`、`reviewMaxRounds`：不再起作用，删掉或标成只读兼容。两份默认值要一致（有测试比）。旧配置里有这两项时不报错。
- `review-waivers.json`：10-14 起不再写，读的地方只剩 `waived()`；确认没有旧数据依赖后去掉。
- `session.syncReviewRounds` 只凭 revisions.md 被改过就记成处理完：选 B 时随旧记账一起删；选 A 时改成只认 `review.js resolve` 的逐条处理。

## 测试要求

- 每一步都要有能在改之前的代码上失败的新断言（第一步是"口径一致"那组）。
- 受影响的专项：test-workflow1014、test-review-evidence、test-optimization-boundaries、test-proposal-review-state、test-feedback1013-review、test-1007、test-1008、test-feedback0929、两份 diff-hooks、全自动和经验规则两个端到端。
- 文档：architecture.md 的审查状态一节、decisions.md（选 A 或 B）、更新说明。
