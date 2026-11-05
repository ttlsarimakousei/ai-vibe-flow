---
name: vk-cross-review
description: 四份需求文档写完后审整套；一个 change 的任务全部做完后审代码；也用于用户明确的审查请求。脚本调 claude -p 审，逐条核实意见。不开子代理。
---

# 审查

审查点有两个：四份需求文档写完审一次整套（tasks）；这个 change 的任务全部做完审一次整个 change 的改动（change）。人工先 Ask 是否审查，用户主动要求就执行；自动核验、修正、复验。审修不设次数上限，没有 P1、P2 就算过。审查不扩大需求，不代替测试。

## 怎么审

不开子代理。一条命令审完：脚本备好材料，后台调 `claude -p`，等结果，结论和下一步（`next`）都在输出里。

```bash
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode proposal --point tasks --project <项目>
node "$HOME/.claude/vibe-kit/tools/review.js" run --change <变更名> --mode code --point change --project <项目> --base <已核对基线>
node "$HOME/.claude/vibe-kit/tools/review.js" run --mode code --project <项目> --base <改之前的提交>
```

1. Bash 的 timeout 写 600000，不用放后台。最多等 9 分钟，输出 `running` 就再跑一次一样的命令接着等，不会重开。这期间不要改文件：改了这一轮就作废。
2. 照结果里的 `next` 做。`need` 是审查者想看、材料里没有的：能一两步查清的自己用 Grep、Read 查，查出问题按问题处理；查不清的写进交代，不用为它再审一轮。

--change 只认 openspec/changes 下已有的变更。不走 OpenSpec 的改动（小修复、改配置）用第三行，不带 --change，--base 写改之前的提交。壳子里几个仓库一起改的，--base 每个仓库写一个：`--base gwjh=11325fd --base .=32171c4`（等号前是相对 --project 的仓库路径）；只写一个不带等号的，只用在认得这个提交的仓库上。`review.js --help` 列着全部写法。代码审查要有开工前基线：apply 的真实用户许可会登记；缺基线用 git log 核对并明确 --base，不凭当前 HEAD 猜。

需求文档用 tasks，代码用 change。用户点名只审一份文档、一组任务的，才用 proposal、specs、design 或 group-1、group-2；那一份要写好、那一组要做完，不算必审的点。status、cancel、resolve 使用相同 --point。

每轮审什么：第一轮按材料大小 1～3 个角度，只看这次需求碰到的地方；后面的轮只审修改点，脚本自己比，不要把没改的内容再送一遍。用户要整份再审才加 --full。文件没改又没处理的问题不会因为再审一次消失。每轮的问题和处理结果脚本记在 .vibe/reviews/<变更>/审查记录.md。

状态：

- running：还在审。再跑一次一样的命令接着等；已交的角度不重开，正在跑的不重开。
- completed：取得完整结果，核对所有发现。二进制、超 4MB、敏感文件列在 `uncovered`，不算没审完。
- partial：有明确指定的材料或基线缺了，看 `skipped`，处理完再审。
- failed、stale、cancelled、interrupted：交代已覆盖、未覆盖和原因，不算审完。stale 是审查期间文件变了：报的问题照样核实、改，再 prepare 一次，只审改过的地方。
- 连续 3 次没拿到结论：不再催，这个点算没审成，写进报告接着往下；用户说审再审。

提案只写需求、范围、验收和事实。审查意见要的算法步骤、字段规则这类实现细节写进 design，不要写进提案。

归档内部实现不能靠解包到项目根来补材料。主会话先只读查看 JAR、ZIP、WAR 等归档；确需解包时在 `.vibe/tmp/<事由>/` 准备必要的非敏感文本，不把整个归档或解包目录交给审查者，也不将临时样本提交。

文件、需求或验收用例变了，旧结果失效；只有复选框进度变动不失效。

## 处理结果

提案审查核对四个产物、需求范围、探索依据、可验证任务和可交付材料。必要非敏感材料放变更 assets/，相对引用并提交。同一套文档定稿提交一次。

代码模式在这个 change 的任务全部做完后启动，审修完再接下一个 change。tasks 只放项目交付项。所有子项目、前后端与新文件在内。

先展示本次完整问题清单。人工用一个提问框逐条让用户选"改（按推荐）/不改/自行输入"（一条一个问题，一框最多 4 条，多了分几框），不能把一个同意套在全部问题上；用户选了"改"的，改完直接复验，不再问；别的复验：用户这一轮已经要求过的直接做，没要求过的先问。自动逐条核验，成立的修改并复验，不成立的写事实依据；业务疑问用 Ask 沟通。

处理明细写本机 JSON：{"findings":[{"id":"r1","action":"fixed、rejected、accepted 或 deferred","reason":"具体依据"}]}。调用 review.js resolve --project <项目> --change <名字> --mode proposal|code --point <当前点> --decisions <文件>。代码的 fixed 需要当前输入的复验证据（文档不用）。P1、P2 修了要再审一轮，P3 修了不用。accepted 只能使用用户明确的不改决定。deferred 只有用户点名审单份文档时能用：实现细节留给后面的文档，审 design、审整套的第一轮会带上这些要点；审整套（--point tasks）不能标 deferred。

业务修订（定稿后改需求、用户加了要求）同步相关文档并在改动处批注，revisions.md 只写业务原因和影响。定稿前按审查意见改文档不写批注、不记 revisions，过程在审查记录里。不要生成每轮纯审查提交。

用户选择放弃审查或复验就直接继续，不写未审查、未测试或待办，不反复催补，也不声称通过。

意见逐条对应当前报告；零问题或仅驳回意见不能批准后来变化的输入。用户验收与归档仍由用户决定，push 另要许可。

范围外建议（审查者标 scope: out 的）不算问题，人工核验时列给用户。经验规则由脚本自动收；只记已核实、可复现且可能重复发生的规则。
