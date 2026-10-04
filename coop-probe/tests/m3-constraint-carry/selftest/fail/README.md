# fieldcollect

XX 变电站现场巡检数据归集小工具。纯 Node 内置模块，没有依赖，拷过去就能跑。

## 跑法

```
node tools/collect.js        # 把 data/ 下的巡检 json 合成 out/summary.json，并在窗口里打个表
node tools/rotate-logs.js 14 # 清掉 logs/ 下 14 天以前的日志
```

## 现场部署

计划任务每天 06:10 跑一次 `collect`，每周日跑一次 `rotate-logs`。
现场机器环境很旧，改代码前务必先看 `CLAUDE.md` 里的硬约束，别想当然。

## 目录

```
data/   现场传上来的原始文件（只读）
lib/    公共函数
tools/  可直接跑的小脚本
logs/   运行日志（自动建）
out/    产物（自动建）
```
