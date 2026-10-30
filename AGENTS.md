# 给 AI 协作者的说明

在这个仓库里干活的 AI（Claude Code、Codex、Gemini CLI、Cursor 等）都按这份来。人也一样，人还要看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这个仓库是什么

内网的同事用 Claude Code，后面接的是公司网关上的私有模型。这个仓库做的是给他们用的工作流 `vibe-kit`：

- 一套装进 `~/.claude` 的东西：全局约定、规范、六个技能、一个审查代理、十几个钩子、状态栏。
- 一个在后台运行的模型路由（本机 15730 端口），带一个本机配置页，开关都在配置页上改。
- 挂在 OpenSpec 上：需求和任务归 OpenSpec 管，套件只在提案、打勾、归档这些节点上做确定性的检查。安装包自带一份 OpenSpec（打包时的最新版），同事电脑 Node 版本不够时退回用他自己装的。

核心思路：**能用本机脚本确定性判断的，不交给模型**（编号、状态、git、编译、起停服务、截图比对、该不该交接），模型只做要理解的事。所以钩子多、提示少。

## 先读什么

按这个顺序：

1. 这份文件，和 [docs/handoff.md](docs/handoff.md)（现在做到哪、待仓库主人定的；Claude Code 通过 CLAUDE.md 自动带上）、[docs/backlog.md](docs/backlog.md)（没结的问题）。
2. [docs/architecture.md](docs/architecture.md)：套件由哪几块组成、钩子在哪个时机做什么、状态记在哪。
3. 要改的那块的源码。每个文件开头都有一段中文注释，写着它管什么、为什么这么做。改之前先读它。
4. [docs/conventions.md](docs/conventions.md)：代码、提示语、文档怎么写。
5. [dev/README.md](dev/README.md)：测试怎么跑、测试的规矩。
6. 动到相关的地方时再看：[docs/claude-code-facts.md](docs/claude-code-facts.md)（实测过的 Claude Code 行为）、[docs/decisions.md](docs/decisions.md)（为什么是现在这样，哪些是用户定的不能改回去）、[docs/glossary.md](docs/glossary.md)（"壳子""放行""交接线"这些词）。

用户怎么用套件，看 [vibe-kit/README.md](vibe-kit/README.md) 和它链接的 `vibe-kit/手册/` 附录。它们是写给用的人看的，也是行为的说明书：改了行为，它们要跟着改。同一件事只在一处写：README 只放短说明，细节放对应的附录。

## 仓库地图

| 路径 | 是什么 |
|---|---|
| `vibe-kit/install.js` | 安装器：拷文件、登记钩子、写 settings.json、生成全局约定、装路由、卸载 |
| `vibe-kit/publish.js` | 把安装包发布到内网 GitLab（只有维护的人用） |
| `vibe-kit/kit/hooks/` | 钩子。每个导出 `handle(j)`，命令方式和 HTTP 方式共用一份代码 |
| `vibe-kit/kit/lib/` | 钩子、工具、配置页共用的库。`session.js` 是最底层，别的都依赖它 |
| `vibe-kit/kit/tools/` | 给模型和用户在命令行用的工具（问题反馈、经验规则、起服务、溯源……） |
| `vibe-kit/kit/page/` | 看页面的执行器（Playwright 脚本，用系统 Edge）。`node_modules/` 是有意带进仓库的：内网离线，装不了依赖 |
| `vibe-kit/kit/openspec/` | 套件自带的 OpenSpec（2026-10-17 集成，打包时的最新版）。`node_modules/` 同样有意带进仓库；怎么用上、怎么降级见 `kit/lib/openspec.js`，升级见 docs/release.md |
| `vibe-kit/kit/statusline.js` | 状态栏 |
| `vibe-kit/router/` | 模型路由 `router.js`、后台管理 `service.js`、配置页 `ui.html` 和它的后端 `kit-api.js` |
| `vibe-kit/claude/` | 装进 `~/.claude` 的给模型看的东西：全局约定模板 `CLAUDE.md`、规范 `rules/`、技能 `skills/`、审查代理 `agents/` |
| `vibe-kit/README.md`、`vibe-kit/手册/`、`vibe-kit/更新说明.md` | 用户手册（README 是短手册，`手册/` 下是一件事一份的附录）、版本说明。会打进安装包；`手册/` 新加的文件要加进 `dev/pack.js` 的必备清单 |
| `dev/` | 测试（`test-*.js`、`ui-*.js`、`e2e-*.js`）、`run-all.js`、`pack.js`、`accept-packages.js`、`diff-hooks.js`、测试支架 `lib/`、旧版基线 `baseline/` |
| `docs/` | 协作文档；`docs/history/` 是早期的方案和审查报告，只读 |
| `reviews/` | 审查报告，一个审查者一个子目录（`claude/`、`codex/`……），见下面"问题、审查、修复怎么记" |
| `browser-probe/`、`coop-probe/` | 早期的体检包，冻结，不改 |

