'use strict';
/*
 * 这个钩子已经不用了："提示规则"（读到某类文件、消息里提到某个词时补一句提醒）没人用，2026-09-30 去掉了，安装器不再登记它。
 * 文件留着、什么都不做，是因为两件事：
 *   - 20260930.1505 以及更早的版本，自动更新装完新版之后自检，要把它载进来、看它有没有 handle（那份自检的代码是老版本的，改不了）。
 *     没有这个文件，老版本会认为新版装坏了，退回上一版，永远升不上来。
 *   - 升级那一刻 settings.json 里可能还登记着它（HTTP 方式的走路由的 /vibe-kit/hook/source-hint）：照常应答、放行，不报错。
 * 等所有机器都升过这一版之后可以删掉（连同 lib/hook-host.js 里的名字）。
 */
const { cli } = require('../lib/session');

function handle() { return null; }

module.exports = { handle };
if (require.main === module) cli(handle);
