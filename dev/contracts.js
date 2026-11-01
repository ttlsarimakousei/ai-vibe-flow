'use strict';
/*
 * 测试按契约索引（2026-11-01，K 批 K1-7，Codex 改进路线第 10 节）：dev/contracts.md 分两部分
 *   上半：手写的契约表（保证什么 → 哪个测试哪一节），找"这件事有没有测"从这里找，不用先知道哪天的反馈
 *   下半：本工具从每个测试文件的开头注释和 H.section 标题生成的目录（--write 重写下半）
 * 用法：
 *   node dev/contracts.js --write   重写 contracts.md 的下半
 *   node dev/contracts.js --check   有测试文件不在目录里、契约表引了不存在的文件或节，退出码 1
 */
const fs = require('fs');
const path = require('path');

const DEV = __dirname;
const DOC = path.join(DEV, 'contracts.md');
const MARK = '<!-- 下面由 node dev/contracts.js --write 生成，不要手改 -->';

function tests() {
  return fs.readdirSync(DEV).filter((n) => /^(test|ui|e2e)-.+\.js$/.test(n)).sort();
}
function infoOf(name) {
  const text = fs.readFileSync(path.join(DEV, name), 'utf8');
  const head = (/\/\*([\s\S]*?)\*\//.exec(text) || [])[1] || '';
  const first = head.split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean)[0] || '';
  const sections = [...text.matchAll(/H\.section\(\s*(['"`])([\s\S]*?)\1\s*\)/g)].map((m) => m[2].replace(/\s+/g, ' ').trim());
  return { name, first, sections };
}
function generated() {
  const out = [MARK, '', '## 每个测试文件测什么', ''];
  for (const t of tests().map(infoOf)) {
    out.push('### ' + t.name, '');
    if (t.first) out.push(t.first, '');
    for (const s of t.sections) out.push('- ' + s);
    if (t.sections.length) out.push('');
  }
  return out.join('\n');
}
function write() {
  const cur = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  const top = cur.includes(MARK) ? cur.slice(0, cur.indexOf(MARK)) : cur;
  fs.writeFileSync(DOC, top.replace(/\s*$/, '\n\n') + generated() + '\n');
  console.log('写好了：' + path.relative(process.cwd(), DOC) + '（' + tests().length + ' 个测试文件）');
}
function check() {
  const cur = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  const problems = [];
  const listed = new Set([...cur.matchAll(/^### ((?:test|ui|e2e)-[^\s]+\.js)$/gm)].map((m) => m[1]));
  for (const t of tests()) if (!listed.has(t)) problems.push('目录里没有 ' + t + '（跑 node dev/contracts.js --write）');
  // 契约表里引的"文件 · 节"要存在
  const top = cur.includes(MARK) ? cur.slice(0, cur.indexOf(MARK)) : cur;
  const infos = new Map(tests().map((n) => [n, infoOf(n)]));
  for (const m of top.matchAll(/`((?:test|ui|e2e)-[^`]+\.js)`(?:\s*·\s*"([^"]+)")?/g)) {
    const t = infos.get(m[1]);
    if (!t) { problems.push('契约表引的 ' + m[1] + ' 不存在'); continue; }
    if (m[2] && !t.sections.some((s) => s.includes(m[2]))) problems.push('契约表引的 ' + m[1] + ' 里找不到节"' + m[2] + '"');
  }
  // 结果行照 dev/run-all.js 认的格式（通过 N 项，失败 M 项）
  const n = tests().length;
  if (problems.length) { console.log(problems.join('\n')); console.log('[X] 测试契约索引：通过 ' + n + ' 项，失败 ' + problems.length + ' 项'); process.exitCode = 1; } else console.log('[OK] 测试契约索引：通过 ' + n + ' 项（' + n + ' 个测试文件都在目录里，契约表引的节都在）');
}
if (process.argv.includes('--write')) write();
else check();
