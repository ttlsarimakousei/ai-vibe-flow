# 协作流程

人和 AI 都按这份来。AI 还要先读 [AGENTS.md](AGENTS.md)。

## 分支和提交

- 主分支 `main`，始终是能打包、测试全过的状态。
- 一件事一个分支，名字说清做什么（`fix-export-download`、`feat-pull-before-work`）。做完合回 `main`。
- 提交信息 `类型: 内容`，英文冒号加一个空格，一行，简短。类型只有 `feat`、`fix`、`docs`、`style`、`refactor`、`chore`、`release`。
- 一次提交只放一件事；只 add 这次改的文件，不用 `git add -A`、`git add .`、`git commit -a`。
- **push 要仓库主人亲自确认**。往内网 GitLab 发布（`publish.js`）也算 push。

## 一个改动要带齐的东西

| 要什么 | 什么时候 |
|---|---|
| 代码 | 总是 |
| 测试：新功能、修的毛病都要有测试，写完拿上一版跑一遍确认它会失败 | 改了行为 |
| `dev/diff-hooks.js` 里"有意改的"用例 | 改了钩子的输出、拦截的说法 |
| `vibe-kit/README.md` | 用户看得见的行为、开关变了 |
| `vibe-kit/更新说明.md` 最上面那一节（版本号写 `@@VER@@`） | 每一次要发给用户的改动 |
| `dev/README.md` | 测试、打包的做法变了 |
| `docs/` 里对应的那篇 | 架构、约定、实测事实、设计决定变了 |

## 合进 main 之前

```bash
node dev/run-all.js
```

全过、没有留下窗口和临时目录才合。动到端到端、查库、旧版兼容的，跑全量（参数见 [dev/README.md](dev/README.md)）。

审查时看：

- 有没有违反 [AGENTS.md](AGENTS.md) 里的硬规矩（只用 Node 自带模块、出错放行、拦截用 JSON、令牌读不到、不新开子代理、全局约定不乱加字……）。
- 给模型的提示有没有说清要看到什么才算过、有没有照着改的例子。
- 测试是不是真的测到了（在旧版上会失败）、有没有碰真实的家目录。
- 文档跟上了没有。

## 发版

见 [docs/release.md](docs/release.md)。简单说：全量回归 → `node dev/stamp-and-pack.js` → 把 `diff-hooks.js` 里的 `NEXT` 改成版本号 → 验收（从最近几版升到新版）→ 提交、打标签 `v<版本号>` → 仓库主人确认后 push → 维护的人发布到内网 GitLab。

## 不进仓库的东西

- 打好的安装包 `*.zip`：发版时作为附件给。
- 套件运行时生成的文件（令牌、仓库地址、开关、状态、问题反馈、路由的模型和 key）。`pack.js` 发现源目录里有这些会拒绝打包。
- 体检包的离线环境、依赖和结果。

## 问题和需求从哪来

- 内网同事那边的：问题反馈自动建成内网 GitLab 的议题，维护的人导出后交给改套件的人。处理办法见 [docs/release.md](docs/release.md) 的"内网的议题怎么进来"。
- 仓库主人提的：照他说的做；他没说清的，按 [docs/decisions.md](docs/decisions.md) 里定下的原则取舍，取舍写进交代和 `decisions.md`。