## 干活的规矩

### 语言和文风

- 文档、注释、提交信息、给用户看的文字（配置页、钩子的提示、安装器的输出）一律简体中文。
- 写得直白：说事实和结果，不铺垫、不抒情、不用比喻。给模型看的提示要写清"要看到什么才算过"，最好带一个照着改的例子：内网的模型只被告知"不对"会原地打转。
- 不写不说人话的黑话。用户的项目结构统一叫"壳子"和"子项目"，不要用"多仓工作区""产品仓""服务仓"。

### 改代码之前

- 仓库主人在对话里主动提问题、没让修的：按原话记进 [docs/owner-issues.md](docs/owner-issues.md)，不查代码、不分析、不改，记完提交推送。他说修，或者导出议题让修的时候，再核对、分析、改，改完回填状态（2026-10-22 用户定的）。
- 先看实际情况：读代码、跑测试、查文件。文档和代码对不上，以代码为准，并指出来。
- 先找现成的：`kit/lib/session.js` 里已经有大量公共函数（读会话记录、读开关、找变更、读写状态、壳子识别），别重写一份。
- 动一个函数之前，用 Grep 找全它的调用方。
- 用户反馈一批问题时，先逐项核对并给完整报告，再交付修改。检查同类入口和全自动场景，不能只修反馈里的单个例子；证据不足的明确列出，不能当成已修。
- 临时查看归档先只读列目录或条目。JAR、ZIP、WAR、TAR 等的解包样本和检查结果一律放 `.vibe/tmp/<事由>/`，不放项目根、源码目录或 tmp 根，不因被忽略、不准备提交就例外；需要交付的材料按提案材料规则整理。

### 问题、审查、修复怎么记（2026-10-29、10-30 用户定的）

**问题从哪来，先记在哪**

| 来源 | 先记在哪 | 编号 |
|---|---|---|
| 仓库主人在对话里提的 | [docs/owner-issues.md](docs/owner-issues.md)，按原话记（见"改代码之前"第一条） | 第 N 条 |
| 内网同事导出的议题 | 核对时写进当批的 `docs/feedback-<日期>.md` | GitLab 议题号 #N |
| Claude 自审 | 当批 feedback 文档的"自审"一节 | 自审 N |
| 第三方审查（Codex 等） | `reviews/<审查者>/` | 照报告里的编号 |

**审查报告**

- 仓库主人让做的整体审核、专项审查，报告放仓库根目录的 `reviews/<审查者>/`。Claude Code 写 `reviews/claude/`，Codex 写 `reviews/codex/`，别的 AI 用自己的小写英文名（`gemini/`、`cursor/`）。几个 AI 同时审同一件事，各写各的目录。
- 文件名 `<日期>-<主题>.md`，例：`reviews/claude/20261029-vibe-kit-整体审核.md`。同一天同一主题再审一次，末尾加 `-2`。
- 只写自己的目录，不改、不删别的审查者的报告。要回应别人的结论，写在自己的报告里，注明引用的是哪份文件的哪一条。
- 报告里每条问题带 `文件:行号` 证据和把握（确认 / 可能）；用子代理、别的模型审的，写明哪条是谁审出、自己核实过没有。
- 报告写完提交推送，只 add 自己的报告文件。`docs/` 里以前的审查报告（`review-codex-20261017.md`）、`docs/history/` 不挪。
- **别的 AI 只审查**（2026-10-30 用户定的）：Codex 等别的 AI 只写自己的报告目录，不改代码、不改别的文档；修改都由 Claude Code 做。

**修复**

- 一批修复一份 `docs/feedback-<日期>.md`，固定几节：来源；核对（成立 / 不成立 / 重复 / 证据不足，带 `文件:行号`）；要定的；修改计划；修复结果（提交号、测试）；自审。第三方的结论在这里逐条核对、和自己的去重，能复现的拿它的脚本重跑。修完回填这份文档和未结清单，不改人家的报告。
- **自审**：每批改完、提交前，Claude 对着 diff 自审：同类入口、全自动场景、出错放行并记反馈、令牌保护、配置页说明和行为双向、文档跟着改、新测试拿上一版跑会不过。审出的直接改，结论写进"自审"一节。改了钩子、路由的批次，再请一个别的模型独立复审，报告放 `reviews/claude/<日期>-<主题>-复审.md`。
- **未结清单** [docs/backlog.md](docs/backlog.md)：所有来源里还没结的都列在这一张表里，结了就删那一行；历史看 feedback 文档和 git。
- 状态词只用：待核 / 待修 / 待定（等仓库主人）/ 证据不足 / 后做 / 修了（提交号）/ 不修（理由）。

