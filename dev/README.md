# dev：测试和打包

改套件用的脚本。不进安装包，装套件的人用不到。

以前这些脚本放在会话的临时目录里，换一台机器就没了，所以挪到这里。

## 怎么用

`test-feedback1007.js auto [旧套件目录]` 验证导出的 #11 至 #17：包装命令、否定归因、审查路径、push 授权、内网发布单独确认、ASCII 确认串和空条件文件。新增数据库文件确认和 JSON 截断验证在 `test-dbcrud.js auto`。旧版 20261007.1653 的专项测试有失败，新版全部通过；#14 的外部技能没有打进套件。

不给 run-all 的 --rt 时，专项只测 Node 钩子，不要求 Python；加 --rt auto 才测数据库参数和 H2。

打包器明确加载 Windows PowerShell 自带的 Archive 模块，避免宿主的 PSModulePath 指向另一份 PowerShell 导致压缩失败；不改系统执行策略。

```bash
node dev/run-all.js
```

加上新旧对比、端到端、连真的 JDBC 数据库：

```bash
node dev/run-all.js --old dev/baseline/20261005.0302/vibe-kit --old dev/baseline/20261001.0303/vibe-kit --claude <claude.exe> --claude <另一个版本的 claude.exe> --rt auto
```

`--old` 可以给几个，新旧对比每个都比一遍。有意改过的地方每一项记着是哪一版改的：拿来比的上一版比它老，两版应该不一样；上一版已经带着这个改动，两版应该一样。

`diff-hooks.js` 的假项目使用 harness 默认的系统临时目录，不把 `TEMP`、`TMP` 覆盖成仓库的 `.vibe/tmp`；否则整个假项目会被识别为过程目录，解包、备份和页面检查的测试前提失效。它只把归档命令作为钩子输入，不执行解包，日志仍放 `.vibe/tmp/<事由>/`。

`--rt` 是查库的技能要的运行环境，见下面"查库的运行环境"。`auto` 是到正式装的位置去找。不给的话连库的那一套不跑，端到端里查库的几项不测。

打包：

```bash
node dev/stamp-and-pack.js
```

它先把《更新说明.md》里两处占位 `@@VER@@` 换成现在的时间（年月日.时分），再跑 `pack.js --version <版本号>`。版本号自己定、或者更新说明里已经写好版本号的，直接跑 `pack.js`：

```bash
node dev/pack.js
```

包名带完整的版本号，比如 `vibe-kit-20260928.1700.zip`：一天发几版，文件名都不一样。打包时顺手在 `dev/baseline/<版本号>/` 留一份这一版的代码（不带看页面的依赖，一兆左右），下一版做新旧对比时当"上一版"用，只留最近四份。

## 都有什么

