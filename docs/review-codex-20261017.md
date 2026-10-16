# Codex 10-13 至 10-15 改动审核（2026-10-17）

只审不改。范围是提交 01fae35、55db4df、bf9a68b、368c933、74e7c32、cf15875、63805d5、376bcdd、42f049d、39870c5，对照的依据是 [decisions.md](decisions.md) 2026-10-14、2026-10-16 两段，[workflow-20261014.md](workflow-20261014.md)，[handoff-20261015.md](handoff-20261015.md) 的"2026-10-16 接手核对"，以及 [AGENTS.md](../AGENTS.md) 的硬规矩。

## 结论

- 逐个看了 10 个提交；39870c5 里的 `flow-policy.js` 全文，`session.js`、`guard-spec.js`、`guard-ask.js`、`guard-commit.js`、`verify-gate.js`、`task-anchor.js`、`review-runner.js`、`merge-push.js`、`install.js`、`router/kit-api.js`、`router/ui.html`、`after-tool.js`、`invocation.js`、`evidence.js`、`report.js`、`statusline.js`、`intent.js` 的改动，以及 `CLAUDE.md`、`rules/10-openspec.md` 模板的改动。
- 写了 11 个复现脚本，在假用户目录里跑真实钩子或库函数。**已复现 12 个问题**（11 个会出错、1 个有隐患），另有 4 个读代码怀疑的隐患和 7 条建议。
- 本机单独跑了 `node dev/test-workflow1014.js`：79 项全过。下面的问题现有测试都没覆盖。
- 最严重的四个：
  1. **问题 1**：`git add 提案 && git commit` 写在一条命令里，提案提交不再要用户确认（368c933 回退了旧版已有的拦截）。
  2. **问题 2**：自动提交选"我说了才提交"时，需求自动照样让模型提交文档，钩子也放行。
  3. **问题 3**：只开需求自动、Apply 自动关着，写需求阶段"我还没说开工"的打勾拦截可以被模型自己放行，不问用户。
  4. **问题 4、5、6**：逐点审查的计数和材料范围有三处缺陷：后面的组改到同一个文件，前面组的轮数被零问题复审耗光，自动模式卡死；同名变更重建后接着用旧轮数；组审查只送任务里点名的文件，没点名的改动从不审，却记成审过。
- 令牌保护（guard-read、guard-kit、redact、settings.fragment）这几次没有改动。push 的检查顺序里插入了 `actionIssue`，它只会多拦，不会少拦。`publish.js` 只在发布清单里加了 `验收清单.md`。合并推送仍要求最终文件树一致、不强推。两份 `DEFAULT_CONFIG` 一致，`flow-policy.js` 已进 `pack.js` 必备清单，`review-points`、`workflow-v2-migration` 已进 `GLOBAL_STATE`。钩子入口（`session.cli`、`hook-worker`）出错仍放行。

已修、本报告不重复的：resolve 把失败的点登记成通过；IDEA execute_tool 转发绕过自测先问；目录名带 test 被当成自测；只剩用户验收时不交全自动报告；收工和提交对审查收尾口径不一致；只改页面不问；归档后状态栏丢提示；验收清单没进发布清单；审查连接复用 ECONNRESET；"审一下"认不出；全自动报告不写逐点进度；两个端到端还按旧流程。

## 问题一览

