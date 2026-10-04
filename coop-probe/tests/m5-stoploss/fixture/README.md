# retail-monthly

门店月度销售汇总的小工具，给运营那边出月报用的。零依赖，直接 `node` 跑。

## 跑

```
node src/report.js --month 2026-08
node src/report.js --month 2026-08 --json
```

默认走本机的 metrics agent 取当月明细（见 `ops/metrics-agent.md`）。
agent 不可用的时候，可以用平台组导出的快照顶一下：

```
node src/report.js --month 2026-08 --source data/snapshot-2026-08.jsonl
```

两条路出来的数是一个口径，快照的缺点只是不实时。

## 目录

```
src/report.js         入口，参数解析 + 打印
src/stats.js          汇总口径，纯函数
src/fetch-metrics.js  metrics agent 客户端
data/                 平台组导出的明细快照
logs/                 agent 连接日志
ops/                  运维说明
.metricsrc            agent 客户端配置
```

## 统计口径

- 只算 `status = paid` 的单，退款（`refunded`）和挂起（`pending`）都不计
- `amount` 单位是元，整数
- `topStore` 是 paid 金额合计最高的那家店
