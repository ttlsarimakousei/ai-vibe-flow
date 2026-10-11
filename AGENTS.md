# 给 AI 协作者的说明

在这个仓库里干活的 AI（Claude Code、Codex、Gemini CLI、Cursor 等）都按这份来。人也一样，人还要看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这个仓库是什么

内网的同事用 Claude Code，后面接的是公司网关上的私有模型。这个仓库做的是给他们用的工作流 `vibe-kit`：

- 一套装进 `~/.claude` 的东西：全局约定、规范、六个技能、一个审查代理、十几个钩子、状态栏。
- 一个在后台运行的模型路由（本机 15730 端口），带一个本机配置页，开关都在配置页上改。
- 挂在 OpenSpec 1.2 上：需求和任务归 OpenSpec 管，套件只在提案、打勾、归档这些节点上做确定性的检查。

核心思路：**能用本机脚本确定性判断的，不交给模型**（编号、状态、git、编译、起停服务、截图比对、该不该交接），模型只做要理解的事。所以钩子多、提示少。

## 先读什么

按这个顺序：

1. 这份文件。
2. [docs/architecture.md](docs/architecture.md)：套件由哪几块组成、钩子在哪个时机做什么、状态记在哪。
3. 要改的那块的源码。每个文件开头都有一段中文注释，写着它管什么、为什么这么做。改之前先读它。
4. [docs/conventions.md](docs/conventions.md)：代码、提示语、文档怎么写。
5. [dev/README.md](dev/README.md)：测试怎么跑、测试的规矩。
6. 动到相关的地方时再看：[docs/claude-code-facts.md](docs/claude-code-facts.md)（实测过的 Claude Code 行为）、[docs/decisions.md](docs/decisions.md)（为什么是现在这样，哪些是用户定的不能改回去）、[docs/glossary.md](docs/glossary.md)（"壳子""放行""交接线"这些词）。

用户怎么用套件，看 [vibe-kit/README.md](vibe-kit/README.md)。它是写给用的人看的，也是行为的说明书：改了行为，它要跟着改。

## 仓库地图

| 路径 | 是什么 |
|---|---|
| `vibe-kit/install.js` | 安装器：拷文件、登记钩子、写 settings.json、生成全局约定、装路由、卸载 |
| `vibe-kit/publish.js` | 把安装包发布到内网 GitLab（只有维护的人用） |
| `vibe-kit/kit/hooks/` | 钩子。每个导出 `handle(j)`，命令方式和 HTTP 方式共用一份代码 |
| `vibe-kit/kit/lib/` | 钩子、工具、配置页共用的库。`session.js` 是最底层，别的都依赖它 |
| `vibe-kit/kit/tools/` | 给模型和用户在命令行用的工具（问题反馈、经验规则、起服务、溯源……） |
| `vibe-kit/kit/page/` | 看页面的执行器（Playwright 脚本，用系统 Edge）。`node_modules/` 是有意带进仓库的：内网离线，装不了依赖 |
| `vibe-kit/kit/statusline.js` | 状态栏 |
| `vibe-kit/router/` | 模型路由 `router.js`、后台管理 `service.js`、配置页 `ui.html` 和它的后端 `kit-api.js` |
| `vibe-kit/claude/` | 装进 `~/.claude` 的给模型看的东西：全局约定模板 `CLAUDE.md`、规范 `rules/`、技能 `skills/`、审查代理 `agents/` |
| `vibe-kit/README.md`、`vibe-kit/更新说明.md` | 用户手册、版本说明。会打进安装包 |
| `dev/` | 测试（`test-*.js`、`ui-*.js`、`e2e-*.js`）、`run-all.js`、`pack.js`、`accept-packages.js`、`diff-hooks.js`、测试支架 `lib/`、旧版基线 `baseline/` |
| `docs/` | 协作文档；`docs/history/` 是早期的方案和审查报告，只读 |
| `browser-probe/`、`coop-probe/` | 早期的体检包，冻结，不改 |

## 干活的规矩

### 语言和文风

