'use strict';
/*
 * 把一批目录标记为 Claude Code 已信任（写 ~/.claude.json 的 projects[<路径>].hasTrustDialogAccepted = true）。
 * 原因：claude -p 非交互模式不弹信任对话框；未信任的目录会忽略 settings 里的权限放行与 hook，
 * 而每个测试用例的工作区都会被 git init 成独立项目根，所以每个都要单独标记。
 * 用法：node tools/trust-project.js <目录1> [目录2] ...
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const targets = process.argv.slice(2).map((p) => path.resolve(p));
if (!targets.length) { console.error('用法：node tools/trust-project.js <目录1> [目录2] ...'); process.exit(2); }

const file = path.join(os.homedir(), '.claude.json');
let data = {};
if (fs.existsSync(file)) {
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('~/.claude.json 不是合法 JSON，放弃修改：' + e.message); process.exit(1); }
}
if (!data.projects || typeof data.projects !== 'object') data.projects = {};

const changed = [];
for (const t of targets) {
  // Claude Code 在不同启动方式下会用反斜杠或正斜杠作为键，两种都写
  for (const k of [t.replace(/\//g, '\\'), t.replace(/\\/g, '/')]) {
    const cur = data.projects[k];
    if (cur && cur.hasTrustDialogAccepted === true) continue;
    data.projects[k] = Object.assign({ allowedTools: [] }, cur || {}, { hasTrustDialogAccepted: true });
    changed.push(k);
  }
}

if (changed.length) {
  const bak = file + '.bak-coop-probe';
  // 全新的机器上可能还没有 ~/.claude.json，没有就不用备份
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('已标记信任 ' + changed.length + ' 个键（' + targets.length + ' 个目录），原文件首次备份为 .claude.json.bak-coop-probe');
} else {
  console.log('这些目录都已信任，无需修改');
}