| 编号 | 严重程度 | 证据 | 一句话 | 来源提交 |
|---|---|---|---|---|
| 1 | 会出错 | 已复现 | add 和 commit 同一条命令时，提案提交不再要确认 | 368c933 |
| 2 | 会出错 | 已复现 | autoCommit=off 时需求自动仍自动提交文档 | 39870c5 |
| 3 | 会出错 | 已复现 | 只开需求自动时，模型自己放行"没说开工就打勾" | 39870c5 |
| 4 | 会出错 | 已复现 | 后面的组改同一文件，前面组的轮数被零问题复审耗光，提交被永久拦 | 39870c5 |
| 5 | 会出错 | 已复现 | 同名变更重建后接着用旧轮数，一开始就"到上限" | 39870c5 |
| 6 | 会出错 | 已复现 | 组审查只送任务点名的文件，没点名的改动不审也不失效，却记成审过 | 39870c5 |
| 7 | 会出错 | 已复现 | 任务没有 1.1 这样的编号时，Apply 自动的审查路径走不通 | 39870c5 |
| 8 | 会出错 | 已复现 | 用户只说"编译一下"，跑测试、起服务、看页面都不用先问 | 39870c5 |
| 9 | 会出错 | 已复现 | 快到网关上限时，自动模式还催"继续下一项" | 39870c5 |
| 10 | 会出错 | 已复现 | config.json 读不懂时，安装和自动更新中途退出 | 39870c5 |
| 11 | 会出错 | 已复现 | OpenSpec 指令不支持的升级提示在真实失败事件下不出现 | 63805d5 |
| 12 | 有隐患 | 已复现 | 壳子不是 git 仓库时，需求文档审完没有任何下一步提示 | 39870c5 |
| 13 | 有隐患 | 读代码 | 提交确认里新加的 `git diff --cached` 超时或出错，整段确认被跳过 | 368c933 |
| 14 | 有隐患 | 读代码 | `readConfigFor` 每次都算流程状态，放在 guard-commit 最前面，一出错整道检查放行 | 39870c5 |
| 15 | 有隐患 | 读代码 | 带 `--point` 的审查每次重给满预算，绕过"累计预算""重开预算要用户同意" | 39870c5 |
| 16 | 有隐患 | 读代码＋前提已复现 | 双自动开着时，写需求阶段查库工具按全自动执行改库 | 39870c5 |
| 17—23 | 建议 | 读代码 | 见文末"建议" | — |

## 已复现的问题

复现脚本在本机工作目录的 `.vibe/tmp/codex-audit/`（受 Git 忽略，没有提交），文件名写在各项里。每个脚本都用 `dev/lib/harness.js` 的 `makeHome` 建假用户目录，跑完 `cleanup`，没碰真实用户目录。需要时照下面的步骤在 `dev/` 里写成正式测试。

### 1. add 和 commit 写在一条命令里，提案提交不再要确认

- **位置**：`vibe-kit/kit/hooks/guard-commit.js:1446-1451`（`consentIssue`），`:1482`（`onlyMetadata`）。
- **现象**：368c933 把"是不是提案提交"从"提交信息是 `docs: 提案` 或流程在写提案阶段"改成"现在暂存区里有没有提案产物"。PreToolUse 时 `git add` 还没执行，暂存区是空的，判断为不是提案提交。人工模式接着走到 `onlyMetadata`：要 add 的全在 `openspec/` 下，算"只有套件元数据"，直接放行。
- **复现**（`r1-proposal-commit.js`）：人工模式、`plainCommit=ask`，会话在写提案阶段，四个产物未跟踪，用户只说过"帮我写一个订单查询的提案"。

  | 命令 | 当前 | 20261013.2358 |
  |---|---|---|
  | `git add openspec/changes/add-x && git commit -m "docs: 提案 add-x"` | 放行 | 拦："提案提交要单独确认" |
  | 先真的 `git add`，再 `git commit -m "docs: 提案 add-x"` | 拦 | 拦 |

  自动模式（需求自动生效、档位 task）下同一条命令走 `cfg.autoMode` 分支，也被 `onlyMetadata` 放行，不检查四个审查点是否都过了（`automaticPlan` 要求的条件被绕开）。
- **违反**：decisions.md 2026-10-10"提案写、审、修完后立即询问是否提交"，2026-10-14"人工时提醒用户"；旧版已有的保护被放宽。
- **建议改法**：提案判断把 `st.added`（同一条命令里要 add 的文件）和已暂存的文件合在一起看，`onlyMetadata` 只豁免经验规则文件，不豁免 `openspec/changes/<名字>/` 下的四个产物。补测试：同一条命令 add + commit。

### 2. 自动提交选"我说了才提交"，需求自动照样提交文档

