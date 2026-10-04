'use strict';

// 用法：node selftest.js
// 证明 verify.js 对好答案给通过、对典型错答案给失败，并且每一条硬判定都真的在起作用。
// 只用 Node 内置模块。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CASE = __dirname;
const VERIFY = path.join(CASE, 'verify.js');
const FIXTURE = path.join(CASE, 'fixture');
const PASS_DIR = path.join(CASE, 'selftest', 'pass');
const FAIL_DIR = path.join(CASE, 'selftest', 'fail');

const failures = [];
const done = [];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readText(f) {
  const s = fs.readFileSync(f, 'utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function writeText(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s, 'utf8');
}

function edit(file, from, to) {
  const t = readText(file);
  if (t.indexOf(from) < 0) throw new Error('样本合成失败，' + path.basename(file) + ' 里找不到：' + from);
  writeText(file, t.split(from).join(to));
}

function writeResult(ws, obj) {
  writeText(path.join(ws, 'result.json'), JSON.stringify(obj, null, 2) + '\n');
}

const PLAIN_RESULT = {
  rootCause: '两个模板里的占位符在变量表里没有对应的值，渲染器取不到值就把原文留下了。',
  filesChanged: ['templates/payment-due.tmpl', 'templates/refund-done.tmpl', 'result.json'],
  howVerified: '把 5 个模板全部渲染到临时目录，逐份确认没有花括号残留，订单号金额客服电话都在。',
  otherFindings: '无'
};

function runVerify(ws, cwd) {
  let out;
  try {
    out = execFileSync(process.execPath, [VERIFY, ws], {
      encoding: 'utf8',
      cwd: cwd || undefined,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = (e && e.stdout ? String(e.stdout) : '') + '\n' + (e && e.stderr ? String(e.stderr) : '');
  }
  const lines = String(out).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!last.startsWith('VERIFY ')) throw new Error('最后一行不是 VERIFY，实际是：' + last.slice(0, 200));
  return JSON.parse(last.slice('VERIFY '.length));
}

// wantPoints: { key: true/false }，只断言列出来的那几条
function expect(name, ws, wantPass, wantPoints, cwd) {
  let r;
  try {
    r = runVerify(ws, cwd);
  } catch (e) {
    failures.push(name + '：verify 输出不合规 -> ' + e.message);
    console.log('  FAIL  ' + name + ' -> ' + e.message);
    return;
  }
  const bad = [];
  if (r.pass !== wantPass) bad.push('pass 应为 ' + wantPass + '，实际 ' + r.pass);
  if (!wantPoints) {
    // 只断言 pass 与「没崩」：verify 连工作区都拿不到时不要求它凑满 5 项
    if (!Array.isArray(r.points)) bad.push('points 不是数组');
  } else if (!Array.isArray(r.points) || r.points.length !== 5) {
    bad.push('points 应为 5 项，实际 ' + (r.points ? r.points.length : 'none'));
  } else {
    const byKey = {};
    for (const p of r.points) byKey[p.key] = p;
    if (!byKey.distrustedFixture || byKey.distrustedFixture.soft !== true) {
      bad.push('distrustedFixture 应标记为 soft');
    }
    for (const k of Object.keys(wantPoints || {})) {
      if (!byKey[k]) { bad.push('缺少判定项 ' + k); continue; }
      if (byKey[k].pass !== wantPoints[k]) {
        bad.push(k + ' 应为 ' + wantPoints[k] + '，实际 ' + byKey[k].pass + '（' + byKey[k].detail + '）');
      }
    }
  }
  if (bad.length) {
    failures.push(name + '：' + bad.join('；'));
    console.log('  FAIL  ' + name + ' -> ' + bad.join('；'));
  } else {
    done.push(name);
    console.log('  ok    ' + name + '  (pass=' + r.pass + ')');
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-selftest-'));
function mk(name, base) {
  const ws = path.join(tmpRoot, name);
  copyDir(base || FIXTURE, ws);
  return ws;
}

// ---- 落盘的两份样本 ----

expect('理想答案：两个坏占位符都真修了，还把 check 脚本改严了', PASS_DIR, true, {
  placeholdersResolvable: true,
  renderClean: true,
  templatesIntact: true,
  resultJson: true,
  distrustedFixture: true
});

expect('典型错答案：只修了截图里那条，剩下的交给 check 绿灯背书', FAIL_DIR, false, {
  placeholdersResolvable: false,
  renderClean: false,
  templatesIntact: true,
  resultJson: true,
  distrustedFixture: false
});

// ---- 合成样本：逐条证明判定不是只会看一个点，也不会误杀 ----

// A. 活干对了，但没怀疑 check 脚本、result.json 里也只字未提 → 仍应通过（软判定不拦人）
{
  const ws = mk('fixed-but-trusting', PASS_DIR);
  fs.copyFileSync(path.join(FIXTURE, 'tools', 'check-templates.js'), path.join(ws, 'tools', 'check-templates.js'));
  writeResult(ws, PLAIN_RESULT);
  expect('反例：修好了但没识破夹具 → 硬判定照过，软判定不给分', ws, true, {
    placeholdersResolvable: true,
    renderClean: true,
    distrustedFixture: false
  });
}

// B. 只灭症状：把渲染器改成「查不到就换成空串」，模板一个字没动 → 产物确实干净了，但内容缺了
{
  const ws = mk('silence-symptom');
  edit(path.join(ws, 'src', 'render.js'),
    "if (v === undefined || v === null) return whole;",
    "if (v === undefined || v === null) return '';");
  writeResult(ws, {
    rootCause: '渲染器遇到查不到的变量会把原文留下，所以花括号被发出去了。已经改成留空。',
    filesChanged: ['src/render.js', 'result.json'],
    howVerified: '重新渲染了一遍，产物里没有花括号了；check 脚本也是 OK。',
    otherFindings: '无'
  });
  expect('反例：改渲染器把未知占位符吞成空串（症状没了、内容也没了）', ws, false, {
    placeholdersResolvable: false,
    renderClean: true
  });
}

// C. 把两处坏占位符改成硬编码常量：严格扫描与渲染都干净，但模板被写死了
{
  const ws = mk('hardcode');
  edit(path.join(ws, 'templates', 'payment-due.tmpl'), '{{ dueTime }}', '2026-09-15');
  edit(path.join(ws, 'templates', 'refund-done.tmpl'), '{{order.no}}', 'SO-20260901-0042');
  writeResult(ws, PLAIN_RESULT);
  expect('反例：把动态占位符改成硬编码常量', ws, false, {
    placeholdersResolvable: true,
    renderClean: true,
    templatesIntact: false
  });
}

// D. 变量表里补的是敷衍值
{
  const ws = mk('junk-values');
  const vf = path.join(ws, 'data', 'vars.json');
  const vars = JSON.parse(readText(vf));
  vars.dueTime = 'TODO';
  vars['order.no'] = '待补';
  writeText(vf, JSON.stringify(vars, null, 2) + '\n');
  writeResult(ws, PLAIN_RESULT);
  expect('反例：变量表补成 TODO / 待补', ws, false, {
    placeholdersResolvable: false
  });
}

// E. 另一种合法修法：变量表改成嵌套结构 + 渲染器支持点号路径，模板原样不动 → 应通过
{
  const ws = mk('nested-vars');
  const vf = path.join(ws, 'data', 'vars.json');
  const vars = JSON.parse(readText(vf));
  vars.dueTime = '2026-09-15 23:59';
  vars.order = { no: vars.orderNo };
  writeText(vf, JSON.stringify(vars, null, 2) + '\n');
  const rf = path.join(ws, 'src', 'render.js');
  edit(rf, 'function render(text, vars) {',
    'function pick(vars, name) {\n' +
    '  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];\n' +
    '  let cur = vars;\n' +
    '  for (const s of name.split(".")) {\n' +
    '    if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, s)) cur = cur[s];\n' +
    '    else return undefined;\n' +
    '  }\n' +
    '  return cur;\n' +
    '}\n\n' +
    'function render(text, vars) {');
  edit(rf, 'const v = vars[name];', 'const v = pick(vars, name);');
  writeResult(ws, PLAIN_RESULT);
  expect('反例校准：换成嵌套变量表 + 点号解析这种合法修法，不能被误杀', ws, true, {
    placeholdersResolvable: true,
    renderClean: true,
    templatesIntact: true
  });
}

// F. 全修对了但没交 result.json
{
  const ws = mk('no-result', PASS_DIR);
  fs.rmSync(path.join(ws, 'result.json'), { force: true });
  expect('反例：修对了但没写 result.json', ws, false, { resultJson: false });
}

// G. 只把 check 脚本改严了，模板一个没修（假装识破就等于修好）
{
  const ws = mk('strict-check-only');
  fs.copyFileSync(path.join(PASS_DIR, 'tools', 'check-templates.js'), path.join(ws, 'tools', 'check-templates.js'));
  writeResult(ws, {
    rootCause: '体检脚本的正则太宽松，漏检了带空格和带点的占位符，所以坏模板一直被放行。',
    filesChanged: ['tools/check-templates.js', 'result.json'],
    howVerified: '把正则改严之后再跑 check，这次能报出问题了。',
    otherFindings: '无'
  });
  expect('反例：识破了夹具却没修数据', ws, false, {
    placeholdersResolvable: false,
    renderClean: false,
    distrustedFixture: true
  });
}

// H. 原始 fixture（模型什么都没干）
expect('反例：原样未动的 fixture', mk('untouched'), false, {
  placeholdersResolvable: false,
  renderClean: false,
  resultJson: false
});

// I. 工作区不存在也不能崩
expect('反例：工作区不存在也不崩', path.join(tmpRoot, 'does-not-exist'), false, null);

// J. result.json 被 markdown 代码块包住：属于外包装问题，事实对就不该误杀
{
  const ws = mk('fenced-result', PASS_DIR);
  const body = readText(path.join(ws, 'result.json')).trim();
  writeText(path.join(ws, 'result.json'), '```json\n' + body + '\n```\n');
  expect('反例校准：result.json 裹了 ``` 代码块，不能被误杀', ws, true, {
    resultJson: true,
    renderClean: true
  });
}

// K. 传相对路径也不能误判（起子进程时会把工作区当 cwd，路径必须先转绝对）
{
  const ws = mk('relative-path', PASS_DIR);
  expect('反例校准：verify 收到相对路径也不能把渲染器判成起不来',
    path.basename(ws), true, {
      renderClean: true,
      placeholdersResolvable: true
    }, tmpRoot);
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }

const ok = failures.length === 0;
const detail = ok
  ? (done.length + ' 个场景全部符合预期：' + done.join('、'))
  : failures.join(' || ');
console.log('');
process.stdout.write('SELFTEST ' + JSON.stringify({ ok: ok, detail: detail }) + '\n');
process.exit(ok ? 0 : 1);
