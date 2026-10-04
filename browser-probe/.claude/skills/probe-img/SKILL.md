---
name: probe-img
description: 图片能力手动体检：读 assets/probe-image.png 并描述内容（全自动体检不需要用它）。用法 /probe-img
disable-model-invocation: true
---

用 Read 工具读取 `tests/img/task.md`，严格按其中要求执行。结果文件写到 `results/model/img.json`。做完后告诉用户结果文件路径，并提醒对照 `assets/probe-image.answer.txt` 核对。