- **位置**：`guard-commit.js:1448-1450`（`automaticPlan` 在 `autoCommit === 'off'` 的检查之前返回），`flow-policy.js:80-87`（`planNext` 不看档位），`install.js` 的 `PROPOSAL_COMMIT`（约定文字"需求自动满足条件时自动提交"）。
- **现象**：需求自动生效、四个产物都审过时，收工检查让模型提交 `docs: 提案 c`，guard-commit 放行，不管 `autoCommit` 是不是 `off`。
- **复现**（`r9-plan-commit-off.js`）：`autoRequirements=true`、`autoApply=false`、`autoCommit=off`，四个点登记为零问题通过。收工提示"同一套需求文档已定稿，提交本变更的产物和用例一次 docs: 提案 c"；`git add` 之后 `git commit -m "docs: 提案 c"` 直接放行，会话里没有任何提交许可。
- **违反**：decisions.md 2026-10-14"自动提交关闭仍可提醒，不能擅自提交"；2026-10-10"'我说了才提交'不能被覆盖"。
- **建议改法**：`automaticPlan` 加 `cfg.autoCommit !== 'off'`；`planNext` 在 `off` 时改成提醒并用 Ask 问是否提交。README 第 322 行"需求自动符合条件时提交定稿"同步加上这个前提。

### 3. 只开需求自动，模型自己放行"没说开工就打勾"

- **位置**：`session.js:351`、`:364`（需求阶段 `planReady` 后 `readConfigFor().autoMode` 为 true），`feedback.js:319`、`:409`（全自动下申请放行不问用户），`guard-spec.js:241`（写提案阶段打勾的拦截属于可放行的 guard-spec）。
- **现象**：需求自动在写需求阶段生效后，所有"全自动"分支都按 Apply 阶段的规矩走，包括"被流程检查拦下自己申请放行、不问用户"。"我还没说开工"这条拦截挂在 guard-spec 上，可以放行，而且拦截提示末尾直接说"全自动模式……不要停下等我，申请放行再做一次"。
- **复现**（`r6-plan-stage-bypass.js`）：`autoRequirements=true`、`autoApply=false`、`kitBypass=ask`，写需求阶段，`planReady=true`。改 tasks.md 把 1.1 打勾：被拦，提示含"我还没说开工"和"〔拦截编号 …。全自动模式……申请放行〕"；跑 `feedback.js bypass <编号> --why …`，回复"放行申请登记好了……会直接放行"；再打勾，pre-edit 返回空，直接放行，没有弹确认框。
- **违反**：decisions.md 2026-10-14"双自动且允许实施时自动 apply，其余 Ask 给出 apply"；2026-10-07（用户定的）"在提案阶段打勾拦下"。Apply 自动关着，开工必须有用户许可。
- **建议改法**：写提案阶段的"没说开工就打勾"单独成一类不能放行的拦截（和 guard-ask 的 apply 拦截一样不带拦截编号）；或者 `requestBypass` 在 `flowStage === 'plan'` 时不按全自动处理。另外核对需求阶段生效的"全自动"还会影响哪些分支（见问题 16）。

### 4. 后面的组改同一个文件，前面组的轮数被零问题复审耗光

- **位置**：`flow-policy.js:34-43`（组指纹含组内点名文件的内容），`:50-55`（`begin`、`noteResult` 每审一次加一轮，不区分有没有问题），`:88-92`（`instruction`），`guard-spec.js` 打勾检查"先完成上一整组"，`guard-commit.js:1461`（有轮次且未通过就拦提交）。
- **现象**：组 2 改了组 1 点名过的文件，组 1 的指纹变了，变成未通过，自动模式按提示复审组 1，轮数 +1。组 3、组 4 再改同一个文件，组 1 的轮数就到了上限（默认 3）。之后组 1 一直"未通过"：提交被"审查还没收尾"拦（commit-ok 不能放行），再审要用户许可，自动模式停住。全程每一次审查都是零问题。
- **复现**（`r3-point-rounds.js`）：`autoApply=true`、`applyReviewMaxRounds=3`，四组任务都写"修改 a.js"，每组做完把失效的组和本组按零问题各审一次。输出：

  ```
  第 3 组做完并审过：group-1 轮=3 已过，group-2 轮=2 已过，group-3 轮=1 已过
  第 4 组做完并审过：group-1 轮=3 未过，…
  group-1 的提示：当前审查点 group-1 已达到 3 轮上限且尚未通过，停止自动循环并报告问题
  自动模式提交：[vibe-kit] 审查还没收尾，成立的问题全部修完、验证并审完后一起提交
  自动模式再审 group-1：该审查点已达到自动审查上限……没有当前用户的明确review许可
  ```
