'use strict';
// 实测：一个大任务的几个 change 都不归档时，后一个改前一个新增的内容，自带的 OpenSpec 校验和归档怎么样。
// 假用户目录、临时项目，不碰真实目录。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', '..', 'vibe-kit', 'kit', 'openspec', 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-os-'));
const home = path.join(root, 'home'); fs.mkdirSync(home, { recursive: true });
const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'a'), LOCALAPPDATA: path.join(home, 'l'), XDG_CONFIG_HOME: path.join(home, 'x'), OPENSPEC_TELEMETRY: '0' });

function run(cwd, args) {
  const r = spawnSync(process.execPath, [bin].concat(args), { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: (String(r.stdout || '') + String(r.stderr || '')).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() };
}
function show(title, r) { console.log('\n=== ' + title + '\n退出码 ' + r.code + '\n' + r.out.split('\n').slice(0, 14).join('\n').slice(0, 1200)); }
function write(p, t) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }

const WHY = '## Why\n\n这个大任务要做订单导出，这里写清楚为什么要做这件事，字数要够校验要求的长度，所以多写一点说明文字，凑够五十个字以上。\n\n## What Changes\n\n- 导出订单\n';
function change(proj, name, kind, sentence) {
  const d = path.join(proj, 'openspec', 'changes', name);
  write(path.join(d, 'proposal.md'), WHY);
  write(path.join(d, 'tasks.md'), '- [x] 1.1 做完：src/A.java\n');
  write(path.join(d, 'specs', 'order', 'spec.md'), '## ' + kind + ' Requirements\n\n### Requirement: 导出订单\n\nThe system SHALL ' + sentence + '\n\n#### Scenario: 导出\n\n- **WHEN** 用户点导出\n- **THEN** 得到文件\n');
}

const proj = path.join(root, 'p'); fs.mkdirSync(proj);
show('init', run(root, ['init', '--tools', 'none', proj]));
change(proj, 'c1-model', 'ADDED', 'export orders as csv.');
change(proj, 'c2-api', 'MODIFIED', 'export orders as xlsx.');
write(path.join(proj, 'openspec', 'plan.md'), '# 计划：订单导出\n\n探索记录：explore/order-export.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| 模型 | c1-model | | |\n| 接口 | c2-api | | |\n');
write(path.join(proj, 'openspec', 'explore', 'order-export.md'), '# 探索记录\n');

show('list：plan.md、explore/ 在旁边会不会受影响', run(proj, ['list']));
show('validate c1 --strict（新增）', run(proj, ['validate', 'c1-model', '--strict']));
show('validate c2 --strict（改 c1 新增的，c1 没归档）', run(proj, ['validate', 'c2-api', '--strict']));
show('validate --all --strict', run(proj, ['validate', '--all', '--strict']));
show('先归档 c2（顺序错）', run(proj, ['archive', 'c2-api', '-y']));
show('c2 还在不在：list', run(proj, ['list']));
show('归档 c1', run(proj, ['archive', 'c1-model', '-y']));
show('再归档 c2', run(proj, ['archive', 'c2-api', '-y']));
let spec = ''; try { spec = fs.readFileSync(path.join(proj, 'openspec', 'specs', 'order', 'spec.md'), 'utf8'); } catch (e) { spec = '（没有主规格）'; }
console.log('\n=== 主规格里的那句\n' + (spec.match(/The system SHALL[^\n]*/g) || ['（没找到）']).join('\n'));
console.log('explore 还在：' + fs.existsSync(path.join(proj, 'openspec', 'explore', 'order-export.md')) + '；plan.md 还在：' + fs.existsSync(path.join(proj, 'openspec', 'plan.md')));
fs.rmSync(root, { recursive: true, force: true });
console.log('临时目录已删：' + !fs.existsSync(root));
