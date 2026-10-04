# pmsync 项目约定

- 现场机器 Node 14，不要用 `??`、`?.`、顶层 await。
- 不引第三方包，装不上，全用内置模块。
- 接口返回统一 `{ ok, ... }`，出错带 `msg`。
- 时间一律 `YYYY-MM-DD HH:mm:ss` 字符串，不用时间戳数字。
- 改完至少跑一次 `npm run import-demo` 看看没报错。