| 文件 | 干什么 |
|---|---|
| `run-all.js` | 依次跑下面的测试，汇总；结尾查桌面有没有多出窗口、临时目录清没清 |
| `pack.js` | 检查、写版本号、压成 zip、解压出来逐个文件核对 |
| `test-lessons.js` | 经验规则：记、合并、升规则、上限、过时、保护、收工检查 |
| `test-feedback0928.js` | 内网 0928 导出的五条问题反馈，照原样复现 |
| `test-feedback0929.js` | 内网 0929 导出的问题反馈：id 重复、审查记账、打勾、放行、全自动模式和报告、不记噪音 |
| `test-feedback0930.js` | 内网 0930 导出的议题 #1 到 #9 照原样复现，加上用下来提的几件事：全自动模式只在走 OpenSpec 流程时算数、变更的过程文件留到归档、调用记录里的错每天汇总、提示规则去掉、报告里"库里改过的" |
| `test-1001.js` | 1001 这一批：安装器写 settings.json 的自动压缩窗口（改开关跟着改、填 0 和卸载时还回原来的）；状态栏三行；使用情况数次数、要传的那一段不带路径；开工前拉代码（真的 git 仓库和远端：快进、分叉、和没提交的改动冲突、没有远端、连不上、壳子、全自动记进报告）；问题列表标上报了没有 |
| `test-1005.js` | 1005 这一批：安装器默认关掉 Claude Code 自带的自动模式（配置页改成"不管它"就去掉、你自己写的不动、卸载只收回自己加的、从上一版升上来也加上）；全局约定里有官方那句；开工前拉代码"本来就是最新"不占上下文；使用情况里模型名字带的内网地址遮掉；起一个临时路由，配置页的接口不收别的网站的页面发来的请求。逻辑审查之后改的也在这里：拉代码时合并做到一半不结束（用一个慢的检出过滤器、一个 sleep 的 post-merge 钩子造出来，环境变量 `VIBE_KIT_PULL_PATIENCE_MS` 把"等多久"调小）、`merge.autoStash`、不是壳子不带子项目、登不上的远端（假 GitLab，端口是路由端口加一）、"不要停"不算停、压缩窗口最大 96 万、不能放行的拦截也数。第一个参数是路由端口，第二个给上一版的目录（要比 1005 早的，run-all 会自己挑） |
| `test-1007.js` | 1007 这一批：让它出文档、生成文件不算流程里的活（全自动不作数）；公共配置里被 dev 盖掉的库不算开发库；devserver `--port auto` 自动挑端口（范围、避开、同一个服务同一个端口、`{port}` 和环境变量）；自动提交的"按阶段"那一档。第一个参数是端口 |
| `test-1008.js` | 1008 这一批：归档要用户自测过、说了才做；不走 OpenSpec 的提交要用户点头（开关 plainCommit）；流程分写提案 / 做任务两段，全自动只管做任务那一段，模型自己调 /opsx:apply、提案阶段打勾都拦；开工时告诉用户全自动开没开（systemMessage）；审查过程不进提交；做完的功能上的问题改动小直接改；交接的"不问"只提醒 |
| `test-feedback1010.js` | 1010 整批反馈：真实确认格式、取消、apply 状态、后台 task-id/输出文件/SendMessage、中文目录归属、多版本驱动和项目选择、各档全自动提交、提案收工提交确认、合并push 的临时裸仓库与拒绝推送。参数 [auto或none] [旧套件目录]；旧版应失败，新测试不碰真实远端 |
| `test-feedback1012-push.js` | 1012 推送反馈：预览管道、确认选项、限时核对、伴随文档分组；可给旧版目录检出反例 |
| `test-feedback1012-workflow.js` | 1012 流程反馈：只读计划、产出位置、待提交文件、探针证据和兼容审查诊断；可给旧版目录 |
| `test-feedback1012-page.js` | 1012 页面探针：系统浏览器读值、断言、同步与异步超时、目录链接边界；可给旧版目录 |
| `test-feedback1012-db.js` | 1012 数据库诊断：只模拟错误，不连接真实业务库；参数 [auto或none] [旧套件目录] |
| `probes/` | 探测，不是回归测试：真的 Claude Code 加假网关，看某个版本在一件事上是怎么做的，输出给人看。`cc-compact.js`（到多少自动压缩）、`cc-automode.js`（没配权限模式进不进自带的自动模式、分类请求长什么样）、`cc-statusline.js`（交互界面里状态栏照不照常，用 winpty 抓屏）、`cc-http-hooks.js`（钩子走 HTTP 照不照常）、`cc-system-message.js`（用户开口的钩子用 JSON 输出时 systemMessage 显不显示、给模型的提醒送不送到）。见下面"换 Claude Code 版本之前" |
| `test-page-0929.js` | 看页面的场景：同一步里写断言、上传、应答文件选择框、点被盖住的控件。用本机的 Edge 无头跑 |
| `test-devserver-0929.js` | 起服务的工具：最后一行是结果，停的时候进程清干净 |
| `ui-kit-0929.js` | 配置页重排之后：接口、页面上每个开关都在、保存条、三张表。第二个参数给目录就存截图 |
| `check-old-repro-0929.js` | 拿 20260928.2054 / 2055 跑同样的输入，确认修之前确实有那些毛病 |
| `e2e-auto-0929.js` | 真的 Claude Code 加假模型，全自动模式走两个会话：放行、审查、报告、id 重复的复审、归档 |
| `test-ttls.js` | 改名（`ttls-` 前缀）和并进来的两个技能：从上一版升上来，旧名字的技能删掉、改过的先备份、驱动挪过来、经验规则的文件改名。要一个上一版的目录 |
| `test-dbcrud.js` | 查库：拿 H2（MySQL 兼容模式）走完整的读写循环，最后照冒烟靶场把不连库的判断过一遍。要运行环境的目录 |
| `test-redis.js` | 查 redis：客户端对着假 redis 走一遍；模型跑技能自带的脚本钩子放行，改套件的东西照拦 |
| `test-onboard.js` | 后台自动探索：认工程、只配开发环境的连接、文件改了跟着改、找驱动不拖住项目说明、项目里留着旧技能的提醒 |
| `test-auto-0930.js` | 审查报的问题自动收、自动归并成规则；工具的用量和毛病并进问题反馈 |
| `ui-data-0930.js` | 配置页"数据库驱动"那一页：接口和页面 |
| `e2e-0930.js` | 真的 Claude Code 加假模型：技能清单、后台探索、配置改了跟着改、模型照技能说的查库查缓存 |
| `lib/fake-redis.js` | 假 redis：认客户端会发的那几条命令 |
| `testbed/ttls-db-crud/smoke/` | 查库的冒烟靶场：假连接配置、放着各种写法的配置文件的假项目、用例 |
| `docs/ttls-db-crud/` | 查库技能的设计说明、维护须知、使用说明、验证记录（从 skytech-skills 搬来的，在这里维护） |
| `lib/fake-site.js` | 假网站：登录失败也返回 200、被按钮盖住的上传控件 |
| `check-old-repro.js` | 拿上一版跑同样的输入，确认修之前确实有那个毛病 |
| `diff-hooks.js` | 同一批输入喂给上一版和这一版的钩子，比输出：没动的地方必须一字不差 |
| `test-install-0928.js` | 用真的 install.js 往假用户目录里装、升级、同步、卸载 |
| `ui-lessons.js` | 起一个临时路由，测配置页"经验规则"的接口；第二个参数给秒数就留着让人看页面 |
| `test-http-hooks.js` | 检查在路由的工作线程里跑，和命令方式结果一样 |
| `e2e-lessons.js` | 真的 Claude Code 加假模型，走完整条路 |
| `test-update.js` | 自动更新和发布：维护的人发布，同事的电脑自己发现、自己装上；装坏了退回；路由忙就等 |
| `test-issues.js` | 问题上报：用 SSH 申请令牌、装之前攒下的不传、不重复建、又出现；导出（本机不存）、关掉是另一步；使用情况一台电脑一条议题、一天一条补充，导出时汇总在最后 |
| `test-proposal-files.js` | 提案材料随变更交付；四产物临时引用、忽略材料、暂存区旧内容；普通文档标题不能跳许可；中文事件和归档边界 |
| `test-secrets.js` | 令牌和模型的 key 不给读；跑发布脚本要确认；安装器加的权限规则 |
| `ui-update.js` | 配置页"更新和上报"的接口，从页面上点更新（路由会重启）；导出、关掉、使用情况；维护的电脑写死在代码里，测导出时用环境变量 VIBE_KIT_MAINTAINER_HOSTS 把路由装成那台；第二个参数给秒数就留着让人看页面 |
| `e2e-update.js` | 真的 Claude Code：令牌读不到；会话里后台自己更新、自己上报 |
| `accept-packages.js` | 验收：拿打好的两个压缩包走一遍发布、安装、再发布、自动更新 |
| `lib/fake-gitlab.js` | 假 GitLab：git 的 http 通道加 issue 的接口 |
| `lib/fake-ssh.js` | 假 ssh：拉仓库、推仓库、申请令牌 |
| `lib/fake-busy.js` | 装成路由，只回答"现在忙不忙" |
| `test-idea-mcp.js` | 假 IDEA HTTP 和事件流：安装、同步、后台接入、端口变化、多实例、用户修改和删除、卸载、损坏配置、已有凭据保留；给 --claude 时核验 CLI 识别登记；参数可给旧版目录验证失败 |
| `test-idea-tools.js` | IDEA 直接工具和路由的真实钩子入口：令牌、搜索范围、提交、push、数据库、单文件编辑及未适配操作；不执行 IDE 工具。可给旧版目录验证失败 |
| `lib/watch-windows.ps1` | 盯着桌面，测试跑的时候冒出来的窗口都记下来，一闪就关的也算 |
| `lib/harness.js` | 公共部分：假用户目录、假会话记录、结尾核对真实文件没变 |

