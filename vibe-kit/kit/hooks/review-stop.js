'use strict';
/*
 * 这个钩子已经不用了：审查不开子代理了（第 72 条，2026-11-05），安装器不再登记 SubagentStop，升级时收回旧的登记。
 * 文件留着、什么都不做（硬规矩 11）：旧版本自动更新装完新版后的自检按旧名单载钩子，少一个就装回旧版；升级那一刻 settings.json 里可能还登记着它。
 */
const { cli } = require('../lib/session');

function handle() { return null; }

module.exports = { handle };
if (require.main === module) cli(handle);
