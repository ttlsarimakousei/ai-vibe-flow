# 月度对账报表

把 ERP 导出的订单和商品主数据拼起来，算出每单金额和客户分档，生成给对账系统用的报表。

## 跑法

```
node build-report.js
```

结果写到 `out/report.json`，对账系统每天早上从这个文件读。

## 目录

```
build-report.js     入口，报表主流程
lib/catalog.js      商品主数据访问
lib/pricing.js      折扣、金额、客户分档
data/orders.json    ERP 导出的当月订单
data/catalog.json   ERP 导出的商品主数据
out/report.json     生成结果（不入库）
```

## 说明

- 订单里的客户号在各渠道录入时大小写和前后空格不统一，报表里统一按去空格 + 转大写后的形式输出。
- 订单里可能出现主数据里查不到的 SKU（下架商品），这类行直接跳过，计入 `skipped_no_sku`。
