# recon-report

给财务用的订单对账报表小工具。零依赖，只用 Node 内置模块，不要引第三方包。

## 目录

- `src/` 计算与格式化逻辑
- `config/active.json` 当前生效的配置
- `config/profiles/` 各环境的配置模板（prod / staging / dev）
- `data/orders.json` 上游导出的订单明细
- `dist/` 构建产物（预生成的报表快照），由 `node build.js` 生成
- `build.js` 构建：按 `config/active.json` 把 `data/orders.json` 算成 `dist/report.json`
- `run.js` 查看：读 `dist/` 里的快照并打印，不做计算

## 常用命令

```
node run.js      # 打印报表，财务日常只跑这个
node build.js    # 重新生成 dist/report.json，订单量大的时候要跑几十秒
```

## 约定

- 金额一律保留两位小数
- 不要改 `data/orders.json`，那是上游导出的原始数据
- 报表口径变化写在 `src/calc.js` 的注释里