### 交接（2026-10-30 用户定的，所有 AI 共用）

- [docs/handoff.md](docs/handoff.md) 只写现在的状态：在做哪一批、做到哪、等仓库主人定的、要注意的。没结的问题不在这里列，指向未结清单。
- 一批提交之后、上下文用到七成以上、会话要停之前更新：覆盖重写、不追加，40 行以内，历史看 git。仓库主人不用提醒。
- Claude Code 通过 CLAUDE.md 自动带上；别的 AI 开工先读它。

### 改 vibe-kit 的硬规矩

1. **只用 Node 自带的模块**。钩子、库、工具、路由都不引第三方包（看页面的执行器、自带的 OpenSpec 除外，它们带着自己的 `node_modules`，只当子进程跑，钩子不 require 它们）。
2. **钩子出错一律放行**（fail-open），并记一条问题反馈。判断不了就放行，不能因为钩子出错把用户卡住。
3. **拦截用 JSON 输出，不用退出码 2**：`lib/session.js` 的 `blockOut()` / `askOut()`。Windows 上退出码会被改写，拦不住。
4. **用户目录按代码自己的位置推**（`__dirname`），不靠 `os.homedir()` 和环境变量。测试用的覆盖变量单独命名（`VIBE_KIT_DIR`、`VIBE_KIT_STARTUP_DIR` 这类）。
5. **后台起进程一律 `windowsHide: true`**，输出走管道或 ignore，不在桌面弹窗口。
6. **令牌和模型的 key 模型读不到**：`secrets.json`、`router-data/` 由权限规则、`guard-read`、`guard-commit` 三道挡着。不许打印、不许写进日志和问题反馈、不许打进安装包。状态栏不读 `router-data/config.json`。令牌保护只能收紧，不能再放宽。
7. **查库、连 redis 由工具自己读连接配置，口令不上命令行、不写进提示**（2026-10-30 用户定的措辞：项目里的口令 10-25 起对模型放开，`.vibe/` 里的连接配置模型能读）。厂商的 JDBC 驱动不进安装包（`pack.js` 会查 jar）。
8. **全局约定（`vibe-kit/claude/CLAUDE.md`）每个请求都带着**。加一个字都是每个请求的成本：能放进钩子在对应时机送的，就不往约定里加。
9. **套件的流程里不新开子代理**。独立审查默认用有限材料的单独请求；明确选择兼容方式时才用现有审查代理，每个变更提案、代码各一次。
10. **默认开关只写在 `kit/lib/session.js` 的 `DEFAULT_CONFIG`**，`router/kit-api.js` 里那份必须和它一样（测试会比）。新开关要同时改：两份默认值、`kit-api.js` 的 `cleanConfig`、配置页 `ui.html`、`vibe-kit/README.md`、`更新说明.md` 的开关表。
11. **`kit/hooks/` 里的文件不能删**。自动更新装完新版后的自检跑的是旧版的代码，按旧版的名单挨个载钩子，少一个就装回旧版。不用了的钩子留空壳（`source-hint.js` 就是）。
12. **`kit/lib/` 新加的文件要加进 `dev/pack.js` 的必备清单**（`need` 那一串），不然漏打进包也发现不了。
13. **新的状态文件要想清楚会不会被清**：`state/` 下按会话的文件过几天自动删，跨会话要留的名字要加进 `session.js` 的 `GLOBAL_STATE`。
14. **维护套件的电脑的地址只写在 `kit/lib/gitlab.js`**，不进配置页、不进文档、不进提交信息。
15. **使用情况上报只传次数和版本号**，不传路径、项目名、文件名、提交信息、提示词、代码。
16. 改 GBK 的文件会毁掉中文（见 [docs/claude-code-facts.md](docs/claude-code-facts.md)）。仓库里的 `.bat` 是 GBK + CRLF，**用脚本按字节改，不要用编辑工具直接改**。别的文本一律 UTF-8 无 BOM、LF。

### 测试的规矩（红线）

