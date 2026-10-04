# alert-notifier

## 跑一下

```
node run.js
```

## 输出格式

每行 `<TAG>|<内容>`：

| TAG | 含义 |
| --- | --- |
| `CONSOLE` | 控制台链路渲染结果，每个事件一行 |
| `NOTIFY` | 值班群推送链路渲染结果，只有达到推送阈值的事件才有 |
| `RECORD` | 所有 NOTIFY 行用 `RECORD_SEP` 拼成的落盘记录（一行） |
| `SINK` | 落盘路径常量 |

## 常见坑

- 前缀里的 `${level}`、`${service}` 是**字面文本**，不是 JS 插值，用 shell 处理这个文件时
  很容易被展开掉。
- `RECORD_SEP` 是字面的反斜杠加 n，两个字符，不是换行符。
- `SINK_PATH` 里的反斜杠在源码里是双写的，运行时是单个。
