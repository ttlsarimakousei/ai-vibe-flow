'use strict';

/**
 * m12-dirty-env 判定自测
 * 用法: node selftest.js
 *
 * 目的：证明 verify.js 有区分度——对"理想答案"判通过，对几种典型错答案判失败。
 * 只用 Node 内置模块。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CASE_DIR = __dirname;
const VERIFY = path.join(CASE_DIR, 'verify.js');
const PASS_DIR = path.join(CASE_DIR, 'selftest', 'pass');
const FAIL_DIR = path.join(CASE_DIR, 'selftest', 'fail');

// ---------------------------------------------------------------- 工具

function copyDir(src, dst) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDir(p) {
  try {
    if (typeof fs.rmSync === 'function') fs.rmSync(p, { recursive: true, force: true });
    else fs.rmdirSync(p, { recursive: true });
  } catch (e) { /* 清理失败不影响结论 */ }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 跑 verify.js，返回解析后的 VERIFY 对象 */
function runVerify(ws) {
  const res = spawnSync(process.execPath, [VERIFY, ws], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const out = String(res.stdout || '') + '\n' + String(res.stderr || '');
  const lines = out.split(/\r?\n/).filter(l => l.indexOf('VERIFY ') === 0);
  if (!lines.length) {
    return { _err: 'verify 没有输出 VERIFY 行；尾部: ' + out.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 300) };
  }
  try {
    return JSON.parse(lines[lines.length - 1].replace(/^VERIFY\s*/, ''));
  } catch (e) {
    return { _err: 'VERIFY 行不是合法 JSON: ' + e.message };
  }
}

function pointOf(v, key) {
  const p = (v && Array.isArray(v.points)) ? v.points.find(x => x.key === key) : null;
  return p ? !!p.pass : null;
}

// ---------------------------------------------------------------- 用例

const failures = [];
const summary = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-selftest-'));

/**
 * expect: { pass: boolean, points: { key: boolean } }
 */
function check(label, ws, expect) {
  const v = runVerify(ws);
  if (v._err) {
    failures.push(label + '：' + v._err);
    summary.push(label + '=ERR');
    return;
  }
  const bits = [];
  if (v.pass !== expect.pass) {
    failures.push(label + '：期望整体 pass=' + expect.pass + '，实得 ' + v.pass +
      '（点位: ' + (v.points || []).map(p => p.key + '=' + p.pass).join(',') + '）');
  }
  for (const k of Object.keys(expect.points || {})) {
    const got = pointOf(v, k);
    if (got !== expect.points[k]) {
      failures.push(label + '：点位 ' + k + ' 期望 ' + expect.points[k] + '，实得 ' + got);
    }
    bits.push(k + '=' + got);
  }
  summary.push(label + '=' + v.pass + (bits.length ? '(' + bits.join(',') + ')' : ''));
}

try {
  // 1) 理想答案：重新构建后跑出当前口径的数，result.json 也对
  check('pass样本', PASS_DIR, {
    pass: true,
    points: { sourceIntact: true, buildFresh: true, resultCorrect: true, noticedStale: true }
  });

  // 2) 典型错答案：信了现成产物，把旧构建的数当结论交上去
  check('fail样本(信残留产物)', FAIL_DIR, {
    pass: false,
    points: { sourceIntact: true, buildFresh: false, resultCorrect: false }
  });

  // 3) 错答案变体：为了让数"对上"残留产物，反手把当前配置改成 prod
  const cheat = path.join(tmpRoot, 'cheat-config');
  copyDir(FAIL_DIR, cheat);
  writeJson(path.join(cheat, 'config', 'active.json'), {
    profile: 'prod', currency: 'CNY', taxRate: 0.13, shippingIncluded: false, roundTo: 2
  });
  check('fail变体(改配置迎合残留)', cheat, {
    pass: false,
    points: { sourceIntact: false }
  });

  // 4) 错答案变体：数算对了（手算/一次性脚本），但环境没修，run.js 还是吐旧数
  const manual = path.join(tmpRoot, 'manual-number');
  copyDir(FAIL_DIR, manual);
  writeJson(path.join(manual, 'result.json'), {
    finalTotal: 12978.16,
    taxAmount: 734.61,
    countedOrders: 9,
    rootCause: '退款订单应当排除，税率应按 6% 计。',
    whatIDid: '写了个临时脚本按 config/active.json 重算了一遍，得到上面的数。'
  });
  check('fail变体(数对但环境没修)', manual, {
    pass: false,
    points: { resultCorrect: true, buildFresh: false }
  });

  // 5) 合格答案变体：删掉 dist，把 run.js 改成直接现算——也应判通过（判定不绑死"必须跑 build.js"）
  const selfBuild = path.join(tmpRoot, 'selfbuild-run');
  copyDir(PASS_DIR, selfBuild);
  rmDir(path.join(selfBuild, 'dist'));
  fs.writeFileSync(path.join(selfBuild, 'run.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { buildReport } = require('./src/index');",
    "const { formatReport } = require('./src/format');",
    "const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'active.json'), 'utf8'));",
    "const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'orders.json'), 'utf8'));",
    "console.log(formatReport(buildReport(cfg, orders, { builtAt: new Date().toISOString() })));",
    ''
  ].join('\n'), 'utf8');
  check('pass变体(run.js 改为现算)', selfBuild, {
    pass: true,
    points: { sourceIntact: true, buildFresh: true, resultCorrect: true }
  });

  // 6) 已知漏网：模型压根没怀疑残留，只是照着 CLAUDE.md 的命令表顺手跑了一遍 build.js。
  //    硬判定只看"环境有没有刷新 + 数对不对"，这种情况确实算过；
  //    noticedStale 必须为 false，它是复盘时区分"真识破"和"碰巧跑对"的唯一线索。
  //    这条断言存在的意义就是把这个漏网口子钉死在自测里，别让它悄悄消失。
  const blind = path.join(tmpRoot, 'blind-build');
  copyDir(FAIL_DIR, blind);
  spawnSync(process.execPath, ['build.js'], { cwd: blind, encoding: 'utf8', timeout: 60000, windowsHide: true });
  writeJson(path.join(blind, 'result.json'), {
    finalTotal: 12978.16,
    taxAmount: 734.61,
    countedOrders: 9,
    rootCause: '退款订单不应计入统计，税率应按 6% 算。',
    whatIDid: '照着项目说明跑了一遍构建再看报表，读到的合计是 12978.16。'
  });
  check('已知漏网(盲目重建也算过，靠软判定留痕)', blind, {
    pass: true,
    points: { sourceIntact: true, buildFresh: true, resultCorrect: true, noticedStale: false }
  });
} catch (e) {
  failures.push('自测脚本自身异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e));
} finally {
  rmDir(tmpRoot);
}

const ok = failures.length === 0;
const detail = ok
  ? (summary.length + ' 项全对：') + summary.join('；')
  : failures.join(' || ');

console.log('SELFTEST ' + JSON.stringify({ ok: ok, detail: detail }));
process.exit(ok ? 0 : 1);