- **违反**：decisions.md 2026-10-14"每个点独立上限……到限未解决不算通过"——上限是给"审出问题、修了再审"的循环的，这里没有任何问题；交接 10-16 也写了"下一组的文件可能和上一组重叠"。
- **建议改法**：轮数只在"上一轮审出问题"之后的复审才加；因为后面的组改了文件而重审，不算这个点的修复轮次（可以单独记"复核次数"）。或者组指纹只看本组新增的差异。补测试：多组改同一文件、全程零问题，不能出现上限。

### 5. 同名变更重建后接着用旧轮数

- **位置**：`flow-policy.js:9`（`key = 目录|点名`），`:44`（`record`），记录里没有 `born`。
- **现象**：`review-points` 按变更目录的路径记。旧变更归档（目录搬走）后新建一个同名变更，路径相同，直接拿到旧变更的轮数。旧版的 `review-rounds` 记录有 `born`（`changeBorn`），重建的变更会重新计数。
- **复现**（`r3-point-rounds.js` 后半段）：把变更 c 的目录改名移走，新建同名的 c、组 1 已完成。`record(d,'group-1').rounds` 为 3，提示"已达到 3 轮上限且尚未通过"，自动模式不能审。
- **违反**：每个点独立计数（2026-10-14）；一个新需求一上来就被当成"审了 3 轮还没过"。
- **建议改法**：记录里带 `born: S.changeBorn(dir)`，`record` 读到 `born` 对不上的当作没有记录（和 `reviewLoopIssue` 一样的做法）。归档时顺手清掉这个变更的点记录。

### 6. 组审查只送任务点名的文件，没点名的改动从不审，却记成审过

- **位置**：`review-runner.js:124`（`--point` 时只保留 `pointFiles` 里的文件），`flow-policy.js:23-33`（`pointFiles` 只取任务文字"验："之前出现的路径），`:34-43`（组指纹只算这些文件），`session.js` 的 `codeReviewIssue`（`allPassed('code')` 为真就返回空）。
- **现象**：同一组实际改了几个文件，任务行里只写了一个，审查只送那一个。审完后再改没点名的文件，组指纹不变，仍算"已过"。归档检查、提交检查都按"代码审过了"处理。没有任何一次审查覆盖整个基线差异。
- **复现**（`r4-group-coverage.js`）：任务"1.1 修改 src/OrderService.js 增加查询"，实际改了 OrderService.js 和 OrderMapper.js（后者拼 SQL）。假路由记下送审文件：`src/OrderService.js、proposal.md、tasks.md`。结果 completed，`settled=true`，`codeReviewIssue` 为空。随后把 OrderMapper.js 改成 `eval(input)`，仍然 `settled=true`、`codeReviewIssue` 为空。
- **违反**：decisions.md 2026-10-14"不伪造通过""到限未解决不算通过"；2026-10-11"无问题结论不能批准之后新增的代码"。旧版代码审查送的是基线以来的全部差异。
- **建议改法**：组审查的材料用"本组完成时相对上一个审查点的全部差异"，至少把差异里没被任何组点名的文件归到当前组；组指纹也按这份材料算。最后一组过了之后加一次"未被任何点覆盖的差异"检查，有就不能记 `allPassed`。

### 7. 任务没有编号时，Apply 自动的审查路径走不通

- **位置**：`flow-policy.js:10-17`（`groups` 只认 `^\d+\.` 开头的任务），`:144-155`（自动模式审查必须带 `--point`），`review-runner.js` 的 `run`（点不存在就报错）。
- **现象**：guard-spec 不要求任务带编号。tasks.md 写成"- [ ] 修改 a.js 增加查询；验：…"时没有任何代码审查点：收工不提示审查，报告写"代码还没审完"；不带 `--point` 的 `review.js run` 被拦"自动审查必须指定当前审查点 --point group-1"；照提示带 `--point group-1`，执行器报错"审查点不存在或该任务组尚未完成"。兼容代理在自动模式下也被拦。
- **复现**（`r11-unnumbered-tasks.js`）：输出 `代码审查点：[]`、上面三句。
- **违反**：自动模式"每整组完成即审修"（2026-10-14）落空，且套件自己的两道检查互相堵死。
- **建议改法**：没有编号的任务整体算一个组（如 `group-all`），或者 guard-spec 写 tasks.md 时要求编号并给出照着改的例子；`actionIssue` 的提示只在点存在时给出 `--point group-1`。

### 8. 用户只说"编译一下"，跑测试、起服务、看页面都不用先问

