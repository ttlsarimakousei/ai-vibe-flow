# ai-vibe-flow

这个仓库的协作规矩写在 AGENTS.md，所有 AI 共用一份。下面导入它，再补几条只和 Claude Code 有关的。

@AGENTS.md

## Claude Code 补充

- Bash 工具里不要 `cd`，写完整路径。内容带反斜杠（正则、Windows 路径）的补丁不要塞进 heredoc 或 `node -e`，用 Write 写成脚本文件再跑，或者用 Edit。
- 改 `.bat`（GBK + CRLF）不要用 Edit / Write，会被转成 UTF-8 毁掉中文：用脚本按字节改。
- 这台电脑上装的 vibe-kit 套件（如果装了）也会对这个仓库生效：被它拦下就照提示改。它拦错了，记问题反馈，不要改 `~/.claude` 里套件的文件。
- 你的自动记忆只在你自己的电脑上，别人的 AI 看不到。要让协作者都知道的事实和规矩，写进 `docs/` 里对应的文档，不要只记在记忆里。
