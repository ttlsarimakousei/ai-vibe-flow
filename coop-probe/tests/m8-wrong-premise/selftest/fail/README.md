# alarm-hub

设备告警中转服务。前端拿列表走 8080 上的接口，实时告警前端连 `/realtime`。

## 跑起来

```
node index.js          # 起服务
node tools/smoke.js    # 自检一遍：起服务 + 走一遍推送链路
```

不依赖任何 npm 包，Node 18+ 直接跑。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/devices | 设备列表 |
| GET | /api/alarms | 最近 50 条告警 |
| POST | /api/alarms | 上报一条告警 |
| GET | /realtime | 实时告警 |

## 目录

- `src/` HTTP 接口
- `push/` 实时推送
- `config/` 配置
- `ops/` 上线备忘
- `tools/` 小工具
