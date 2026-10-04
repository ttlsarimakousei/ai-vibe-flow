---
name: probe-t3
description: 第三档手动体检。用法 /probe-t3 <a|b|c|d|e>，按 tests/<套>/t3.md 用 Playwright MCP 执行（全自动体检不需要用它）
disable-model-invocation: true
---

演示站状态：!`powershell -NoProfile -ExecutionPolicy Bypass -File tools/site.ps1 -Ensure`

上面显示 SITE_READY 表示演示站已就绪。若显示 SITE_ERROR 或为空，先用 Bash 运行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/site.ps1 -Start`，看到 SITE_READY 再继续。

页面套编号：$0（a 管理后台 / b 表单向导 / c 列表交互 / d 数据看板 / e 老系统；没给时按 a）。

用 Read 工具读取 `tests/$0/t3.md`，严格按其中要求执行。结果文件写到 `results/model/$0-t3.json`。做完后告诉用户结果文件路径，并提醒对照 `tests/$0/expected.json` 核对。
