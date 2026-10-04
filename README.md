# ai-vibe-flow

给内网用 Claude Code（后面接的是私有部署的模型）的同事做的一套轻量 vibe coding 工作流。交付物是 `vibe-kit`：双击安装，装进 `~/.claude` 的一套约定、技能和钩子，加一个在后台运行的模型路由和它的本机配置页。挂在 OpenSpec 1.2 上用，不另起一套需求和任务管理。

- 用的人怎么装、怎么用：[vibe-kit/README.md](vibe-kit/README.md)
- 每一版改了什么：[vibe-kit/更新说明.md](vibe-kit/更新说明.md)
- 来改这个仓库的人和 AI：先读 [AGENTS.md](AGENTS.md)，再读 [CONTRIBUTING.md](CONTRIBUTING.md)

## 这个仓库里有什么

| 目录 | 是什么 | 状态 |
|---|---|---|
| `vibe-kit/` | 交付物的源码：安装器、套件（钩子、库、工具、看页面的执行器、状态栏）、模型路由和配置页、给模型的约定和技能 | 在维护 |
| `dev/` | 测试、打包、验收脚本，假 GitLab、假 ssh 这些测试支架，旧版本的代码副本（新旧对比用），查库技能的设计文档 | 在维护 |
| `docs/` | 协作文档：架构、开发、发版、约定、实测过的事实、设计决定、术语，以及早期的方案和审查报告 | 在维护 |
| `browser-probe/` | 早期的浏览器能力体检包：内网的模型能不能看图、写场景、驱动浏览器 | 冻结，不再改 |
| `coop-probe/` | 早期的协作能力体检包：内网模型的协作陷阱题、长上下文、项目编码体检 | 冻结，不再改 |

两个体检包是立项初期用来定设计的，结论已经写进了 vibe-kit 的设计（见 [docs/decisions.md](docs/decisions.md)）。它们的离线运行环境（`offline/`）、依赖（`node_modules/`）和结果（`results/`）不进仓库，要用的话跑包里的"外网准备"脚本重新下。

## 目标环境

- 内网完全离线。Claude Code 是独立的 exe，同事的版本从 2.1.120 到 2.1.259 都有，套件两头都要兼容。
- 模型是公司网关后面的几个私有模型，经本机的模型路由按"角色"分流（主会话、审查、后台小任务）。
- 团队的 AI 使用规定是硬约束：上下文过 70% 必须交接、不许随意开子代理、省 token、拿到需求要分模块出 spec。套件里任何要花 token 的设计都要说得清成本、能关掉。

## 开发要的东西

- Node 18 以上（套件只用 Node 自带的模块，不装依赖）、git。
- **克隆到短一点的路径**（比如 `C:\WorkSpace\ai-vibe-flow`），并打开 git 的长路径：看页面的依赖目录很深，路径超过 Windows 的 260 字符上限时检出会失败，打包用的 Compress-Archive 也会失败。

```bash
git clone -c core.longpaths=true git@github.com:ttlsarimakousei/ai-vibe-flow.git C:/WorkSpace/ai-vibe-flow
```

- 跑全量测试还要：Windows、系统自带的 Edge（看页面的测试）、Python 3、JDK 8 以上和 H2（查库的测试）、两个版本的 Claude Code（端到端）。装法见 [dev/README.md](dev/README.md)。

```bash
node dev/run-all.js
```

```bash
node dev/pack.js
```

第一条跑单元、安装、配置页、HTTP 钩子这些测试；加上旧版对比、端到端、真连库的全量命令见 [dev/README.md](dev/README.md)。第二条打出 `vibe-kit-<版本号>.zip`，发版的完整步骤见 [docs/release.md](docs/release.md)。

## 不进仓库的东西

打好的安装包（`*.zip`）、体检包的离线环境和结果、套件运行时才生成的文件（令牌、仓库地址、状态、问题反馈、路由的模型配置）。清单在 [.gitignore](.gitignore)。
