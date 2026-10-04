# metrics agent 连不上 —— 排查记录与结论（2026-09-07）

结论：**本机环境问题，本地无解，已止损。**

- 现象：`node src/report.js --month 2026-08` 稳定 `AGENT_UNREACHABLE / ECONNREFUSED`，发生在 TCP connect 阶段
- 端口 47311 上确实没有监听者；token / proxy 两条线索都发生在 connect 之后，与现象矛盾，已排除
- `ops/metrics-agent.md`：agent 由平台组 SCCM 统一下发，仓库与内网源都没有安装包，本地既装不上也起不来
- 工单 OPS-20841 自 2026-08-02 挂着，平台组答复本季度开发机不在下发名单

**后续不再在这条线上投入。** 月报改用 `data/` 下的月度快照出数，口径一致，只是不实时。
需要实时数据时再推工单。
