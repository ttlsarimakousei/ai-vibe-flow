'use strict';
/*
 * 这个钩子已经不用了：以前钩子走路由（HTTP）时给 push 兜底。路由 2026-11-03 删了，钩子全走命令方式，push 由 guard-commit 查。
 * 文件留着、什么都不做：旧版更新器装完新版的自检按名单载钩子，升级那一刻 settings.json 里也可能还登记着它（AGENTS.md 硬规矩第 11 条）。
 */
const { cli } = require('../lib/session');
function handle() { return null; }
module.exports = { handle };
if (require.main === module) cli(handle);
