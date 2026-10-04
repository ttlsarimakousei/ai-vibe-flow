# 开发

## 要装的东西

| 东西 | 干什么用 | 必须吗 |
|---|---|---|
| Node 18 以上 | 套件、路由、测试都是 Node 写的 | 必须 |
| git | 测试里建假仓库、假 GitLab | 必须 |
| Windows + 系统自带的 Edge | 看页面的测试（无头 Edge）、盯桌面窗口的脚本 | 跑全量测试要 |
| Python 3、JDK 8 以上、H2 的 jar | 查库技能的测试 | `--rt` 那一套要 |
| Claude Code 2.1.120 和 2.1.259 | 端到端测试，每个版本装在自己的目录 | `--claude` 那几套要 |

装法、放在哪、`--rt auto` 怎么找，见 [dev/README.md](../dev/README.md)。旧版的 Claude Code 不要 `npm i -g`，会把机器上在用的换掉。

## 改一处东西的步骤

1. 读要改的文件开头的注释，再读 [architecture.md](architecture.md) 里对应的那一块。用 Grep 找全调用方。
2. 改代码。守 [conventions.md](conventions.md) 和 [AGENTS.md](../AGENTS.md) 里的硬规矩。
3. 写测试：加进现有的测试文件，或者新建一个 `dev/test-<批次或主题>.js`，加进 `dev/run-all.js`。写完拿上一版的套件跑一遍，确认新测试在旧版上会失败。
4. 改了拦截的说法、钩子的输出：`dev/diff-hooks.js` 里加"有意改的"用例，`since` 写 `NEXT`。
5. 跑相关的测试，再跑 `node dev/run-all.js`。发版前跑全量（见 [release.md](release.md)）。
6. 改文档：`vibe-kit/README.md`、`vibe-kit/更新说明.md`（最上面那一节，版本号写 `@@VER@@`）、`dev/README.md`、`docs/` 里对应的那篇。
7. 提交：`类型: 内容`，只 add 这次改的文件。

## 手工试一个脚本

**一定先把家目录指到临时目录**。套件的脚本按自己的位置找 `~/.claude/vibe-kit`，查库的留痕在 `~/.db-crud`，都跟着家目录走；直接在源目录里跑会把运行时文件写进源目录，在真实的家目录里跑会改到真实的东西。

最省事的是用测试支架：

```js
const H = require('./dev/lib/harness');
const h = H.makeHome('try');               // 临时目录里的假用户目录，套件拷进去了
H.hook(h, 'task-anchor', { session_id: 's1', cwd: h.root, hook_event_name: 'UserPromptSubmit', prompt: '继续' });
H.cleanup();
```

自己起子进程的话，`HOME`、`USERPROFILE`、`CLAUDE_CONFIG_DIR`、`APPDATA`、`LOCALAPPDATA` 都指到临时目录，用完删掉。

## 出问题先看哪

- 钩子做了什么：装好的套件里的 `state/hooks.log`（测试里在假用户目录下）。
- 钩子的输入长什么样：Claude Code 官方文档的 hooks 一节；`dev/lib/harness.js` 的 `H.tr` 能造会话记录。
- 配置页的接口：`router/kit-api.js`，页面是 `router/ui.html`（一个文件，没有构建步骤）。
- 内网同事那边的问题：看导出的议题，议题后面附着当时钩子的流水账。

## 用 AI 改这个仓库时的几个坑

- **Bash 工具的 heredoc 和 `node -e` 会吃掉反斜杠**（带引号的 heredoc 也一样）。内容里有正则、Windows 路径的，写成文件再跑，或者用编辑工具改。
- **Bash 里不要 `cd`**，命令里写完整路径（`git -C <目录>`、`node <完整路径>`）。在桌面版 Claude 里 cd 会改掉会话的工作目录。
- 在桌面版 Claude（商店应用）的会话里装软件：MSI 安装器装不上，往 `AppData\Local`、`AppData\Roaming` 下新建的顶层目录别的程序看不见。用压缩包解到已经存在的目录下（`AppData\Local\Programs\…`）。
- 回归跑着的时候不要改被测的文件（套件的源码、测试脚本），等跑完再改。
- 在测试进程里直接 `require` 套件的模块，`os.homedir()` 是真实的家目录。要读写家目录的，走 `H.hook`、`H.node` 起子进程。
