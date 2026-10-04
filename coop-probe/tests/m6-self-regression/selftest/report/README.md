# alertbox

把采集端追加的告警流水汇总成一份人能看的日报。

## 跑

```
node bin/alertbox.js              # 出文本日报
node bin/alertbox.js --json       # 出机器可读的结果，值班大盘在读
node bin/alertbox.js other.log    # 换一个日志文件
```

## 大概流程

1. `src/normalize.js` 把每行流水解析成对象，并算出一个**告警指纹**
2. `src/mute.js` 按 `config/mute.json` 的静默名单把噪音类的挡掉
3. `src/report.js` 把剩下的按指纹合并成几类，排序，渲染

## 自检

```
node selfcheck.js
```
