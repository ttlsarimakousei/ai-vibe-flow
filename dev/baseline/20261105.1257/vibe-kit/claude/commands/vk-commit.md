---
disable-model-invocation: true
description: 提交：把这次改的提交（套件认它是你的提交许可，这一轮分几笔都算）
argument-hint: [说明]
---
用户要提交。把这一轮改的文件按规矩提交：只 add 这次改的、新建的文件（不用 git add -A、git add .、git commit -a），提交信息写成"类型: 内容"，按具体问题分几笔都行。这个会话用 Edit、Write 改的文件，可以直接 node "$HOME/.claude/vibe-kit/tools/commit.js" -m "类型: 内容" 只提交它们（暂存区里别的不动；壳子里每个子项目加 --dir <子项目> 各一条）。$ARGUMENTS
