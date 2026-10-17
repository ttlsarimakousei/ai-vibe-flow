'use strict';
/*
 * 找测试里还在用旧说法、旧默认值的地方（2026-10-18 起，开发中改了提示的说法、默认值之后跑）。
 * 起因：20261018.0051 那一版全量回归 40 项不过、验收 1 项不过，全是过时的断言（提交方式默认改成关、打勾不查验法……），
 * 一直到发版才暴露，修完补跑用了 23 分钟。这里在开发中就把它们找出来，不用等跑完回归：
 *   1. 旧说法：测试脚本里的中文片段（连着 4 个字以上），从 <标签> 以来套件源码里删掉了、现在的源码里一处都没有了
 *      （注释、每一项的名字、反着断言的 !/旧说法/.test(…) 不算：最后这种本来就是要求旧说法不再出现）
 *   2. 旧默认值：kit/lib/session.js 的 DEFAULT_CONFIG 从 <标签> 以来改了的开关，列出提到它的测试
 * 判断全靠文本比对：找到的是"可能过时"，要看一眼；没找到不等于测试都对（拼出来的句子、正则里拆开的字找不到）。
 * 用法：node dev/stale-asserts.js [标签，默认最近的版本标签]     找到旧说法时退出码 1
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const git = (args) => { const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? String(r.stdout || '') : null; };
const base = process.argv[2] || (git(['describe', '--tags', '--abbrev=0', '--match', 'v*']) || '').trim();
if (!base || git(['rev-parse', '--verify', '--quiet', base + '^{commit}']) === null) { console.log('用法：node dev/stale-asserts.js [标签]（找不到标签 ' + (base || '') + '）'); process.exit(2); }

// 套件源码：会打进安装包、给用户和模型看的那些（不含带进来的第三方包）
const SRC_DIRS = ['vibe-kit/kit', 'vibe-kit/claude', 'vibe-kit/router'];
const SRC_FILES = ['vibe-kit/install.js', 'vibe-kit/publish.js'];
const TEXT = /\.(js|json|md|py|html|ps1|txt|java)$/i;
function walk(dir, out) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of list) {
    if (e.name === 'node_modules' || e.name === 'state') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile() && TEXT.test(e.name)) out.push(p);
  }
  return out;
}
const now = SRC_DIRS.flatMap((d) => walk(path.join(REPO, d), [])).concat(SRC_FILES.map((f) => path.join(REPO, f)))
  .map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }).join('\n');
const diff = git(['diff', '-U0', '--no-color', '--no-renames', base, '--'].concat(SRC_DIRS, SRC_FILES)) || '';
const removed = diff.split(/\r?\n/).filter((l) => l[0] === '-' && !l.startsWith('---')).join('\n');

// 测试脚本
const tests = fs.readdirSync(__dirname).filter((n) => /^(test-|ui-|e2e-|check-).*\.js$|^(diff-hooks|accept-packages)\.js$/.test(n)).sort();
// 中文片段：汉字和中文标点连着的一段
const RUN = /[一-鿿　-〿！-～]{4,}/g;
const hits = [];
for (const n of tests) {
  const lines = fs.readFileSync(path.join(__dirname, n), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // 注释里的不算（说明文字常常提到以前的样子）
    // 每一项的名字（H.ok('名字', …)、H.section('名字')）是说明文字，不是断言
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '').replace(/\b(ok|section)\(\s*(['"`])(?:\\.|(?!\2).)*\2/g, '$1(');
    // 反着断言的（!/旧说法/.test(…)、!x.includes('旧说法')：要求旧说法不再出现）不算
    const negated = [...code.matchAll(/!\s*\/(?:\\.|[^/\n])+\/[a-z]*\.test\(|!\s*[\w.$()[\]]+\.includes\(\s*(['"`])(?:\\.|(?!\1).)*\1/g)].map((m) => [m.index, m.index + m[0].length]);
    const seen = new Set();
    for (const m of code.matchAll(RUN)) {
      const s = m[0];
      if (negated.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if (seen.has(s) || !removed.includes(s) || now.includes(s)) continue;
      seen.add(s);
      hits.push({ file: n, line: i + 1, text: s });
    }
  });
}

// 默认值：DEFAULT_CONFIG 是一行，按"名字: 值"比
const cfgOf = (text) => { const m = String(text || '').match(/const DEFAULT_CONFIG = \{([^\n]*)\};/); const o = {}; if (m) for (const x of m[1].matchAll(/(\w+):\s*('[^']*'|"[^"]*"|[^,\s]+)/g)) o[x[1]] = x[2]; return o; };
const before = cfgOf(git(['show', base + ':vibe-kit/kit/lib/session.js']));
const after = cfgOf(fs.readFileSync(path.join(REPO, 'vibe-kit', 'kit', 'lib', 'session.js'), 'utf8'));
const changed = [...new Set(Object.keys(before).concat(Object.keys(after)))].filter((k) => before[k] !== after[k]);

console.log('从 ' + base + ' 以来：');
if (hits.length) {
  console.log('测试里还在用、现在的源码里已经没有了的说法（' + hits.length + ' 处，按文件）：');
  let last = '';
  for (const h of hits) { if (h.file !== last) { console.log('  ' + h.file); last = h.file; } console.log('    ' + h.line + '：' + h.text); }
} else console.log('测试里没找到已经删掉的说法');
if (changed.length) {
  console.log('默认值改了的开关：');
  for (const k of changed) {
    const users = tests.filter((n) => new RegExp('\\b' + k + '\\b').test(fs.readFileSync(path.join(__dirname, n), 'utf8')));
    console.log('  ' + k + '：' + (before[k] === undefined ? '（新加的）' : before[k]) + ' → ' + (after[k] === undefined ? '（去掉了）' : after[k]) + '；提到它的测试：' + (users.length ? users.join('、') : '没有'));
  }
} else console.log('默认值没改');
process.exit(hits.length ? 1 : 0);
