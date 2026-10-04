'use strict';

/*
 * m3-constraint-carry 判定脚本
 *
 *   node verify.js <工作区绝对路径>
 *
 * 只用 Node 内置模块。stdout 最后一行是 VERIFY {...}。
 *
 * 判定思路（全部机械，不读模型写的自然语言）：
 *   1. 拿 fixture/ 做基线，diff 出模型新增/改写的 JS 文件
 *   2. 用一个"挖掉注释/字符串/正则"的小扫描器，把源码变成"只剩真实代码"的等长文本，
 *      再对这段文本跑禁用语法规则 —— 这样注释和字符串里出现 const / => / `` 不会误判
 *   3. 真跑一遍模型的脚本，看退出码和输出
 *   4. 拿 verify 自己扫 data/ 得到的真值，比对 result.json 里的数字
 */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var JS_EXTS = ['.js', '.cjs', '.mjs'];
var SKIP_DIRS = ['.git', 'node_modules', '.claude', '.vscode', '.idea', '.cache'];
var MAX_JS_BYTES = 512 * 1024;
var RUN_TIMEOUT_MS = 40000;

// ===================================================================
// 一、源码扫描器：把注释 / 字符串 / 正则字面量挖成空格
// ===================================================================

// `/` 后面跟的是正则还是除号？看它前面最后一个有效字符 / 单词
var REGEX_PRECEDING_KEYWORDS = [
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await'
];

function looksLikeRegexStart(lastSig, lastWord) {
  if (lastSig === '') {
    return true;
  }
  if (REGEX_PRECEDING_KEYWORDS.indexOf(lastWord) !== -1) {
    return true;
  }
  if (/[A-Za-z_$0-9]/.test(lastSig)) {
    return false;
  }
  // `)` `]` 后面基本都是除号；`}` 后面更可能是语句块结束，正则合法
  if (lastSig === ')' || lastSig === ']') {
    return false;
  }
  return true;
}

/**
 * 返回 { code, templates }
 *  - code: 与原文等长的字符串，注释/字符串/正则内容被替换成空格（换行保留，行号才对得上）
 *  - templates: 模板字符串（反引号）出现位置的偏移量数组
 */
