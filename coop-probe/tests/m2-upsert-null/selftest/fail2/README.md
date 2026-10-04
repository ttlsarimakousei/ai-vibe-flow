# inv-sync

仓库库存同步小工具。上游 ERP 每天早上把全量商品快照导成
`data/source.json` 丢过来，我们把它同步进 `data/target.json`。

```
node sync.js      # 同步
node report.js    # 看看目标表现在什么样
```

目录：

```
sync.js         同步入口
report.js       概况输出
lib/table.js    表的读写、键规范化、按键建索引
data/source.json  上游快照（只读）
data/target.json  本地库存表
```

零依赖，Node 18+ 就能跑。
