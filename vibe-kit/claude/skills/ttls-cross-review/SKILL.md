---
name: ttls-cross-review
description: 提案写好且 apply 前审提案；实现和必要测试完成后审代码；也用于用户明确的审查请求。默认脚本整理材料，经本机路由向独立模型发送有限请求，逐条核实意见。
---

# 独立审查

提案和代码各审一次。审查不扩大需求、不执行项目命令，不代替测试。探索和提案仍与用户沟通；用户明确 apply 后按现有任务实施。

## 默认执行方式

先读本机开关，默认 reviewExecutor=direct。运行套件 tools/review.js，代码审查必须有开工前基线。apply 的真实用户许可会登记基线；缺基线用 git log 核对并明确 --base，不凭当前 HEAD 猜。

```bash
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode proposal --project <项目>
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode code --project <项目> --base <已核对基线>
node "$HOME/.claude/vibe-kit/tools/review.js" status --change <变更名> --mode code --project <项目>
node "$HOME/.claude/vibe-kit/tools/review.js" cancel --change <变更名> --mode code --project <项目>
```

执行器自行读核心产物、基线差异及未跟踪新文件，经本机路由的 sonnet 角色发送材料。目录说明和 revisions 中历史路径不进当前材料；大文件分片，全部片段成功才算覆盖。不给自己的结论，不让审查者自行搜索、编译或跑测试。总预算默认 300 秒，每批显示尝试、回复、覆盖和剩余秒数，整个运行累计计算。超过文件上限或单文件 4MB 明确列为 partial，不默默截掉后算完成。

提案模式保留 design 的 Context、现状、背景全文，但不自动读取其中每条探索路径；结果 `contextOnly` 中的源码未审，不能说成已覆盖。必需的源码材料单独写 `审查材料：src/OrderService.java`（相对项目根目录）；其它章节当前引用和变更内 assets/references 材料仍读取。明确材料缺失、不可读或超限不能报完整，随提案交付的 assets/references 材料变化使旧结论失效；实施源码的变化由代码审查核对。不为躲上限删除探索依据，也不把全项目源码都列为必要材料。

- completed：取得完整结果，核对所有发现；代码审查任务立即勾，发现问题也可以勾审查。
- partial、timed_out、cancelled、failed、interrupted、stale：交代已覆盖、未覆盖和原因，审查任务不勾，不自动无限重启；需要新预算由用户明确决定，再使用 --new-budget。
- running：已有同范围审查，查进度或取消，不能重复开审查。进程退出不再视为仍在运行，迟到结论不能批准新版。

取消与中断累计已用预算，不能靠反复取消重启延长。用户明确重开当前变更预算后再用 --new-budget，一句许可只批准一次启动，失败也不能重用。范围外目录链接、二进制和不可读材料列为未覆盖，不算完整审查。

归档内部实现不能靠解包到项目根来补材料。主会话先只读查看 JAR、ZIP、WAR 等归档；确需解包时在 `.vibe/tmp/<事由>/` 准备必要的非敏感文本，不把整个归档或解包目录交给审查者，也不将临时样本提交。兼容审查代理只读，不自行解包或写文件。

文件、需求或验法变了，旧结果失效；只有复选框进度变动不失效。默认不使用子代理；兼容开关选 agent 时只用现有 ttls-reviewer，第一行“模式：提案/代码/复审提案/复审代码”，第二行“变更：裸名”。最多读取配置的文件数，不运行测试、不递归开代理；到预算只取消已登记的审查任务，保留部分结果并收工。兼容代理的终止仍由主会话调用取消工具，套件不会杀 Claude 主进程。

已经有结论但闸门说没审过时，先诊断再决定是否补审。默认独立审查用 `review.js status --project <项目> --change <变更> --mode proposal|code`，失败阶段和脱敏片段在结果 JSON；兼容代理用 `review.js diagnose --project <项目> --transcript <当前会话记录>`，核对变更、模式、结果是否到达及预算。有可核对的完整结果再用相同参数执行 sync 补登记；缺失、失败、迟到或不完整的证据不记通过。套件阶段与推送回执用 `tools/diagnose.js flow|push --session <当前会话编号>`，钩子耗时用 `diagnose.js hooks`；不用 node -e 调内部模块。

## 处理结果

提案审查核对四个产物、需求范围、探索依据、可验证任务和可交付材料。新增业务行为单列等用户确认，不能拿默认方案冒充已同意。必要非敏感材料放变更 assets/，相对引用并提交。提案收尾问是否提交，提交与 apply 分别授权。

代码模式在实现和必要测试完成后启动，不等审查和用户验收任务打勾。所有子项目、前后端与新文件在内；缺范围不能声称完整审查。

逐条核实实际错误与隐患：成立的修复并复验；不成立写可核对理由；拿不准涉及业务范围时等用户决定。把记录写进变更 revisions.md，不生成每轮纯审查提交。

意见处理可写本机 JSON：{"findings":[{"id":"r1","action":"fixed 或 rejected","reason":"具体证据与复验结果"}]}，用 review.js resolve --project <项目> --change <名字> --decisions <文件> 登记。成立问题需要当前输入的成功验证。没有问题且代码未变化可直接勾意见处理。兼容代理按结论的问题顺序使用 r1、r2 等编号，逐条核对并记 revisions.md，也可用 resolve。用户明确接受成立问题时使用 accepted，理由写明用户决定；工具执行前检查当前真人许可，不能由模型自己接受风险。

用户明确选择不审或不再复审时，交代当前覆盖与未解决问题，在 revisions.md 记录决定，再执行 `review.js waive --project <项目> --change <变更> --mode proposal|code --reason "用户决定与已完成验证"`。结果为 waived，代码模式在审查任务上标明用户跳过，不报成审查通过。该记录只对当前输入有效；新代码、需求或验法不能借旧决定。没有用户决定时继续既有审查流程；全自动也不能自行 waive。

每条意见精确对应一个处理项。零问题或仅驳回意见不能批准后来修改的代码；重新审查后重新核实当前报告，不能继承上一轮处理许可。

用户验收任务仅在用户明确确认本次交付满意后勾，归档另等用户说归档。非 OpenSpec 改动、提案提交仍先问用户；代码修复提交按既有档位，不审一轮提交一轮，不自行 push。

经验规则复用原来的 lessons 自动收集；只记已核实、可复现且可能重复发生的规则，不把审查猜测沉淀成规范。