- **位置**：`session.js:236`（`SAID.test` 含"编译、构建、快检"），`intent.js:13`（`TOPIC.test` 同上），用到它的 `flow-policy.js:159`（`actionIssue`）、`verify-gate.js` 的 `checking`、`guard-spec.js` 打勾检查。
- **现象**：39870c5 把"编译""构建""快检"放进了"明确要求自测"的词表。10-16 用户定了编译不算自测，但词表没改：用户说"编译一下"，就被当成明确要求自测，跑测试、起服务直接放行，收工检查还催看页面。
- **复现**（`r2-compile-as-test.js`）：人工模式。

  | 用户最后一句 | `mvn -q test` | devserver 起服务 | 改了 App.vue 收工 |
  |---|---|---|---|
  | 把 a.js 的变量改成 2 | 先 Ask | 先 Ask | 问审查和自测 |
  | 编译一下 / ……，然后编译一下 / 改完再构建一下 | 直接放行 | 直接放行 | 催"按 /ttls-see-page 跑受影响的页面" |
- **违反**：decisions.md 2026-10-16（用户定的）"编译、类型检查、静态检查不算自测……跑测试、起服务、看页面才算自测，先 Ask"。
- **建议改法**：`SAID.test`、`TOPIC.test` 去掉"编译、构建、快检"；"验证"含义宽（"验证一下能编译过"），建议也去掉或要求后面跟"测试/页面/接口"。补反例测试。

### 9. 快到网关上限时，自动模式还催"继续下一项"

- **位置**：`verify-gate.js:570-584`（`autoModeTodo`）。旧版第一行有 `if (used && nearGatewayLimit(used)) return [];`，39870c5 删了，函数注释里"快到网关上限也不催"还在（`:568`）。默认的 `contextStrategy=compact` 下 `autoHandover` 直接返回，没有别的地方兜。
- **复现**（`r5-gateway-limit.js`）：`state/gateway.json` 实测上限约 10 万 token，会话最后一次用量 9.5 万（过了 85%），还剩 1.2。当前版本收工："Apply 自动模式：继续当前范围的下一项 1.2……"；20261013.2358 停下交全自动报告。
- **违反**：decisions.md 2026-10-05 的网关硬限制处理；注释和代码对不上（AGENTS.md"文档和代码对不上以代码为准，并指出来"）。
- **建议改法**：把那一行加回 `autoModeTodo`；`flow-policy.stop` 自动模式的审查指令同样在快到网关上限时不发。

### 10. config.json 读不懂时，安装和自动更新中途退出

- **位置**：`install.js:778-790`（一次性迁移里的 `JSON.parse` 没有 try）。上面 `:771-775` 处理同一个文件时写的是"读不懂就不动"。
- **复现**（`r7-migration-corrupt.js`）：假用户目录装着 20261013.2358，config.json 多一个逗号，用当前安装包安装：退出码 1，"安装做到一半出错了：Expected double-quoted property name"；新版 lib（flow-policy.js）已拷进去，settings.json 没登记钩子，全局约定没生成，迁移标记没写。用 20261013.2358 的包对照：退出码 0，正常装完。自动更新跑的是同一个 install.js，每次都会失败。
- **违反**：AGENTS.md 硬规矩 2 的精神（出错不能把用户卡住）；"装了一半"的状态比不装更糟。
- **建议改法**：迁移块包 try：读不懂就按默认值重写一份并备份原文件，或者跳过迁移、不写迁移标记、打印一行"[!] config.json 读不懂，两个自动模式按关闭算，在配置页保存一次"。

### 11. OpenSpec 指令不支持的升级提示在真实失败事件下不出现

- **位置**：`vibe-kit/kit/hooks/after-tool.js:31-32`。
- **现象**：只读 `j.tool_response.stderr/stdout/error`。docs/claude-code-facts.md 第 100 行记着三版 CLI 实测：失败的 Bash 走 PostToolUseFailure，顶层带 `error`，没有 `tool_response`。旧 OpenSpec 遇到不认识的指令会以非零退出，所以提示永远不出现。test-workflow1014 里用的是 `tool_response.stderr` 的形状，测试能过。
- **复现**（`r10-openspec-unknown.js`）：同一条 `openspec instructions proposal --change add-a`，输入 `{hook_event_name:'PostToolUseFailure', error:"Exit code 1\nerror: unknown command 'instructions'"}`：没有提示；换成测试里的形状：出提示。
- **违反**：decisions.md 2026-10-14"不支持指令时提示使用者核对版本并自行升级"（F16）。
- **建议改法**：`output` 加上 `j.error`；测试改用实测的输入形状。

