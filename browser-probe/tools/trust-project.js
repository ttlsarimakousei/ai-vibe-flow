'use strict';
/*
 * 把本目录标记为 Claude Code 已信任的项目（写 ~/.claude.json 的 projects[<路径>].hasTrustDialogAccepted = true）。
 * 原因：claude -p 非交互模式不会弹信任对话框；未信任的目录会忽略项目里的 .claude/settings.json（权限放行、hook、MCP 自动批准全部失效）。
 * Claude Code 自己的提示语就是让人这么做的。只改这一个布尔值，其他内容原样保留。
 * 用法：node tools/trust-project.js [目录，默认为本包根目录]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const target = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const file = path.join(os.homedir(), '.claude.json');
let data = {};
if (fs.existsSync(file)) {
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('~/.claude.json 不是合法 JSON，放弃修改：' + e.message); process.exit(1); }
}
if (!data.projects || typeof data.projects !== 'object') data.projects = {};
// Claude Code 在不同启动方式下会用反斜杠或正斜杠作为键，两种都写
const keys = [target.replace(/\//g, '\\'), target.replace(/\\/g, '/')];
const changed = [];
for (const k of keys) {
  const cur = data.projects[k];
  if (cur && cur.hasTrustDialogAccepted === true) continue;
  data.projects[k] = Object.assign({ allowedTools: [] }, cur || {}, { hasTrustDialogAccepted: true });
  changed.push(k);
}
if (changed.length) {
  fs.copyFileSync(file, file + '.bak-browser-probe');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('已在 ~/.claude.json 标记信任：' + changed.join(' ; ') + '（原文件备份为 .claude.json.bak-browser-probe）');
} else {
  console.log('~/.claude.json 已信任本目录，无需修改');
}
