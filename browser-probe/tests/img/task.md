# 任务 img：图片能力

1. 用 Read 工具读取文件 `assets/probe-image.png`（这是一张图片，不是文本）。
2. 回答四个问题：图中有几个色块？从左到右分别是什么颜色？图中的数字是什么？图中的汉字是什么？
3. 把答案写成 JSON 文件（路径由启动提示给出；没给时写 `results/model/img.json`），格式如下，值换成你看到的：

```json
{
  "readOk": true,
  "blocks": 0,
  "colors": ["颜色1", "颜色2"],
  "number": "",
  "text": "",
  "notes": ""
}
```

规则：Read 图片报错时不要重试，`readOk` 写 false，把错误信息原样写进 `notes`，其他字段留空。不要猜图片内容，不要读 `assets/probe-image.answer.txt`。