- 文档、注释、提交信息、给用户看的文字（配置页、钩子的提示、安装器的输出）一律简体中文。
- 写得直白：说事实和结果，不铺垫、不抒情、不用比喻。给模型看的提示要写清"要看到什么才算过"，最好带一个照着改的例子：内网的模型只被告知"不对"会原地打转。
- 不写不说人话的黑话。用户的项目结构统一叫"壳子"和"子项目"，不要用"多仓工作区""产品仓""服务仓"。

### 改代码之前

- 先看实际情况：读代码、跑测试、查文件。文档和代码对不上，以代码为准，并指出来。
- 先找现成的：`kit/lib/session.js` 里已经有大量公共函数（读会话记录、读开关、找变更、读写状态、壳子识别），别重写一份。
- 动一个函数之前，用 Grep 找全它的调用方。
- 用户反馈一批问题时，先逐项核对并给完整报告，再交付修改。检查同类入口和全自动场景，不能只修反馈里的单个例子；证据不足的明确列出，不能当成已修。
- 临时查看归档先只读列目录或条目。JAR、ZIP、WAR、TAR 等的解包样本和检查结果一律放 `.vibe/tmp/<事由>/`，不放项目根、源码目录或 tmp 根，不因被忽略、不准备提交就例外；需要交付的材料按提案材料规则整理。

### 改 vibe-kit 的硬规矩

1. **只用 Node 自带的模块**。钩子、库、工具、路由都不引第三方包（看页面的执行器除外，它带着自己的 `node_modules`）。
2. **钩子出错一律放行**（fail-open），并记一条问题反馈。判断不了就放行，不能因为钩子出错把用户卡住。
3. **拦截用 JSON 输出，不用退出码 2**：`lib/session.js` 的 `blockOut()` / `askOut()`。Windows 上退出码会被改写，拦不住。
4. **用户目录按代码自己的位置推**（`__dirname`），不靠 `os.homedir()` 和环境变量。测试用的覆盖变量单独命名（`VIBE_KIT_DIR`、`VIBE_KIT_STARTUP_DIR` 这类）。
5. **后台起进程一律 `windowsHide: true`**，输出走管道或 ignore，不在桌面弹窗口。
6. **令牌和模型的 key 模型读不到**：`secrets.json`、`router-data/` 由权限规则、`guard-read`、`guard-commit` 三道挡着。不许打印、不许写进日志和问题反馈、不许打进安装包。状态栏不读 `router-data/config.json`。令牌保护只能收紧，不能再放宽。
7. **数据库、redis 的口令不经过模型、不上命令行**。厂商的 JDBC 驱动不进安装包（`pack.js` 会查 jar）。
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
| 用户看得见的行为、开关、配置页 | `vibe-kit/README.md`、`vibe-kit/更新说明.md` 最上面那一节 |
| 测试、打包的做法 | `dev/README.md` |
| 架构、状态文件、新模块 | `docs/architecture.md` |
| 用户定下的规矩、重要取舍 | `docs/decisions.md` |
| 新实测出来的 Claude Code 行为 | `docs/claude-code-facts.md` |

`更新说明.md` 里还没打包的那一版，标题和版本表里写占位 `@@VER@@`，打包时换成版本号（见 [docs/release.md](docs/release.md)）。

### 提交和推送

- 本仓库按具体问题或独立功能分开提交，提交信息写清行为变化，不把整批修复压成一条笼统的 fix。共享文件涉及多个问题时按改动段分组；相关测试尽量跟随对应实现，发版生成物单独提交。

- 提交信息：`类型: 内容`，英文冒号加一个空格，一行，简短。类型只有 `feat`、`fix`、`docs`、`style`、`refactor`、`chore`、`release`。例：`feat: 状态栏显示今天的用量`。
- 修的是某个 OpenSpec 变更做出来的东西，末尾加"（源自 <变更名> <任务号>）"。这个仓库自己不走 OpenSpec，一般用不到。
- 只 add 自己这次改的文件，不用 `git add -A`、`git add .`、`git commit -a`。
- **push 要仓库主人亲自点头**，GitHub 和内网 GitLab 都一样。发布到内网 GitLab 的 `publish.js` 也算 push。

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
