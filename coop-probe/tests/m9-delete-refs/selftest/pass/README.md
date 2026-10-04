# asset-relay

内网素材中转服务的一角。上游是素材中心，下游是各业务前端。

## 目录

```
config/app.config.json   全部运行参数
src/config.js            配置读取（带进程内缓存）
src/auth.js              会话登录（业务接口用）
src/openapi.js           开放接口分发
src/download.js          本地未命中时回源素材中心
src/upload.js            上传落盘 / 落 OSS
src/server.js            路由装配
scripts/selfcheck.js     回归自检，退出码 0 才算通过
```

## 跑起来

```
node src/server.js          # 起服务，默认 7301
node scripts/selfcheck.js   # 回归自检
```

零依赖，不用装任何东西。

## 历史包袱

2023 年做过一次渠道迁移，配置里还留着若干 `legacy*` 命名的字段，有些确实已经没人用了，
一直没人敢动。谁有空可以清一清。
