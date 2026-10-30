---
name: ttls-cross-review
description: 逐个需求产物完成后审文档；每整组 1.x 完成后审代码；也用于用户明确的审查请求。默认脚本整理材料，经本机路由向独立模型发送有限请求，逐条核实意见。
---

# 独立审查

每个需求产物、每整组 1.x 是独立审查点。人工先 Ask 是否审查，用户主动要求就执行；自动按当前审查点的上限核验、修正、复验。材料分批不额外占轮数。上限只限制自动循环，不拒绝用户主动再审。审查不扩大需求，不代替测试。

## 默认执行方式

先读本机开关，默认 reviewExecutor=direct。自动逐点流程固定走有限请求；reviewExecutor=agent 只用于用户选择的人工整套兼容审查，每个变更提案、代码各一次。运行套件 tools/review.js，代码审查必须有开工前基线。apply 的真实用户许可会登记基线；缺基线用 git log 核对并明确 --base，不凭当前 HEAD 猜。

```bash
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode proposal --point proposal --project <项目>
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode code --point group-1 --project <项目> --base <已核对基线>
node "$HOME/.claude/vibe-kit/tools/review.js" run --mode code --project <项目> --base <改之前的提交>
node "$HOME/.claude/vibe-kit/tools/review.js" status --change <变更名> --mode code --project <项目>
node "$HOME/.claude/vibe-kit/tools/review.js" cancel --change <变更名> --mode code --project <项目>
```

--change 只认 openspec/changes 下已有的变更。不走 OpenSpec 的改动（小修复、改配置）用第三行，不带 --change，--base 写改之前的提交。壳子里几个仓库一起改的，--base 每个仓库写一个：`--base gwjh=11325fd --base .=32171c4`（等号前是相对 --project 的仓库路径）；只写一个不带等号的，只用在认得这个提交的仓库上。`review.js --help` 列着全部写法。

需求点用 proposal、specs、design、tasks；代码点用 group-1、group-2 等整组编号。status、cancel、resolve 使用相同 --point。运行失败或取消也计入这一点的轮数（审查不限时，见下面）。

执行器自行读核心产物、基线差异及未跟踪新文件，经本机路由的 sonnet 角色发送材料。目录说明和 revisions 中历史路径不进当前材料；大文件分片，全部片段成功才算覆盖。不给自己的结论，不让审查者自行搜索、编译或跑测试。每批显示尝试、回复和覆盖。超过文件上限或单文件 4MB 明确列为 partial，不默默截掉后算完成。

提案模式保留 design 的 Context、现状、背景全文，但不自动读取其中每条探索路径；结果 `contextOnly` 中的源码未审，不能说成已覆盖。必需的源码材料单独写 `审查材料：src/OrderService.java`（相对项目根目录）；其它章节当前引用和变更内 assets/references 材料仍读取。明确材料缺失、不可读或超限不能报完整，随提案交付的 assets/references 材料变化使旧结论失效；实施源码的变化由代码审查核对。不为躲上限删除探索依据，也不把全项目源码都列为必要材料。

- completed：取得完整结果，核对所有发现；不在团队 tasks 添加或打勾套件审查任务。
- partial、timed_out、cancelled、failed、interrupted、stale：交代已覆盖、未覆盖和原因，不算审完。单批失败会继续尝试剩余批；自动在当前点轮数以内修正后重试，达到上限就报告。人工重新审查先 Ask。
- running：已有同范围审查，查进度或取消，不能重复开审查。进程退出不再视为仍在运行，迟到结论不能批准新版。

审查不限时（2026-10-28 起）：每批都审完，配置页的秒数只是预期用时，超了套件自动记问题反馈，不用你记、不用 --new-budget。指定审查点的每次运行计入该点轮数，取消和中断也计数。模型只回思考没写结论的，套件自己加大上限、少想重试、拆半批。范围外目录链接、二进制和不可读材料列为未覆盖，不算完整审查。

归档内部实现不能靠解包到项目根来补材料。主会话先只读查看 JAR、ZIP、WAR 等归档；确需解包时在 `.vibe/tmp/<事由>/` 准备必要的非敏感文本，不把整个归档或解包目录交给审查者，也不将临时样本提交。兼容审查代理只读，不自行解包或写文件。

文件、需求或验收用例变了，旧结果失效；只有复选框进度变动不失效。默认不使用子代理；兼容开关选 agent 时只用现有 ttls-reviewer，第一行“模式：提案/代码/复审提案/复审代码”，第二行“变更：裸名”。最多读取配置的文件数，不运行测试、不递归开代理；等它审完，不因为超过预期用时取消。兼容代理的终止仍由主会话调用取消工具，套件不会杀 Claude 主进程。

已经有结论但闸门说没审过时，先诊断再决定是否补审。默认独立审查用 `review.js status --project <项目> --change <变更> --mode proposal|code`，失败阶段和脱敏片段在结果 JSON；兼容代理用 `review.js diagnose --project <项目> --transcript <当前会话记录>`，核对变更、模式、结果是否到达及预算。有可核对的完整结果再用相同参数执行 sync 补登记；缺失、失败、迟到或不完整的证据不记通过。套件阶段用 `tools/diagnose.js flow --session <当前会话编号>`，钩子耗时用 `diagnose.js hooks`；不用 node -e 调内部模块。

## 处理结果

提案审查核对四个产物、需求范围、探索依据、可验证任务和可交付材料。新增业务行为单列等用户确认，不能拿默认方案冒充已同意。必要非敏感材料放变更 assets/，相对引用并提交。同一套文档定稿提交一次；自动衔接按本轮两阶段状态执行。

代码模式在整组 1.x 实现完成后启动，下一组开始前完成本组审修。tasks 只放项目交付项。所有子项目、前后端与新文件在内；缺范围不能声称完整审查。

先展示本次完整问题清单。人工用一个提问框逐条让用户选“改（按推荐）/不改/自行输入”（一条一个问题，一框最多 4 条，多了分几框），不能把一个同意套在全部问题上；用户选了“改”的，改完直接自测或复验，不再问；别的复验：用户这一轮已经要求过的直接做，没要求过的先问。自动逐条核验，成立的修改并按验收用例复验，不成立的写事实依据；业务疑问用 Ask 沟通。

处理明细写本机 JSON：{"findings":[{"id":"r1","action":"fixed 或 rejected 或 accepted","reason":"具体依据"}]}。调用 review.js resolve --project <项目> --change <名字> --mode proposal|code --point <当前点> --decisions <文件>。fixed 需要当前输入的复验证据；没有复验许可就不调用 resolve 强行记通过。accepted 只能使用用户明确的不改决定。不改或放弃不等于通过。

业务修订同步相关文档并在改动处批注，revisions.md 只写业务原因和影响。请求失败、批次、预算、命令等诊断留本机，不写团队产物。不要生成每轮纯审查提交。

用户选择放弃审查或复验就直接继续，不执行 waive 登记，不写未审查、未测试或待办，不反复催补，也不声称通过。旧 waive 命令只返回 dismissed，不产生放弃记录。

意见逐条对应当前报告；零问题或仅驳回意见不能批准后来变化的输入。用户验收与归档仍由用户决定，push 另要许可。

经验规则复用原来的 lessons 自动收集；只记已核实、可复现且可能重复发生的规则，不把审查猜测沉淀成规范。
