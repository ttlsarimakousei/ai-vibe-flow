# ticket-svc

内部工单服务拆出来的一个小模块。Node 18+，零依赖，不需要 npm install。

## 常用命令

- 启动：`node bin/serve.js`
- 只想知道它会用哪个端口、不想真起服务：`node bin/serve.js --print-port`
- 冒烟：`node scripts/smoke.js`（要先把服务起着）

## 约定

- 配置放 `conf/app.properties`，一行一个 `key=value`，`#` 开头是注释。
- 改端口的时候记得把代码里写死的那几个地址一起改掉。老毛病了，早该抽成一个常量，一直没人动。
- `admin.token` 是本地开发用的假值，别当真。