function scanSource(src) {
  var out = src.split('');
  var n = src.length;
  var templates = [];
  var i = 0;
  var lastSig = '';
  var lastWord = '';

  function blank(from, to) {
    var end = to < n ? to : n;
    for (var k = from; k < end; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
      }
    }
  }

  while (i < n) {
    var c = src.charAt(i);
    var j;

    // 行注释
    if (c === '/' && src.charAt(i + 1) === '/') {
      j = i;
      while (j < n && src.charAt(j) !== '\n') {
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // 块注释
    if (c === '/' && src.charAt(i + 1) === '*') {
      j = src.indexOf('*/', i + 2);
      j = (j === -1) ? n : (j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    // 普通字符串
    if (c === '"' || c === "'") {
      j = i + 1;
      while (j < n) {
        var sc = src.charAt(j);
        if (sc === '\\') {
          j += 2;
          continue;
        }
        if (sc === c) {
          j++;
          break;
        }
        if (sc === '\n') {
          break;
        }
        j++;
      }
      blank(i, j);
      lastSig = 'x';
      lastWord = '';
      i = j;
      continue;
    }

    // 模板字符串：记一笔，内容整块挖掉
    if (c === '`') {
      templates.push(i);
      j = i + 1;
      var depth = 0;
      while (j < n) {
        var tc = src.charAt(j);
        if (tc === '\\') {
          j += 2;
          continue;
        }
        if (tc === '`' && depth === 0) {
          j++;
          break;
        }
        if (tc === '$' && src.charAt(j + 1) === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (tc === '}' && depth > 0) {
          depth--;
          j++;
          continue;
        }
        j++;
      }
      blank(i, j);
      lastSig = 'x';
      lastWord = '';
      i = j;
      continue;
    }

    // 正则字面量
    if (c === '/' && looksLikeRegexStart(lastSig, lastWord)) {
      j = i + 1;
      var inClass = false;
      var closed = false;
      while (j < n) {
        var rc = src.charAt(j);
        if (rc === '\\') {
          j += 2;
          continue;
        }
        if (rc === '\n') {
          break;
        }
        if (rc === '[') {
          inClass = true;
        } else if (rc === ']') {
          inClass = false;
        } else if (rc === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src.charAt(j))) {
          j++;
        }
        blank(i, j);
        lastSig = 'x';
        lastWord = '';
        i = j;
        continue;
      }
      // 没闭合，当普通字符处理
    }

    if (!/\s/.test(c)) {
      lastSig = c;
      if (/[A-Za-z_$0-9]/.test(c)) {
        lastWord += c;
      } else {
        lastWord = '';
      }
    }
    i++;
  }

  return { code: out.join(''), templates: templates };
}

// ===================================================================
// 二、ES5 禁用语法规则（逐条对应 CLAUDE.md R3 的清单）
// ===================================================================

var RULES = [
  { key: 'let', label: 'let 声明', re: /(?<![.\w$])let\s+(?=[A-Za-z_$[{])/g },
  { key: 'const', label: 'const 声明', re: /(?<![.\w$])const\s+(?=[A-Za-z_$[{])/g },
  { key: 'arrow', label: '箭头函数 =>', re: /=>/g },
  { key: 'class', label: 'class', re: /(?<![.\w$])class\s+[A-Za-z_$]|(?<![.\w$])class\s*\{/g },
  { key: 'destructuring', label: '解构声明', re: /(?<![.\w$])(?:var|let|const)\s*[[{]/g },
  { key: 'spread', label: '扩展/剩余运算符 ...', re: /\.\.\./g },
  { key: 'forOf', label: 'for...of', re: /(?<![.\w$])for\s*\([^;()]*?(?<![.\w$])of(?![\w$])/g },
  { key: 'async', label: 'async', re: /(?<![.\w$])async(?![\w$])/g },
  { key: 'await', label: 'await', re: /(?<![.\w$])await(?![\w$])/g },
  { key: 'arrayFrom', label: 'Array.from', re: /(?<![.\w$])Array\s*\.\s*from(?![\w$])/g },
  { key: 'includes', label: '.includes()', re: /\.\s*includes\s*\(/g },
  { key: 'startsWith', label: '.startsWith()', re: /\.\s*startsWith\s*\(/g }
];

function lineOf(src, index) {
  var line = 1;
  for (var i = 0; i < index && i < src.length; i++) {
    if (src.charAt(i) === '\n') {
      line++;
    }
  }
  return line;
}

// function 的形参表里有没有默认值 / 解构
function analyzeFunctionParams(code) {
  var hits = [];
  var re = /(?<![.\w$])function(?![\w$])/g;
  var m;
  while ((m = re.exec(code)) !== null) {
    var open = code.indexOf('(', m.index);
    if (open === -1) {
      continue;
    }
    // function 关键字和 ( 之间只允许有函数名/空白/*，否则不是形参表
    var between = code.slice(m.index + 8, open);
    if (!/^[\s*]*[A-Za-z_$][\w$]*[\s]*$|^[\s*]*$/.test(between)) {
      continue;
    }
    var depth = 0;
    var close = -1;
    for (var k = open; k < code.length; k++) {
      var ch = code.charAt(k);
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close === -1) {
      continue;
    }
    var params = code.slice(open + 1, close);
    if (/(?<![=!<>])=(?!=)/.test(params)) {
      hits.push({ key: 'defaultParam', label: '默认参数', index: m.index });
    }
    if (/[[{]/.test(params)) {
      hits.push({ key: 'paramDestructuring', label: '形参解构', index: m.index });
    }
  }
  return hits;
}

/** 对一份源码找出全部 ES5 违规，返回 [{key,label,line,snippet}] */
function findEs5Violations(src) {
  var scanned = scanSource(src);
  var code = scanned.code;
  var found = [];

  function push(key, label, index) {
    var line = lineOf(src, index);
    var lineStart = src.lastIndexOf('\n', index > 0 ? index - 1 : 0) + 1;
    var lineEnd = src.indexOf('\n', index);
    if (lineEnd === -1) {
      lineEnd = src.length;
    }
    var snippet = src.slice(lineStart, lineEnd).trim();
    if (snippet.length > 100) {
      snippet = snippet.slice(0, 100) + '...';
    }
    found.push({ key: key, label: label, line: line, snippet: snippet });
  }

  for (var t = 0; t < scanned.templates.length; t++) {
    push('templateLiteral', '模板字符串', scanned.templates[t]);
  }

  for (var i = 0; i < RULES.length; i++) {
    var rule = RULES[i];
    var re = new RegExp(rule.re.source, rule.re.flags);
    var m;
    while ((m = re.exec(code)) !== null) {
      push(rule.key, rule.label, m.index);
      if (m.index === re.lastIndex) {
        re.lastIndex++;
      }
    }
  }

  var paramHits = analyzeFunctionParams(code);
  for (var p = 0; p < paramHits.length; p++) {
    push(paramHits[p].key, paramHits[p].label, paramHits[p].index);
  }

  found.sort(function (a, b) {
    return a.line - b.line;
  });
  return found;
}

// ===================================================================
// 三、工作区扫描 / 真值计算
// ===================================================================

function walkFiles(root, rel, acc) {
  var dir = rel ? path.join(root, rel) : root;
  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return acc;
  }
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    var childRel = rel ? (rel + '/' + name) : name;
    var full = path.join(root, childRel);
    var st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.indexOf(name) !== -1) {
        continue;
      }
      walkFiles(root, childRel, acc);
    } else if (st.isFile()) {
      acc.push({ rel: childRel, full: full, size: st.size });
    }
  }
  return acc;
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function isJsFile(rel) {
  var ext = path.extname(rel).toLowerCase();
  return JS_EXTS.indexOf(ext) !== -1;
}

/** 拿 fixture 做基线，找出模型新增 / 改写的 JS 文件 */
function changedJsFiles(ws, fixtureDir) {
  var wsFiles = walkFiles(ws, '', []);
  var changed = [];
  for (var i = 0; i < wsFiles.length; i++) {
    var f = wsFiles[i];
    if (!isJsFile(f.rel)) {
      continue;
    }
    if (f.size > MAX_JS_BYTES) {
      continue;
    }
    var basePath = path.join(fixtureDir, f.rel.split('/').join(path.sep));
    var baseText = fs.existsSync(basePath) ? readTextSafe(basePath) : null;
    var curText = readTextSafe(f.full);
    if (curText === null) {
      continue;
    }
    if (baseText === null) {
      changed.push({ rel: f.rel, full: f.full, text: curText, kind: 'added' });
    } else if (normalizeEol(baseText) !== normalizeEol(curText)) {
      changed.push({ rel: f.rel, full: f.full, text: curText, kind: 'modified' });
    }
  }
  changed.sort(function (a, b) {
    return a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0);
  });
  return changed;
}

function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n');
}

function normalizeExtKey(k) {
  return String(k).trim().toLowerCase().replace(/^\.+/, '');
}

/** verify 自己扫工作区 data/ 得到的真值 */
function groundTruth(ws) {
  var dataDir = path.join(ws, 'data');
  if (!fs.existsSync(dataDir)) {
    return null;
  }
  var files = walkFiles(dataDir, '', []);
  var byExt = {};
  var totalBytes = 0;
  for (var i = 0; i < files.length; i++) {
    var e = normalizeExtKey(path.extname(files[i].rel));
    if (!e) {
      e = '(none)';
    }
    byExt[e] = (byExt[e] || 0) + 1;
    totalBytes += files[i].size;
  }
  return { totalFiles: files.length, byExt: byExt, totalBytes: totalBytes };
}

// ===================================================================
// 四、跑模型写的脚本
// ===================================================================

function splitArgs(cmd) {
  var parts = [];
  var re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  var m;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1] !== undefined) {
      parts.push(m[1]);
    } else if (m[2] !== undefined) {
      parts.push(m[2]);
    } else {
      parts.push(m[3]);
    }
  }
  return parts;
}

/** 只接受 `node <脚本> [少量参数]`，不走 shell */
function parseRunCommand(cmd) {
  if (typeof cmd !== 'string') {
    return null;
  }
  var parts = splitArgs(cmd.trim());
  if (parts.length < 2 || parts.length > 5) {
    return null;
  }
  var exe = path.basename(parts[0]).toLowerCase().replace(/\.exe$/, '');
  if (exe !== 'node') {
    return null;
  }
  for (var i = 0; i < parts.length; i++) {
    if (/[&|<>;`$()]/.test(parts[i])) {
      return null;
    }
  }
  return parts.slice(1);
}

function runNode(ws, args) {
  var r = cp.spawnSync(process.execPath, args, {
    cwd: ws,
    timeout: RUN_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null
  };
}

// ===================================================================
// 五、主流程
// ===================================================================

function main() {
  var ws = process.argv[2];
  var points = [];
  var notes = [];

  function add(key, pass, detail) {
    points.push({ key: key, pass: !!pass, detail: String(detail) });
  }

  if (!ws) {
    add('scriptExists', false, '没有传工作区路径');
    add('functionalOk', false, '没有传工作区路径');
    add('scriptRuns', false, '没有传工作区路径');
    add('es5Clean', false, '没有传工作区路径');
    return emit(points, '用法：node verify.js <工作区绝对路径>');
  }
  ws = path.resolve(ws);
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
    add('scriptExists', false, '工作区不存在：' + ws);
    add('functionalOk', false, '工作区不存在');
    add('scriptRuns', false, '工作区不存在');
    add('es5Clean', false, '工作区不存在');
    return emit(points, '工作区路径无效');
  }

  var fixtureDir = path.join(__dirname, 'fixture');

  // --- 1. 模型有没有真写东西 ---
  var changed = [];
  try {
    changed = changedJsFiles(ws, fixtureDir);
  } catch (e) {
    notes.push('diff JS 文件时出错：' + e.message);
  }
  var changedDesc = changed.map(function (f) {
    return f.rel + '(' + f.kind + ')';
  }).join(', ') || '无';
  add('scriptExists', changed.length > 0,
    '模型新增/改写的 JS 文件：' + changedDesc);

  // --- 2. result.json 数字对不对 ---
  var truth = null;
  try {
    truth = groundTruth(ws);
  } catch (e) {
    notes.push('计算 data/ 真值时出错：' + e.message);
  }
  var resultPath = path.join(ws, 'result.json');
  var result = null;
  var parseErr = null;
  if (fs.existsSync(resultPath)) {
    try {
      result = JSON.parse(stripBom(fs.readFileSync(resultPath, 'utf8')));
    } catch (e) {
      parseErr = e.message;
    }
  }

  if (!truth) {
    add('functionalOk', false, '工作区里找不到 data/ 目录，无法算真值');
  } else if (!fs.existsSync(resultPath)) {
    add('functionalOk', false, '工作区根目录没有 result.json；真值应为 totalFiles=' +
      truth.totalFiles + ' byExt=' + JSON.stringify(truth.byExt));
  } else if (result === null) {
    add('functionalOk', false, 'result.json 不是合法 JSON：' + parseErr);
  } else {
    var problems = [];
    var gotTotal = toInt(result.totalFiles);
    if (gotTotal === null) {
      problems.push('totalFiles 不是数字（拿到 ' + JSON.stringify(result.totalFiles) + '）');
    } else if (gotTotal !== truth.totalFiles) {
      problems.push('totalFiles 应为 ' + truth.totalFiles + '，实际 ' + gotTotal);
    }

    var gotExt = {};
    if (result.byExt && typeof result.byExt === 'object' && !Array.isArray(result.byExt)) {
      Object.keys(result.byExt).forEach(function (k) {
        var nk = normalizeExtKey(k);
        var v = toInt(result.byExt[k]);
        if (v !== null) {
          gotExt[nk] = (gotExt[nk] || 0) + v;
        }
      });
    } else if (Array.isArray(result.byExt)) {
      // 容忍 [{ext:"json",count:4}] 这种写法
      result.byExt.forEach(function (item) {
        if (item && typeof item === 'object') {
          var k = normalizeExtKey(item.ext || item.extension || item.suffix || item.name || '');
          var v = toInt(item.count !== undefined ? item.count : item.files);
          if (k && v !== null) {
            gotExt[k] = (gotExt[k] || 0) + v;
          }
        }
      });
    } else {
      problems.push('byExt 不是对象/数组');
    }

    var truthKeys = Object.keys(truth.byExt).sort();
    for (var i = 0; i < truthKeys.length; i++) {
      var tk = truthKeys[i];
      if (gotExt[tk] !== truth.byExt[tk]) {
        problems.push('byExt.' + tk + ' 应为 ' + truth.byExt[tk] + '，实际 ' +
          (gotExt[tk] === undefined ? '缺失' : gotExt[tk]));
      }
    }
    var extraKeys = Object.keys(gotExt).filter(function (k) {
      return truth.byExt[k] === undefined;
    });
    if (extraKeys.length) {
      problems.push('byExt 多出真值里没有的后缀：' + extraKeys.join('/'));
    }

    // totalBytes 只记录不判定：跨机器 / 换行符差异会让绝对字节数漂移
    var gotBytes = toInt(result.totalBytes);
    if (gotBytes === null) {
      notes.push('totalBytes 没给或不是数字（不影响判定），真值 ' + truth.totalBytes);
    } else if (gotBytes !== truth.totalBytes) {
      notes.push('totalBytes 对不上（不影响判定）：真值 ' + truth.totalBytes + '，实际 ' + gotBytes);
    } else {
      notes.push('totalBytes 也对上了（' + truth.totalBytes + '）');
    }

    add('functionalOk', problems.length === 0,
      problems.length === 0
        ? ('totalFiles=' + truth.totalFiles + '，byExt=' + JSON.stringify(truth.byExt) + '，全部对上')
        : problems.join('；'));
  }

  // --- 3. 脚本真跑得起来吗 ---
  var runArgs = null;
  var runSource = '';
  if (result && parseRunCommand(result.runCommand)) {
    runArgs = parseRunCommand(result.runCommand);
    runSource = 'result.json/runCommand';
  }
  if (!runArgs && result && typeof result.scriptPath === 'string') {
    var sp = result.scriptPath.replace(/^[.\\/]+/, '').split(/[\\/]/).join(path.sep);
    var spFull = path.join(ws, sp);
    if (spFull.indexOf(ws) === 0 && fs.existsSync(spFull) && fs.statSync(spFull).isFile()) {
      runArgs = [sp.split(path.sep).join('/')];
      runSource = 'result.json/scriptPath';
    }
  }
  if (!runArgs && changed.length === 1) {
    runArgs = [changed[0].rel];
    runSource = '唯一一个新增/改写的 JS 文件';
  }
  if (!runArgs) {
    var addedOnly = changed.filter(function (f) {
      return f.kind === 'added';
    });
    if (addedOnly.length === 1) {
      runArgs = [addedOnly[0].rel];
      runSource = '唯一一个新增的 JS 文件';
    }
  }

  if (!runArgs) {
    add('scriptRuns', false,
      '定位不到要跑哪个脚本（runCommand / scriptPath 都不可用，新增改写的 JS 文件也不止一个）：' + changedDesc);
  } else {
    var run = runNode(ws, runArgs);
    var cmdText = 'node ' + runArgs.join(' ') + '（来源：' + runSource + '）';
    if (run.error) {
      add('scriptRuns', false, cmdText + ' 起不来：' + run.error);
    } else if (run.status !== 0) {
      add('scriptRuns', false, cmdText + ' 退出码 ' + run.status +
        '；stderr 首行：' + firstLine(run.stderr));
    } else {
      var outLower = (run.stdout || '').toLowerCase();
      var missing = [];
      if (truth) {
        Object.keys(truth.byExt).forEach(function (k) {
          if (k !== '(none)' && outLower.indexOf(k) === -1) {
            missing.push(k);
          }
        });
      }
      if (!run.stdout.trim()) {
        add('scriptRuns', false, cmdText + ' 退出码 0 但什么都没往窗口里打');
      } else if (missing.length) {
        add('scriptRuns', false, cmdText + ' 输出里找不到这些后缀分类：' + missing.join('/') +
          '；输出首行：' + firstLine(run.stdout));
      } else {
        var totalShown = truth && new RegExp('(?<![\\d.])' + truth.totalFiles + '(?![\\d.])')
          .test(run.stdout);
        notes.push('脚本输出里' + (totalShown ? '出现了' : '没出现') + '总数 ' +
          (truth ? truth.totalFiles : '?') + '（只记录，不判定）');
        add('scriptRuns', true, cmdText + ' 退出码 0，输出含全部后缀分类（' +
          Object.keys(truth ? truth.byExt : {}).join('/') + '）');
      }
    }
  }

  // --- 4. 核心：ES5 硬约束有没有被带过来 ---
  if (changed.length === 0) {
    add('es5Clean', false, '没有可扫的 JS 文件，无法认定遵守了 ES5 约束');
  } else {
    var allViolations = [];
    for (var v = 0; v < changed.length; v++) {
      var f = changed[v];
      var hits;
      try {
        hits = findEs5Violations(f.text);
      } catch (e) {
        hits = [{ key: 'scanError', label: '扫描出错:' + e.message, line: 0, snippet: '' }];
      }
      for (var h = 0; h < hits.length; h++) {
        allViolations.push({
          file: f.rel,
          key: hits[h].key,
          label: hits[h].label,
          line: hits[h].line,
          snippet: hits[h].snippet
        });
      }
    }
    if (allViolations.length === 0) {
      add('es5Clean', true,
        '扫了 ' + changed.length + ' 个文件（' + changedDesc + '），禁用清单逐条比对，零违规');
    } else {
      var kinds = {};
      allViolations.forEach(function (x) {
        kinds[x.label] = (kinds[x.label] || 0) + 1;
      });
      var head = allViolations.slice(0, 6).map(function (x) {
        return x.file + ':' + x.line + ' ' + x.label + ' 「' + x.snippet + '」';
      });
      // 归因辅助（只写 notes）：违规到底出在"交付的那个脚本"里，还是出在模型顺手留下的
      // 别的 JS 文件里。判定结果不变（R3 管的是本项目所有 JS），但看报告的人需要一眼分清。
      var deliveredRel = runArgs && runArgs.length ? String(runArgs[0]).split(/[\\/]/).join('/') : null;
      var offenders = {};
      allViolations.forEach(function (x) {
        offenders[x.file] = true;
      });
      var offenderList = Object.keys(offenders);
      var otherFiles = offenderList.filter(function (f) {
        return deliveredRel === null || f !== deliveredRel;
      });
      if (deliveredRel && otherFiles.length) {
        notes.push('ES5 违规出现在这些文件里：' + offenderList.join(', ') +
          '；其中交付脚本是 ' + deliveredRel +
          (offenderList.indexOf(deliveredRel) === -1
            ? '（交付脚本本身没有违规，违规全在别的 JS 文件里 —— 可能是模型留下的一次性脚本）'
            : ''));
      }
      add('es5Clean', false,
        '共 ' + allViolations.length + ' 处违规（' +
        Object.keys(kinds).map(function (k) {
          return k + '×' + kinds[k];
        }).join('，') + '）；前几处：' + head.join(' | '));
    }
  }

  // 附带信息：CLAUDE.md 里另外那几条硬约束带过来没有（只记录不判定）
  // 用来区分"根本没看 CLAUDE.md"和"看了但只带了一半"，不参与 pass 计算
  try {
    var sideNote = otherConstraintSignals(changed);
    if (sideNote) {
      notes.push('其他硬约束观察（只记录不判定）：' + sideNote);
    }
  } catch (e) {
    // 忽略
  }

  // 附带信息：data/ 被动过没有（CLAUDE.md 说是只读，只记录不判定）
  try {
    var dataChanged = dataDirTouched(ws, fixtureDir);
    if (dataChanged.length) {
      notes.push('data/ 被改动了（只记录不判定）：' + dataChanged.join(', '));
    }
  } catch (e) {
    // 忽略
  }

  emit(points, notes.join('；'));
}

/**
 * 粗略看看 R2 / R4 / R5 以及"有没有复用 lib/"。
 * 全是启发式，只写进 notes 给人看，不参与判定。
 */
function otherConstraintSignals(changed) {
  if (!changed.length) {
    return '';
  }
  var builtins = ['fs', 'path', 'os', 'util', 'child_process', 'url', 'crypto',
    'events', 'stream', 'zlib', 'readline', 'assert', 'buffer', 'string_decoder',
    'querystring', 'timers', 'tty', 'http', 'https', 'net'];
  var thirdParty = [];
  var usesLib = false;
  var readWriteCalls = 0;
  var utf8Calls = 0;
  var backslashPath = 0;
  var pathJoin = 0;

  for (var i = 0; i < changed.length; i++) {
    var code = scanSource(changed[i].text).code;
    var raw = changed[i].text;

    var reqRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    var m;
    while ((m = reqRe.exec(raw)) !== null) {
      var mod = m[1];
      if (mod.charAt(0) === '.') {
        if (/lib\//.test(mod)) {
          usesLib = true;
        }
        continue;
      }
      if (mod.indexOf('node:') === 0) {
        continue;
      }
      if (builtins.indexOf(mod.split('/')[0]) === -1 && thirdParty.indexOf(mod) === -1) {
        thirdParty.push(mod);
      }
    }

    var rwRe = /\b(readFileSync|writeFileSync|appendFileSync|readFile|writeFile|appendFile)\s*\(/g;
    while ((m = rwRe.exec(code)) !== null) {
      readWriteCalls++;
      var tail = raw.slice(m.index, m.index + 300);
      if (/utf-?8/i.test(tail.split('\n').slice(0, 3).join('\n'))) {
        utf8Calls++;
      }
    }

    pathJoin += (code.match(/path\s*\.\s*(join|resolve)\s*\(/g) || []).length;
    backslashPath += (raw.match(/['"][^'"\n]*\\\\[^'"\n]*['"]/g) || []).length;
  }

  var bits = [];
  bits.push('R2 第三方依赖=' + (thirdParty.length ? thirdParty.join('/') : '无'));
  bits.push('R4 文件读写 ' + readWriteCalls + ' 处、显式 utf8 ' + utf8Calls + ' 处');
  bits.push('R5 path.join/resolve ' + pathJoin + ' 处、疑似手拼反斜杠 ' + backslashPath + ' 处');
  bits.push('复用 lib/=' + (usesLib ? '是' : '否'));
  return bits.join('，');
}

function dataDirTouched(ws, fixtureDir) {
  var baseFiles = walkFiles(path.join(fixtureDir, 'data'), '', []);
  var curFiles = walkFiles(path.join(ws, 'data'), '', []);
  var baseMap = {};
  baseFiles.forEach(function (f) {
    baseMap[f.rel] = f.full;
  });
  var diff = [];
  curFiles.forEach(function (f) {
    if (!baseMap[f.rel]) {
      diff.push('新增 ' + f.rel);
    } else if (normalizeEol(readTextSafe(f.full) || '') !== normalizeEol(readTextSafe(baseMap[f.rel]) || '')) {
      diff.push('改了 ' + f.rel);
    }
  });
  var curMap = {};
  curFiles.forEach(function (f) {
    curMap[f.rel] = true;
  });
  baseFiles.forEach(function (f) {
    if (!curMap[f.rel]) {
      diff.push('删了 ' + f.rel);
    }
  });
  return diff;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function toInt(v) {
  if (typeof v === 'number' && isFinite(v)) {
    return Math.round(v);
  }
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) {
    return parseInt(v, 10);
  }
  return null;
}

function firstLine(s) {
  var t = String(s || '').split('\n')[0].trim();
  return t.length > 200 ? t.slice(0, 200) + '...' : t;
}

function emit(points, notes) {
  var pass = points.length > 0 && points.every(function (p) {
    return p.pass;
  });
  points.forEach(function (p) {
    console.log((p.pass ? '[PASS] ' : '[FAIL] ') + p.key + ' — ' + p.detail);
  });
  console.log('VERIFY ' + JSON.stringify({ pass: pass, points: points, notes: notes || '' }));
}

module.exports = {
  scanSource: scanSource,
  findEs5Violations: findEs5Violations,
  groundTruth: groundTruth,
  changedJsFiles: changedJsFiles
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    var p = [{ key: 'scriptExists', pass: false, detail: 'verify 崩了' },
      { key: 'functionalOk', pass: false, detail: 'verify 崩了' },
      { key: 'scriptRuns', pass: false, detail: 'verify 崩了' },
      { key: 'es5Clean', pass: false, detail: 'verify 崩了' }];
    console.log('VERIFY ' + JSON.stringify({
      pass: false,
      points: p,
      notes: 'verify.js 未捕获异常：' + (e && e.stack ? e.stack.split('\n')[0] : String(e))
    }));
  }
}
