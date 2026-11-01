'use strict';
/*
 * 编译、测试失败时只给摘要（K3 M08，2026-11-01）。
 * 命令失败走 PostToolUseFailure：顶层 error 是"Exit code N"加一个换行、再跟命令的全部输出（stdout、stderr 混在一起；2.1.120、2.1.289 实测）。
 * after-tool 收到失败的编译、测试命令（mvn、gradle、npm/yarn/pnpm 的 test/build/lint、tsc、vue-tsc、eslint、jest、vitest、pytest、
 * python -m pytest/unittest、node --test、javac、go、cargo、dotnet……）时调这里：抽出第一个错误、它指的 文件:行、那个文件里前后 5 行源码，
 * 作为 additionalContext 送给模型（PostToolUseFailure 的 additionalContext 两版都送得到，实测），省得它在几千行输出里翻、再去读文件。
 * 成功的命令、认不出的命令、抽不出错误的输出，什么都不加（不猜）。只读文件、不跑命令，出错就当没有。
 */
const fs = require('fs');
const path = require('path');

/** 编译、测试命令是哪一类；不是返回 '' */
function kindOf(cmd) {
  const c = String(cmd || '');
  if (/(^|[\s;&|("'\\/])mvnw?(\.cmd)?(\s|$)/i.test(c)) return 'Maven';
  if (/(^|[\s;&|("'\\/])gradlew?(\.bat)?(\s|$)/i.test(c)) return 'Gradle';
  if (/(^|[\s;&|("'\\/])(vue-)?tsc(\.cmd)?(\s|$)/i.test(c)) return 'TypeScript';
  if (/(^|[\s;&|("'\\/])eslint(\.cmd)?(\s|$)/i.test(c)) return 'ESLint';
  if (/(^|[\s;&|("'\\/])(jest|vitest|mocha)(\.cmd)?(\s|$)/i.test(c)) return 'JS 测试';
  if (/(^|[\s;&|("'])(npm|pnpm|yarn|cnpm)(\.cmd)?\s+(?:run(?:-script)?\s+)?(t|test|tests|test:[\w:-]+|build|build:[\w:-]+|lint|lint:[\w:-]+|typecheck|type-check|check|compile)(\s|$)/i.test(c)) return 'npm';
  if (/(^|[\s;&|("'\\/])pytest(\.exe)?(\s|$)|(^|[\s;&|("'])(python3?|py)(\.exe)?\s+(-\d(\.\d+)?\s+)?-m\s+(pytest|unittest|py_compile)\b/i.test(c)) return 'Python';
  if (/(^|[\s;&|("'\\/])node(\.exe)?\s+(--test|--check)\b/i.test(c)) return 'Node';
  if (/(^|[\s;&|("'\\/])javac(\.exe)?(\s|$)/i.test(c)) return 'javac';
  if (/(^|[\s;&|("'])go\s+(build|test|vet)\b|(^|[\s;&|("'])cargo\s+(build|test|check)\b|(^|[\s;&|("'])dotnet\s+(build|test)\b/i.test(c)) return '编译';
  return '';
}

// 这些位置不是项目里的代码：依赖、运行时自己的
const NOT_MINE = /(^|[\\/])(node_modules|site-packages|dist-packages|\.m2|\.gradle)([\\/]|$)|^node:|^internal[\\/]|<anonymous>|^\[eval\]/i;
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
/** Maven 在 Windows 上写成 /C:/x/y：去掉前面那个斜杠；file:/// 也去掉 */
const cleanPath = (p) => String(p || '').trim().replace(/^file:\/\/\/?/i, '').replace(/^\/([A-Za-z]:[\\/])/, '$1').replace(/^["']|["']$/g, '');

/**
 * 从输出里找第一个错误：{ file, line, col, message, detail: [补充的几行] }。找不到返回 null。
 * 按行从上往下看，第一条认得出来的就是它（后面的错误常常是它连带出来的）
 */
function firstError(output, kind) {
  const lines = strip(output).split('\n');
  let eslintFile = '';
  let pyFrame = null;
  let jsMessage = '';
  let jsHead = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    // node --check、node 跑脚本的语法错：先一行"C:\x\a.js:3"，几行之后是"SyntaxError: …"
    if ((m = /^((?:[A-Za-z]:[\\/]|\/)[^:*?"<>|]*\.(?:[cm]?[jt]sx?|vue)):(\d+)\s*$/.exec(l.trim()))) { jsHead = { file: m[1], line: +m[2] }; continue; }
    // Maven 的编译插件：[ERROR] /C:/x/A.java:[45,20] 找不到符号
    if ((m = /^\[(?:ERROR|错误)\]\s+(\S.*?\.(?:java|kt|scala|groovy)):\[(\d+)(?:,(\d+))?\]\s*(.*)$/.exec(l))) return withDetail({ file: m[1], line: +m[2], col: +(m[3] || 0), message: m[4] }, lines, i, /^\s*(?:\[ERROR\]\s+)?\s*(符号|位置|symbol|location)\s*[:：]/i);
    // javac：src/x/A.java:12: 错误: 找不到符号 / error: cannot find symbol
    if ((m = /^(\S.*?\.java):(\d+):\s*(?:错误|error)\s*[:：]\s*(.*)$/i.exec(l))) return withDetail({ file: m[1], line: +m[2], col: 0, message: m[3] }, lines, i, /^\s*(符号|位置|symbol|location)\s*[:：]/i);
    // Kotlin（Gradle）：e: file:///x/A.kt:12:5 消息
    if ((m = /^e:\s+(\S+\.kts?):(\d+):(\d+)\s+(.*)$/.exec(l))) return { file: m[1], line: +m[2], col: +m[3], message: m[4], detail: [] };
    // TypeScript：src/a.ts(12,5): error TS2339: … 或 src/a.ts:12:5 - error TS2339: …
    if ((m = /^(\S.*?\.(?:tsx?|vue|jsx?|mts|cts))\((\d+),(\d+)\):\s*error\s+(TS\d+:.*)$/.exec(l)) || (m = /^(\S.*?\.(?:tsx?|vue|jsx?|mts|cts)):(\d+):(\d+)\s+-\s+error\s+(TS\d+:.*)$/.exec(l))) return { file: m[1], line: +m[2], col: +m[3], message: m[4], detail: [] };
    // ESLint：先一行文件名，下面"  12:5  error  消息  规则名"
    if (/^(?:[A-Za-z]:[\\/]|\/)\S.*\.\w+$/.test(l.trim()) && !/\s{2}/.test(l.trim())) { eslintFile = l.trim(); continue; }
    if (eslintFile && (m = /^\s+(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)\s*$/.exec(l))) return { file: eslintFile, line: +m[1], col: +m[2], message: m[3] + '（' + m[4] + '）', detail: [] };
    // pytest：tests/test_a.py:12: AssertionError（失败块最后一行），上面 E 开头的几行是原因
    if ((m = /^(\S.*?\.py):(\d+):\s+(\w*(?:Error|Exception|Failed)\w*)\s*$/.exec(l))) {
      const es = []; for (let k = i - 1; k >= 0 && k > i - 30; k--) { if (/^E\s/.test(lines[k])) es.unshift(lines[k].replace(/^E\s+/, '').trim()); else if (es.length) break; }
      return { file: m[1], line: +m[2], col: 0, message: m[3] + (es.length ? '：' + es[0] : ''), detail: es.slice(1, 3) };
    }
    // Python 的 Traceback：记最后一个项目里的帧，碰到"XxxError: 消息"那一行就是它
    if ((m = /^\s*File "([^"]+)", line (\d+)/.exec(l))) { if (!NOT_MINE.test(m[1])) pyFrame = { file: m[1], line: +m[2] }; continue; }
    if (pyFrame && (m = /^(\w+(?:\.\w+)*(?:Error|Exception|Exit|Interrupt|Warning)):?\s*(.*)$/.exec(l.trim()))) return { file: pyFrame.file, line: pyFrame.line, col: 0, message: m[1] + (m[2] ? '：' + m[2] : ''), detail: [] };
    // Node、Jest、Vitest：先有一行错误信息，下面"at …(文件:行:列)"里第一个项目里的位置
    if (!jsMessage && (m = /^\s*((?:\w+)?(?:Error|AssertionError)(?:\s*\[[\w_]+\])?:\s*.+)$/.exec(l))) {
      jsMessage = m[1].trim();
      // "Expected values to be strictly equal:"这种以冒号结尾的，下面隔一个空行才是"2 !== 3"：带上它
      if (/[:：]$/.test(jsMessage)) { for (let k = i + 1; k < lines.length && k <= i + 4; k++) { const t = lines[k].trim(); if (!t) continue; if (!/^at\s|^[\w-]+:\s|^\^/.test(t)) jsMessage += ' ' + t; break; } }
      if (jsHead && !NOT_MINE.test(jsHead.file)) return { file: jsHead.file, line: jsHead.line, col: 0, message: jsMessage, detail: [] };
      continue;
    }
    // node --test 的 TAP：error: 'x' 或者 error: |- 下面几行
    if (!jsMessage && (m = /^\s*(?:error|message):\s*(.*?)\s*$/.exec(l)) && m[1]) {
      let v = m[1].replace(/^['"]|['"]$/g, '');
      if (/^[|>][-+]?$/.test(v)) { v = ''; for (let k = i + 1; k < lines.length && k <= i + 4 && !v; k++) v = lines[k].trim(); }
      if (v) jsMessage = v;
      continue;
    }
    if ((m = /^\s+at\s+(?:.*?\()?((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/|\.{0,2}[\w.-]+[\\/])[^():]*?\.(?:[cm]?[jt]sx?|vue)):(\d+):(\d+)\)?\s*$/.exec(l)) || (m = /^\s*location:\s*'((?:file:\/\/\/?)?[^']+?\.(?:[cm]?[jt]sx?)):(\d+):(\d+)'/.exec(l))) {
      if (NOT_MINE.test(m[1])) continue;
      return { file: m[1], line: +m[2], col: +m[3], message: jsMessage || '测试没过', detail: [] };
    }
    // Maven 跑测试没过：[ERROR]   OrderServiceTest.testX:45 期望…（只有类名，文件按类名找）
    if ((m = /^\[ERROR\]\s+([A-Z]\w*)\.(\w+):(\d+)\s+(.*)$/.exec(l)) && kind === 'Maven') return { file: '', cls: m[1], line: +m[3], col: 0, message: m[2] + '：' + m[4], detail: [] };
  }
  return null;
}
/** 错误下面几行里的"符号：""位置："（javac 中间隔着源码和 ^ 那两行）：碰到空行、下一条 [ERROR]/[INFO] 就停 */
function withDetail(e, lines, i, re) {
  const detail = [];
  for (let k = i + 1; k < lines.length && k <= i + 6 && detail.length < 3; k++) {
    const t = lines[k];
    if (re.test(t)) { detail.push(t.replace(/^\s*\[ERROR\]\s*/, '').trim()); continue; }
    if (!t.trim() || /^\s*\[(ERROR|INFO|WARNING|错误)\]/.test(t) || /^\S.*:\d+:/.test(t)) break;
  }
  return Object.assign(e, { detail });
}

/** Maven 测试只给了类名：在 src/test 下找 <类名>.java（最多找 3000 个文件） */
function findClass(root, cls) {
  let budget = 3000;
  const walk = (d, depth) => {
    if (depth > 14 || budget <= 0) return '';
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return ''; }
    for (const e of es) {
      if (--budget <= 0) return '';
      if (e.isFile() && e.name === cls + '.java') return path.join(d, e.name);
    }
    for (const e of es) if (e.isDirectory() && !/^(\.|node_modules$|target$|build$)/.test(e.name)) { const f = walk(path.join(d, e.name), depth + 1); if (f) return f; }
    return '';
  };
  for (const sub of ['src/test', 'src']) { const f = walk(path.join(root, sub), 0); if (f) return f; }
  return '';
}

/**
 * 这个文件不能读出来给模型：放令牌、模型 key 的文件（硬规矩 6，复审发现：路径来自命令输出，模型能让输出点名任何文件）。
 * 按真实路径看，符号链接、大小写绕不过去。判断不了的按不能读
 */
function secretFile(file) {
  try {
    let real = file;
    try { real = fs.realpathSync(file); } catch (e) { real = path.resolve(file); }
    const G = require('../hooks/guard-read');
    return G.protectedRange(real) || G.protectedRange(path.resolve(file));
  } catch (e) { return true; }
}
/** 文件里第 line 行前后 n 行，带行号，出错那一行标 > */
function snippet(file, line, n) {
  try {
    if (secretFile(file)) return '';
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return '';
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\u0000')) return '';
    const ls = text.replace(/\r\n/g, '\n').split('\n');
    if (line < 1 || line > ls.length) return '';
    const from = Math.max(1, line - n);
    const to = Math.min(ls.length, line + n);
    const w = String(to).length;
    const out = [];
    for (let k = from; k <= to; k++) out.push('  ' + String(k).padStart(w) + (k === line ? '>| ' : ' | ') + ls[k - 1].replace(/\t/g, '  ').slice(0, 200));
    return out.join('\n');
  } catch (e) { return ''; }
}

/**
 * 给 after-tool 用：失败的编译、测试命令的摘要。j 是 PostToolUseFailure 的输入（或者带非零退出码的 PostToolUse）。
 * 返回一段给模型看的话；不是编译、测试命令、抽不出错误的返回 ''
 */
function summarize(j) {
  const cmd = String((j && j.tool_input && j.tool_input.command) || '');
  const kind = kindOf(cmd);
  if (!kind || j.is_interrupt) return '';
  const r = j.tool_response || {};
  const output = String(j.error || '') + '\n' + String(r.stdout || '') + '\n' + String(r.stderr || '');
  if (output.trim().length < 3) return '';
  const e = firstError(output, kind);
  if (!e) return '';
  const cwd = path.resolve(j.cwd || process.cwd());
  let abs = '';
  if (e.cls) abs = findClass(cwd, e.cls);
  else if (e.file) { const p = cleanPath(e.file); abs = path.isAbsolute(p) ? p : path.resolve(cwd, p); }
  const shown = abs ? (path.relative(cwd, abs).startsWith('..') ? abs : path.relative(cwd, abs)).split(path.sep).join('/') : (e.cls || e.file);
  const code = abs ? snippet(abs, e.line, 5) : '';
  const msg = String(e.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const lines = ['[vibe-kit 失败摘要] ' + kind + ' 没过，第一个错误：' + shown + ':' + e.line + (e.col ? ':' + e.col : '') + '　' + msg];
  for (const d of e.detail || []) lines.push('  ' + d.slice(0, 200));
  if (code) lines.push(code);
  lines.push('先改这一处再重跑；后面的错误常常是它连带出来的。完整输出还在上面的命令结果里。');
  return lines.join('\n').slice(0, 2500);
}

module.exports = { kindOf, firstError, snippet, summarize, cleanPath };
