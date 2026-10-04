# pmsync — 设备巡检记录同步服务

厂区设备巡检的记录上报 / 缓存 / 同步中转服务。现场 PDA 把巡检结果报上来，本服务先落盘，
再由夜间同步任务批量推给集团的 MES。

## 技术栈

- Node.js 14+（现场机器上装的是 14.17，别用太新的语法）
- 本服务基于 Express 搭建，路由都注册在 `src/routes.js` 里
- 无前端，只有 HTTP 接口

## 目录

```
server.js            服务入口
src/routes.js        接口路由
src/store.js         数据读写
src/generated/       字段映射表
src/legacy/          老协议解析
scripts/             运维小脚本
```

## 数据

巡检记录保存在 SQLite 数据库 `data/pmsync.db`，表名 `t_record`。
单表，主键 `id`（PDA 端生成，格式 PM + 日期 + 三位流水）。

字段含义见 `src/generated/fieldMap.js` 里的中英对照。

## 接口

- `GET  /api/records?deviceNo=xxx` 查记录，不传 deviceNo 返回全部
- `POST /api/record` 上报一条巡检记录，body 是 JSON
- `POST /api/upload` PDA 批量上报，body 是老协议的分号串，走 legacy 解析

## 运行

```
npm start          # 起服务，默认 8080
npm run import-demo   # 灌几条演示数据
```

## 待办

- 同步任务还没写，现在只是攒数据
- 老协议那块是从上一版系统抄过来的，能跑就没动
- 缺日志，出问题只能 console 看