## 拿到别的版本的 Claude Code

每个版本各装在自己的目录里，不要 `npm i -g`（会把自己在用的那个换掉）：

```bash
npm install --prefix "%LOCALAPPDATA%\Programs\claude-code-versions\2.1.120" @anthropic-ai/claude-code@2.1.120
```

程序在 `<那个目录>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。一个版本两百多 MB。这台电脑上装着 2.1.120、2.1.259 和 2.1.289，以后还要用，不删。

上一版的套件直接用 `dev/baseline/` 里留的那份：

```bash
node dev/run-all.js --old dev/baseline/20261001.0303/vibe-kit
```

## 换 Claude Code 版本之前

内网要升 Claude Code、或者官方出了新版想知道套件受不受影响，先把那个版本装到上面说的目录，跑五个探测，再拿它跑端到端：

```bash
node dev/probes/cc-compact.js 2.1.289
```

```bash
node dev/probes/cc-automode.js 2.1.289
```

```bash
node dev/probes/cc-statusline.js 2.1.289
```

```bash
node dev/probes/cc-http-hooks.js 2.1.289
```

```bash
node dev/probes/cc-system-message.js 2.1.289
```

```bash
node dev/run-all.js --claude "%LOCALAPPDATA%\Programs\claude-code-versions\2.1.289\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --rt auto
```

参数给版本号（到上面那个目录里找）或者 `claude.exe` 的路径。探测的输出是给人看的：和 `docs/claude-code-facts.md` 里记的对一遍，有变化的记进去，要改套件的改套件。`cc-automode.js` 加环境变量 `PROBE_CLASSIFIER=garbage` 能看分类模型答得不合格式时会怎样（内网的模型多半就是这种情况）。

## 查库的运行环境

查库的技能要 python 和 java，测试还要一个真的 JDBC 数据库。2026-09-30 起正式装在各自该在的位置，不再放临时目录：

| 装什么 | 装在哪 | 怎么装的 |
|---|---|---|
| Python 3.12 | `%LOCALAPPDATA%\Programs\Python\Python312\` | python.org 在 NuGet 上发的官方包，解开放过去。带 pip |
| JDK 17（Temurin） | `%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-17.0.20.1-hotspot\` | Adoptium 的压缩包 |
| H2 | `~/.m2/repository/com/h2database/h2/2.2.224/` | Maven 中央仓库的 jar，放在 Maven 本地仓库该在的位置 |

用户级的环境变量也设了：`PATH` 里加了 Python 和 JDK 的 bin，`JAVA_HOME` 指着 JDK。

`--rt auto` 照这三个位置找（Python 找 `Python3*`，JDK 先认 `JAVA_HOME`，H2 取 `~/.m2` 里最新的）。装在别处的，用环境变量指：`VIBE_TEST_PYTHON`、`VIBE_TEST_JAVA`、`VIBE_TEST_H2`。也可以给一个放着便携版的目录（里面有 `python/python.exe`、`jdk/bin/java.exe`、`h2.jar`）。

在 Claude 桌面版的会话里装东西有两个坑。它是商店应用，跑在容器里：

- 微软安装包（MSI、python.org 的 exe 安装器）装不了，报 2203 / 0x80070003。用压缩包、NuGet 包解开。
- 往 `AppData\Local`、`AppData\Roaming` 下面新建的顶层目录，实际落在应用自己的私有目录里，别的程序看不到。放在已经有的目录下面（`AppData\Local\Programs\…`）才是真的。装完用资源管理器看一眼在不在。

达梦、神通、Oracle、金仓、MySQL 的真库这里测不了，见 `docs/ttls-db-crud/验证记录.md`。

改了 `DbRunner.java` 要重新编译，命令在 `docs/ttls-db-crud/维护须知.md`。

## 推送只推到临时目录

测试里的 `git push`、发布脚本，推的都是临时目录里的裸仓库（假 GitLab）。往真的远端推要用户自己来。

## 几条规矩

- 不碰真实的用户目录。套件拷到临时目录里的假用户目录再跑，结尾核对真实的 `settings.json`、`CLAUDE.md` 没变。
- 不碰真实的"启动"文件夹。子进程的 `APPDATA`、`LOCALAPPDATA`、`VIBE_KIT_STARTUP_DIR` 都指假目录，结尾核对真实"启动"文件夹里的 `vibe-kit-router.vbs` 没变。2026-09-28 出过事：测试把路由装上了，自启动脚本写进了真的"启动"文件夹。
- 不留进程。结尾查命令行里带着这次测试的临时目录名、还在跑的 node、git、ssh，有就算失败并结束掉。
- 手工试一条命令也要指假的用户目录。2026-09-29 手工跑了一次查库的自检，在真实的用户目录下建出了 `~/.db-crud`。用 `lib/harness.js` 的 `H.run`，或者自己把 `HOME`、`USERPROFILE`、`CLAUDE_CONFIG_DIR` 指到临时目录。
- 钩子默认不甩后台的更新进程（`VIBE_KIT_NO_UPDATE=1`）。测更新的那几套自己把它去掉。
- 钩子默认不甩后台的自动探索（`VIBE_KIT_NO_ONBOARD=1`）：它会往测试的项目里写 `.vibe/project.md`，别的测试的输出就跟着变了。测探索的那几套自己把它去掉。
- 安装包里不能有 jar。数据库的驱动是厂商的，只限内部使用；打包脚本会查。
- 在假用户目录里伪造了套件的文件（比如假的 `router/service.js`），连带变了的状态（`installed.json`）也要改回去。
- 不在桌面留窗口。子进程一律隐藏窗口，不用 detached。
- 临时目录用完自己删。
- 要写进补丁的内容里有反斜杠（正则、Windows 路径）的，不要用 Bash 的 heredoc、`node -e`，它们会吃掉反斜杠。写成文件再跑。
- 同一个对话里工具调用的 id 重复，Claude Code 会把第二次调用换成"Tool use interrupted"，假模型会一直重试。要测 id 重复，分成两个会话。
- `kit/hooks/` 里的文件不能随便删。自动更新装完新版之后的自检，跑的是旧版的代码，它按旧版的名单挨个载钩子，少一个就装回旧版。不用了的钩子留一个空壳（`source-hint.js` 就是）。
- 测全自动模式的行为，先用 `H.inFlow(h, 会话编号, [变更目录])` 把会话记成在 OpenSpec 流程里。不记的话全自动不算数。
- 在测试进程里直接 `require` 套件的模块，`os.homedir()` 是真实的用户目录。要读写用户目录的（查库的留痕 `~/.db-crud`），走 `H.hook`、`H.node` 起子进程。

## 20261011 专项与兼容性

新增 test-workflow-state、test-workflow-intent、test-workflow-permissions、test-connection-lifecycle、test-diagnostic-redaction、test-review-evidence、test-optimization-runtime、test-optimization-boundaries、test-service-address 和 test-push-preview。分别覆盖锁崩溃、真人许可、取消、退役连接、假秘密诊断、限时和部分审查、缓存隔离、本地恢复、真实服务地址与推送预览。用最新 baseline 参数再跑，必须检出旧版反例。边界测试还检查旧人工任务、目录联接、二进制材料、重复预算、额外恢复文件和普通开关的脱敏；不能仅断言新模块存在。

经验规则的 CLI 端到端保留兼容代理入口，并故意尝试未经用户确认的提交。代码和规则实际生成后，再发送真人提交指令，核对 Git 历史确实改变。默认独立审查执行器由 review-evidence 和 optimization-boundaries 的假网关测试覆盖，不能把兼容代理测试说成默认执行器测试。

`test-proposal-review-state.js` 核对独立提案审查的有效性：需求、设计、验法改变后旧结论失效；任务勾选、实现代码和生成交付摘要不重开需求审查。本轮修复前有三项真实失败，不能仅用新模块存在作反例。

`node dev/build-db-runner.js auto` 在假环境编译 Java 8 目标，源码和 class 一起交付。

`node dev/probes/cc-post-tool.js 2.1.289` 实测完成钩子；2.1.120、2.1.259、2.1.289 都仅连假网关，成功返回 tool_use_id 与 stdout/stderr/interrupted，失败走 PostToolUseFailure，不登记通过。IDEA 输出替换的形状来自官方协议，未在真实 IDE 上注入凭据做破坏性测试。

全回归使用三版 CLI、四份旧基线、--rt auto 和 Windows 窗口监视器。日志放仓库 .vibe/tmp/，全过后再打包、从最新两版压缩包验升级。

`test-usage-identity.js` 用假电脑名和假 GitLab 检查持久随机标识、改名、不同安装及旧议题迁移。假 GitLab 支持正常标题和正文更新；不会改真实 GitLab。旧版有六项反例失败。

`test-archive-extract.js [旧套件目录]` 检查 JAR、ZIP、WAR、TAR、7z、Python 命令行、PowerShell 与 IDEA 终端的解包目录，以及条目和目录列表经重定向或管道落盘。覆盖只读放行、旧 JDK 兼容路径、事由目录、上级目录逃出、目录联接、包装命令的实际工作目录、Windows 完整程序路径、重复执行、关闭 kitLock 和全自动；同时确认包装命令仍保留单个 `&` 后的令牌检查和推送确认。未知路径放行，不执行待测命令。旧版应检出漏拦，假项目用完清理。

## 20261012 反馈专项

`test-feedback1012-push.js [旧套件目录]` 核对临时裸仓库的预览管道、真人选项、取消、固定数量且限时的 Git 查询、伴随文档归组和归档边界。`test-feedback1012-workflow.js [旧套件目录]` 核对只读计划、产出位置、待提交交付文件、探针结果和兼容审查诊断。`test-feedback1012-page.js [旧套件目录]` 用系统无头浏览器实际验证探针读值、失败、异步和同步超时、路径限制。`test-feedback1012-db.js [auto或none] [旧套件目录]` 用模拟错误检查数据库诊断，不连接真实库。四套已加入全回归；与 20261011.1553 对照须检出反例。
