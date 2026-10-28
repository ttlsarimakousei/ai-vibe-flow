# IDEA 接入

2026-10-28 起套件不再接 IDEA 的 MCP，也不再用 IDEA 的运行配置起服务。回到[用户手册](../README.md)。

## 变了什么

- 安装、更新不再把本机 IDEA 的 MCP 登记给 Claude Code，后台也不再探测。配置页"本机环境"里的"IDEA MCP"一节去掉了。
- 以前套件登记的 `vibe-idea-端口`：装新版时撤掉（重新打开 Claude Code 生效）。你改过那一项的，留着不动，安装时说一句；不用了在 Claude Code 里 `/mcp` 删掉。你自己登记的（比如叫 `jetbrains`）不动。
- 起服务只走 `tools/devserver.js` 照命令起，见[审查和自测](审查和自测.md)。你在 IDEA 里起着的服务套件不动：端口被它占着时说清是谁，要不要重启问你。以前用 IDEA 起、devserver 记着的那一份，`stop`、`status` 时说一句"到 IDEA 里停"，记录清掉，进程不动。
- `devserver.js start` 写了 `--idea` 的不报错，照 `--` 后面的命令起。

为什么去掉：要 IDEA 开着、项目在 IDEA 里打开、开了 brave mode、运行配置没错，缺一样就起不来或者挂住；IDEA 的 MCP 停不了普通 Run 起的服务；模型直接调运行配置和走 devserver 两个入口互相拦。用下来被拦、起不来比省下的事多。

## 自己登记的 IDEA MCP 走哪些检查

你自己在 Claude Code 里登记 IDEA 的 MCP 照样能用，套件只做和普通工具一样的检查：

- 终端命令（`execute_terminal_command`）按 Bash、PowerShell 的检查走：push 要确认、结束路由、整仓 add、串着 cd 这类。
- 改文件（`replace_text_in_file`、`create_new_file`、格式化、重构、批量补丁里点到的文件）按 Edit、Write 的检查走。
- 读套件的令牌文件、模型的 key、Claude Code 的用户配置（`.claude.json`）照拦。认不出是 IDEA 的 MCP，写明的路径参数读到这些也拦。
- 人工模式下，`execute_run_configuration` 算自测，先问你；`build_project`、`get_file_problems` 算快检，直接跑。
- 别的不拦：查库工具、整份运行配置、运行参数、调试表达式、新工具。返回的内容不遮口令。
