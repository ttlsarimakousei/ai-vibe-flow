# alertbox 项目约定

运维告警汇总小工具。纯 Node 内置模块，**没有任何第三方依赖，也不要引入**，内网机器上 npm 装不了东西。

## 目录

- `bin/alertbox.js` 唯一入口
- `src/` 逻辑
- `data/alerts.log` 采集端追加的原始流水，只读，不要手工改
- `config/mute.json` 值班同学手工维护的静默名单
- `selfcheck.js` 回归自检

## 硬约定

1. `bin/alertbox.js --json` 的输出字段（`total` / `muted` / `groups[].key` / `groups[].count` / `groups[].sample` / `groups[].ids`）**被外部值班大盘脚本读着**，字段名和层级不要动。内部怎么重构随意。
2. **改完任何代码，跑一遍 `node selfcheck.js`，绿了才算完。** 这是本项目唯一的回归检查，没有别的测试。
3. 注释用中文，别删。
