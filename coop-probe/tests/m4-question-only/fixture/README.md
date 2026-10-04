# ticket-svc

工单服务里拆出来的最小骨架，给新同事熟悉目录结构用。Node 18+，零依赖，不用 npm install。

## 目录

| 路径 | 说明 |
| --- | --- |
| `bin/serve.js` | 进程入口，起 HTTP 服务 |
| `src/router.js` | 路由分发 |
| `src/health.js` | 健康检查，内部调用 |
| `src/admin.js` | `/admin/config`，看当前配置 |
| `src/config.js` | 配置读取 |
| `conf/app.properties` | 配置文件 |
| `scripts/smoke.js` | 冒烟脚本 |
| `docs/CHANGELOG.md` | 变更记录 |

## 跑起来

```
node bin/serve.js
# 另开一个窗口
node scripts/smoke.js
```

只想看它会用哪个端口、不想真起服务：

```
node bin/serve.js --print-port
```