### 12. 壳子不是 git 仓库时，需求文档审完没有任何下一步提示

- **位置**：`flow-policy.js:80-83`（`planNext` 里 git 出错直接返回空串），`:75-76`（`automaticApply` 同样）。
- **现象**：`planNext` 和 `automaticApply` 都假定 `openspec/changes/<名字>` 往上三层是 git 仓库。glossary 里壳子"外面一层放 openspec、文档、.claude，不放代码"，壳子本身可以不是 git 仓库。这时既不提示提交，也不提示"用 Ask 给出 apply / 继续修改 / 暂不执行"。
- **复现**（`r8-shell-plan-next.js`）：需求自动、四个点通过。壳子是 git 仓库时收工提示"同一套需求文档已定稿，提交……"；壳子不是 git 仓库时只给一份全自动报告，报告还写"提案还没审"（见建议 21）。
- **违反**：decisions.md 2026-10-14"其余 Ask 给出 apply、继续修改、暂不执行"。
- **建议改法**：git 出错时跳过"提交"这一步，照常发"用 Ask 给出 apply / 继续修改 / 暂不执行"。

## 读代码怀疑的隐患

### 13. 提交确认里新加的 `git diff --cached` 出错，整段确认被跳过

- **位置**：`guard-commit.js:1446`（没有 try、没有 `stdio: ignore`），调用处 `:1645`（`try { c = consentIssue(...) } catch (e) { c = '' }`）。
- **怀疑**：`consentIssue` 后面还管着"自动提交档位""不走 OpenSpec 的提交要用户点头"（commit-ok，不能放行）。368c933 在这些判断前面加了一条 3 秒超时的 git 调用，超时或出错就整段返回空，提交不经确认放行。反馈 #110 记的就是现场 Git 超时。没有现场就没复现。
- **建议改法**：这条调用包 try，出错时按"是提案提交"处理（更严的一边），或者直接复用 `onlyMetadata` 已经取过的暂存列表。

### 14. `readConfigFor` 每次都算流程状态，一出错 guard-commit 整道放行

- **位置**：`session.js:349-355`，`guard-commit.js:1763`。
- **怀疑**：39870c5 之前两个开关都关时 `readConfigFor` 只读配置就返回；现在每次都调 `flowView`：apply-scope 的范围哈希、任务解析，任务都做完时还会算各组指纹（组里没有点名文件时会调 `W.fingerprint`，git 读不出时抛"Git 状态暂时无法读取"）。它在 guard-commit 第一行，在禁改、读令牌、push、发布这些检查之前，出错就整条命令放行（入口 fail-open）。人工模式的用户也承担这份开销和风险。
- **建议改法**：`readConfigFor` 内部 try，出错时 `autoMode=false`（按有人在算，更严）并记一条问题反馈；或者 guard-commit 先做禁改、令牌、push 这几道再读流程状态。

### 15. 带 `--point` 的审查每次重给满预算

- **位置**：`review-runner.js:243`（`opts.newBudget || opts.point ? 0 : …`）。配置页"同一范围审查总预算"同时改成了"每次审查的时间预算"。
- **怀疑**：decisions.md 2026-10-11"预算许可在启动尝试时用掉，失败和取消仍累计时间，不能凭同一句话无限重开"。逐点审查不再累计，`--new-budget` 要用户同意的检查（`budgetIssue`）对逐点审查形同虚设。自动模式靠轮数上限兜着：一个变更最多（4 个文档点 + 组数）× 上限轮数 × 单次预算，上限可调到 20 轮、单次 1800 秒。这是改了用户授权过的成本规则，决定里没有记。
- **建议**：交主人确认是否接受"每轮单独预算"；接受就记进 decisions.md，不接受就恢复按点累计。

### 16. 双自动开着时，写需求阶段查库工具按全自动执行改库