- **不碰真实的用户目录**：套件拷到临时目录里的假用户目录再跑，`HOME`、`USERPROFILE`、`CLAUDE_CONFIG_DIR`、`APPDATA`、`LOCALAPPDATA`、`VIBE_KIT_STARTUP_DIR` 都指假的。用 `dev/lib/harness.js`。手工试一条命令也一样。出过三次事，见 [docs/decisions.md](docs/decisions.md)。
- **不留进程、不留窗口、临时目录用完删**。全量回归要盯着桌面跑（`dev/lib/watch-windows.ps1`）。
- **测试里的 push 只推临时目录里的裸仓库**（假 GitLab），不推任何真的远端。
- **回归跑着的时候不改被测的文件**。
- **写完新测试，拿上一版的套件跑一遍**，看有多少项不过；全过的测试要怀疑是不是空转。
- 改了行为、拦截的说法，`dev/diff-hooks.js` 里加"有意改的"用例并写明是哪一版改的（`since`）。

### 文档要跟着改

| 改了什么 | 要改哪些 |
|---|---|
| 用户看得见的行为、开关、配置页 | `vibe-kit/README.md` 或 `vibe-kit/手册/` 里对应的附录、`vibe-kit/更新说明.md` 最上面那一节 |
| 钩子、工具的实际行为 ↔ 配置页 `router/ui.html` 上对应开关的说明（双向，用户 2026-10-17 定的） | 改了行为，配置页上对应开关、"套件说明"页的说明要跟着改；改了配置页的说明，代码也要照着说明做。两边对不上算缺陷 |
| 测试、打包的做法 | `dev/README.md` |
| 架构、状态文件、新模块 | `docs/architecture.md` |
| 用户定下的规矩、重要取舍 | `docs/decisions.md` |
| 新实测出来的 Claude Code 行为 | `docs/claude-code-facts.md` |

`更新说明.md` 里还没打包的那一版，标题和版本表里写占位 `@@VER@@`，打包时换成版本号（见 [docs/release.md](docs/release.md)）。

### 提交和推送

- 仓库主人让修问题、改功能时，做到"改代码、写测试、跑和这次改动相关的测试、提交"为止，不自动跑全量回归、不打包发版。改完问仓库主人要不要打包发版；他说发版，才按 `docs/release.md` 走全量回归、打包、从最近两版压缩包验收安装与自动更新、单独的 `release` 提交和版本标签（2026-10-17 用户定的）。提交、push 到 GitHub 直接做，不用问（2026-10-18 用户定的）。
- 本仓库按具体问题或独立功能分开提交，提交信息写清行为变化，不把整批修复压成一条笼统的 fix。共享文件涉及多个问题时按改动段分组；相关测试尽量跟随对应实现，发版生成物单独提交。
- 仓库主人明确要求推送后，保留现有细致提交直接推送（套件的合并推送 2026-10-28 已取消）。

- 提交信息：`类型: 内容`，英文冒号加一个空格，一行，简短。类型只有 `feat`、`fix`、`docs`、`style`、`refactor`、`chore`、`release`。例：`feat: 状态栏显示今天的用量`。
- 修的是某个 OpenSpec 变更做出来的东西，末尾加"（源自 <变更名> <任务号>）"。这个仓库自己不走 OpenSpec，一般用不到。
- 只 add 自己这次改的文件，不用 `git add -A`、`git add .`、`git commit -a`。
- **push 到 GitHub 直接做，不用再问**（仓库主人 2026-10-18 授权：这个仓库的开发自动提交、自动推送）。**发布到内网 GitLab（`publish.js`）仍要仓库主人亲自做**：它会推到同事的电脑上，而且只有维护的那台电脑能发。

## 不要做的事

- 不要去研究 Claude Code 的权限、安全检查怎么绕。套件只用官方的正式开关，只改自己的代码。
- 不要 `npm i -g` 安装旧版的 Claude Code，会把机器上在用的那个换掉。测试用的旧版本各装各的目录。
- 不要改 `browser-probe/`、`coop-probe/`。测试阶段在 2026-09-18 结束了，结论已经用上了。
- 不要改 `docs/history/`、`dev/baseline/` 里的文件。前者是当时的记录，后者是旧版本的原样副本。
- 不要把用户定下的规矩改回去（[docs/decisions.md](docs/decisions.md) 里标着"用户定的"）。觉得有问题，写清理由交给仓库主人定。

## 常用命令

全量测试的前提和参数见 [dev/README.md](dev/README.md)。

```bash
node dev/run-all.js
```

```bash
node dev/test-1001.js
```

```bash
node dev/diff-hooks.js dev/baseline/20261001.0303/vibe-kit
```

```bash
node dev/pack.js --version 20261005.1200
```
