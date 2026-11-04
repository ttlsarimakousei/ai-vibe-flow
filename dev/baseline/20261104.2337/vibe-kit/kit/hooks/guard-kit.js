'use strict';
/*
 * 空壳。以前在改文件时拦"改套件自己的文件、往 settings 里写 disableAllHooks、直接改经验规则的文件"（开关"禁止改套件"）。
 * 2026-11-04 仓库主人定的：套件默认可以改，开关去掉了，这道检查也去掉了。文件留着：自动更新后的自检按旧版的名单载钩子（硬规矩 11）。
 */
const { cli } = require('../lib/session');

function handle() { return null; }

module.exports = { handle };
if (require.main === module) cli(handle);
