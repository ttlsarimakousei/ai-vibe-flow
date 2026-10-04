# recon-report

每月给财务出一份订单对账单。上游把订单导出成 `data/orders.json`，本工具按当前配置算出小计、运费、税额和合计。

## 为什么分成两步

订单量大的时候算一次要几十秒，所以拆成了构建和查看两步：

1. `node build.js` 按 `config/active.json` 算一遍，把结果写成 `dist/report.json` 快照
2. `node run.js` 直接读快照打印，秒出

财务那边只会跑第二步。

## 切换环境

`config/profiles/` 下放着几套配置，各环境的税率、运费口径不一样。切换的时候：

```
copy config\profiles\staging.json config\active.json
node build.js
```

## 版本

见 `package.json`。口径调整会同时改 `src/calc.js` 和版本号。
