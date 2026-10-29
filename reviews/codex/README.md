# vibe-kit 三轮审核

审核日期：2026-10-29 至 2026-10-30（北京时间）。审核基线：`6c9dfa4d190150337adab005d29f3a911138642e`，套件版本：`20261028.2041`。

用户要求：批判性审核整套套件，连续三轮使用不同模型的最新可用版本，提出改进思路，全部保存在 `reviews/codex`，完成后提交并推送。

先读 [综合报告](20261030-vibe-kit-三轮审核综合.md)，再看 [改进路线](20261030-vibe-kit-改进路线.md)。最终保留 21 项确认问题（P1 7、P2 13、P3 1）及 1 项待真实数据库验证的风险。各轮原始判断和后续裁定均保留。

提交前合入远端 `8013ef4` 的报告目录与命名规范，因此五份报告按日期重命名；分析结论未因重命名改变。套件源码未变，文档差异见 [合入记录](evidence/upstream-integration.json)。

## 执行方式

准备核验由主代理完成；正式三轮顺序执行。第 1 轮独立检查，第 2 轮复核第 1 轮并扩大检查，第 3 轮反驳前两轮、裁定证据并补查遗漏。三轮均保留原始报告。后轮修正不会覆盖前轮原文，最终结论以综合报告为准。

| 轮次 | 模型标识 | 状态 | 报告 |
|---|---|---|---|
| 第 1 轮 | `gpt-6.1-sol` | 已完成 | [20261029-vibe-kit-第一轮-sol.md](20261029-vibe-kit-第一轮-sol.md) |
| 第 2 轮 | `gpt-6.1-terra` | 已完成 | [20261029-vibe-kit-第二轮-terra.md](20261029-vibe-kit-第二轮-terra.md) |
| 第 3 轮 | `gpt-6-astra` | 已完成；额度恢复后续完 | [20261030-vibe-kit-第三轮-astra.md](20261030-vibe-kit-第三轮-astra.md) |

模型选择依据：本环境可调用模型名单，以及审核时读取的 [OpenAI 官方模型目录](https://developers.openai.com/api/docs/models)。使用当前标识，不声称锁定了工具未返回的具体模型快照。

## 已有核验

- 基础全量回归：64 套、3498 项通过，0 项失败，约 24 分钟。
- 自维护 JavaScript：177 个文件语法检查通过；文件清单共 275 项，套件自维护 JS/Python/Java 共 31329 行。
- 数据库技能：13 个 Python 文件语法检查通过；3 套离线自测通过，其中 SQL 分类器 83 项。
- 已保存 19 条动态观察：F01—F15、G01—G04。复现脚本的“命中”表示观察到了缺陷或风险路径，不表示产品功能正确。
- 连续桌面监视记到 7 次可见窗口出现，进程为 ChatGPT、msedgewebview2、Widgets；归属未确认。回归末尾没有遗留窗口或测试目录。不能据此宣称全程没有弹窗。

机器没有可用 Java/JDK，也未发现文档指定的 Claude Code 测试版本，因此没有运行真实 JDBC/H2 和多版本 Claude Code 端到端。数据库提交故障仅做了 Python 错误分支注入，不能当作 JDBC 提交故障已复现。

## 证据与复现

| 文件 | 内容 |
|---|---|
| [evidence/inventory.json](evidence/inventory.json) | 路径、行数、哈希、语法和内置依赖版本 |
| [evidence/regression-summary.txt](evidence/regression-summary.txt) | 64 套回归的逐套汇总 |
| [evidence/dynamic-results.json](evidence/dynamic-results.json) | 每条动态观察及核验层级 |
| [evidence/round3-results.json](evidence/round3-results.json) | 第三轮进程归属、兼容审查、安装失败的 4 条观察 |
| [evidence/execution.json](evidence/execution.json) | 执行结果、窗口计数和未验证范围 |
| [reproduce.cjs](reproduce.cjs) | 迁移清理、验证误记、Maven、提案处理、源码删除、Node 版本入口 |
| [router-reproduce.cjs](router-reproduce.cjs) | 假网关验证半截流和累计等待；约一分钟 |
| [supplemental.cjs](supplemental.cjs) | 离线 Python 自测、服务登记并发、提交错误提示、确认串双消费 |
| [edge-reproduce.cjs](edge-reproduce.cjs) | 清理扫描截断、Redis TTL、临时裸仓库部分推送 |
| [hook-fault.cjs](hook-fault.cjs) | HTTP 工作线程退出后的放行及反馈 |
| [round3-reproduce.cjs](round3-reproduce.cjs) | 路由进程归属、兼容审查输入绑定、整套提案处理 |
| [install-fault.cjs](install-fault.cjs) | 路由启动失败时安装退出码和 updater 自检 |
| [validate.cjs](validate.cjs) | 报告完整性、编码、链接、脚本语法和基线文件哈希 |

```powershell
node reviews/codex/reproduce.cjs
node reviews/codex/router-reproduce.cjs
node reviews/codex/supplemental.cjs <Python完整路径>
node reviews/codex/edge-reproduce.cjs
node reviews/codex/hook-fault.cjs
node reviews/codex/round3-reproduce.cjs
node reviews/codex/install-fault.cjs
node reviews/codex/validate.cjs
```

所有动态操作均使用 `dev/lib/harness.js` 的假用户目录、假项目、本机假服务或临时裸仓库。不修改套件源码，不访问真实业务库，不执行内网发布。

`inventory.cjs` 生成基线清单；`collect-evidence.cjs` 整理本次 `.vibe/tmp/codex-audit-20261029/` 下的实际日志。它们用于本轮材料生成，不能替代重新运行复现。原始临时日志在交付前清理，生成器此后会因日志缺失报错；已发布的 JSON 和回归摘要保留，可直接阅读。

## 续接记录

用户已授权在额度恢复后自动继续。已建立本聊天每 30 分钟检查一次的续接安排，标识 `vibe`；正常工作、额度未恢复或没有新进展时保持安静。三轮报告、综合核验、提交和 push 全部完成后关闭该安排。若中断，应先检查现有代理与文件，继续未完成轮次，不重复已经完成的回归。