- **位置**：`guard-commit.js:1748`（`noteToolFlow` 按 `cfg.autoMode` 写条子），`skills/ttls-db-crud/scripts/db.py` 的 `auto_mode()`（配置里 `autoMode`，即 Apply 开关，为真且条子说 auto 就按全自动）。
- **怀疑**：问题 3 的复现已经确认写需求阶段 `readConfigFor().autoMode` 为 true。Apply 自动也开着时，写需求阶段跑查库工具，条子写 `auto: true`，改库不再要确认串（留得下快照的直接执行）。2026-09-30 定"全自动下改库留得下快照就做"时，全自动只在 Apply 阶段生效。
- **建议改法**：`noteToolFlow` 只在 `flowStage === 'apply'` 时写 `auto: true`。

## 建议

17. **自动更新的迁移会把正在跑的全自动会话改成人工**（`install.js:778-790`）。夜里挂着的会话被后台更新到这一版，两个开关关掉，下一次收工按人工模式提示"用 Ask 问"，停在提问框上等到早上。这是用户定的"升级关闭一次"的直接结果，但用户可能没想到会在运行中生效。建议交主人确认：有活跃 Apply 会话时推迟迁移，或在更新说明里写明。
18. **降级再升级会丢掉用户的选择**（`session.js:24`）。旧版配置页保存时会把文件里已有的 `autoApply:false` 原样写回，用户在旧版打开"全自动"只改了 `autoMode`；再升级时迁移标记已在，`autoApply` 字段存在就以它为准，用户的选择丢了（安全方向）。
19. **`router/kit-api.js` 的 `cleanConfig` 与 `readConfig` 对别名的处理不一样**：文件只有 `autoMode:true`、没有 `autoApply` 时，钩子按 Apply 开着算，配置页显示关着。正常安装和迁移后不会出现，测试支架的配置会。建议两边用同一条规则。
20. **`review-points.json` 从不清理**：在 `GLOBAL_STATE` 里，不按文件时间删，`cleanState` 的 60 天条目清理名单里也没有它。做完问题 5 的 `born` 后可以一起加进清理名单。
21. **报告里的提案状态还看旧记录**（`report.js:112` 用 `proposalReviewed`）。逐点审查经 `resolve` 处理通过（不是零问题完成）时不会写旧记录，报告说"提案还没审"，和审查点、状态栏不一致。建议改用 `reviewAllowed('proposal')`。
22. **需求自动资格完全由模型自报**（`flow-policy.js:56-68`，`tools/workflow.js qualify`）。`--session`、`--transcript` 都由模型传，`unresolved: []` 是否属实套件无法核对，唯一的确定性条件是"读过项目文件"。这是设计取舍，建议在 decisions.md 写明，并考虑要求最近一轮用户消息里没有问句、或模型最近一次 Ask 已得到回答。
23. **手册和代码对不上的几处**（交给正在改手册的会话）：README 第 923 行"点名的文档修订可连同需求文档和计划表归组"已被 376bcdd 取消（现在只认"源自 <变更> <任务号>"和"事件："）；README 第 264 行"开关防篡改"只说了两个开关，封条现在也管需求自动、Apply 自动；README 第 322 行见问题 2。另外 `autoCrossReview`、`reviewLoop`、`reviewMaxRounds` 已不起作用（`readConfigFor` 用 `autoMode` 覆盖 `reviewLoop`），只剩在 `DEFAULT_CONFIG` 里；`kit-api.js` 注释"多轮审查最多几轮：1 到 5"与 `reviewMax` 的 20 不一致。

## 复现脚本清单

都在 `.vibe/tmp/codex-audit/`，用 `node .vibe/tmp/codex-audit/<文件名>` 跑，每个十几秒到一分钟，跑完自己清临时目录。

| 脚本 | 对应问题 |
|---|---|
| r1-proposal-commit.js | 1（含 20261013.2358 对照） |
| r2-compile-as-test.js | 8 |
| r3-point-rounds.js | 4、5 |
| r4-group-coverage.js | 6 |
| r5-gateway-limit.js | 9（含 20261013.2358 对照） |
| r6-plan-stage-bypass.js | 3、16 的前提 |
| r7-migration-corrupt.js | 10（含 20261013.2358 对照） |
| r8-shell-plan-next.js | 12、21 |
| r9-plan-commit-off.js | 2 |
| r10-openspec-unknown.js | 11 |
| r11-unnumbered-tasks.js | 7 |
