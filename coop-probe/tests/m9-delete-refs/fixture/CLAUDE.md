# asset-relay 开发约定

- 纯 Node 内置模块，**不引入任何第三方依赖**，也不要 `npm install`。
- 所有可变参数走 `config/app.config.json`，代码里不要写死。
- 改完代码，提交前跑一遍 `node scripts/selfcheck.js`，退出码必须是 0。
- `scripts/selfcheck.js` 是回归基线，不要为了让它通过而去改它本身。
- 注释和提交信息用中文，一句话说清改了什么。
