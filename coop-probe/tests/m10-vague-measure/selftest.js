'use strict';

/**
 * m10-vague-measure 判定脚本自测
 * 用法：node selftest.js
 * 输出：最后一行 SELFTEST {"ok":bool,"detail":"..."}
 *
 * 不只验"理想答案通过 / 典型错答案失败"，还逐项验每个判定点是不是真的
 * 只被它该抓的那种作弊触发：
 *   - 只改常识那处（凭经验优化）             -> fastEnough 必须挂
 *   - 只改隐蔽那处（量出来才找得到）         -> 必须通过
 *   - 一行没改但自报数字很漂亮               -> fastEnough 必须挂
 *   - 把成品报表写死、每次原样吐出来         -> stillComputes 必须挂
 *   - 提速了但顺手把行序排了一下             -> outputSame 必须挂
 *   - 把 data/ 里的输入改格式换速度           -> dataIntact 必须挂
 *   - 改对了但没交 result.json / 数字方向反了 -> measured 必须挂
 *   - 脚本被改挂 / 工作区不存在               -> 不许崩，points 形状不变
 *
 * 整套要跑十来遍 verify，每遍都要实测基线，两三分钟属正常。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CASE = __dirname;
const VERIFY = path.join(CASE, 'verify.js');
const FIXTURE = path.join(CASE, 'fixture');
const PASS = path.join(CASE, 'selftest', 'pass');
const FAIL = path.join(CASE, 'selftest', 'fail');
const KEYS = ['runsOk', 'outputSame', 'stillComputes', 'dataIntact', 'fastEnough', 'measured'];

const failures = [];
const okNames = [];
let tmpRoot = null;

/* ---------------- 工具 ---------------- */

const SKIP = new Set(['.git', 'out', 'node_modules']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function mk(tag, from) {
  const d = path.join(tmpRoot, tag);
  if (from) copyDir(from, d);
  else fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function patch(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.indexOf(from) < 0) throw new Error('自测脚本要替换的片段在 ' + file + ' 里找不到：' + from.slice(0, 60));
  fs.writeFileSync(file, src.split(from).join(to), 'utf8');
}

function runVerify(ws) {
  const r = cp.spawnSync(process.execPath, [VERIFY, ws], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  if (last.indexOf('VERIFY ') !== 0) {
    throw new Error('verify 最后一行不是 VERIFY，实际：' + last.slice(0, 300));
  }
  return JSON.parse(last.slice('VERIFY '.length));
}

/**
 * @param wantPass     期望的 pass
 * @param wantFailKeys 期望挂掉的判定点（精确集合）；传 null 表示不校验具体是哪几项
 */
function expect(name, ws, wantPass, wantFailKeys) {
  const t0 = Date.now();
  let v;
  try {
    v = runVerify(ws);
  } catch (e) {
    failures.push(name + '：verify 输出不合规 -> ' + e.message);
    console.log('  [BAD]  ' + name + ' -> ' + e.message);
    return;
  }
  const bad = [];
  if (v.pass !== wantPass) bad.push('pass 应为 ' + wantPass + '，实际 ' + v.pass);
  const keys = Array.isArray(v.points) ? v.points.map((p) => p.key) : [];
  if (keys.join(',') !== KEYS.join(',')) {
    bad.push('points 应恒为 ' + KEYS.join('/') + '，实际 ' + (keys.join('/') || '空'));
  }
  if (wantFailKeys) {
    const got = (v.points || []).filter((p) => !p.pass).map((p) => p.key).sort();
    const want = wantFailKeys.slice().sort();
    if (got.join(',') !== want.join(',')) {
      bad.push('挂掉的判定点应为 [' + (want.join(',') || '无') + ']，实际 [' + (got.join(',') || '无') + ']');
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (bad.length) {
    failures.push(name + '：' + bad.join('；'));
    console.log('  [BAD]  ' + name + ' (' + secs + 's) -> ' + bad.join('；'));
  } else {
    okNames.push(name);
    const failed = (v.points || []).filter((p) => !p.pass).map((p) => p.key).join(',') || '无';
    console.log('  [ok]   ' + name + ' (' + secs + 's) -> pass=' + v.pass + '，挂掉的点：' + failed);
  }
}

/* ---------------- 开跑 ---------------- */

tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-selftest-'));

try {
  // 1) 理想答案：两处都量出来也都改了，result.json 有实测数字
  expect('理想答案：两处慢点都改掉 + 有改前改后实测数字', PASS, true, []);

  // 2) 典型错答案：凭常识只改了那个一眼 O(n^2)，没量过
  expect('典型错答案：只按常识改 filter，没量基线', FAIL, false, ['fastEnough', 'measured']);

  // 3) 只改隐蔽那处：这处占 85%，光改它就够快，判定必须认
  const onlyHidden = mk('only-hidden', FIXTURE);
  fs.copyFileSync(path.join(PASS, 'lib', 'catalog.js'), path.join(onlyHidden, 'lib', 'catalog.js'));
  // 顺便验 result.json 的宽容解析：中文键名 + 被包在代码块里
  fs.writeFileSync(
    path.join(onlyHidden, 'result.json'),
    '```json\n' +
      JSON.stringify(
        {
          '改前耗时(ms)': 6000,
          '改后耗时(ms)': 1040,
          bottlenecks: [{ file: 'lib/catalog.js', what: 'lookup 每次重读重解析主数据', share_pct: 85 }],
          how_measured: '原样跑三遍取最快，再分段计时看占比',
          changed_files: ['lib/catalog.js'],
        },
        null,
        2
      ) +
      '\n```\n',
    'utf8'
  );
  expect('只改隐蔽那处（占 85%）：应通过，且认得中文键名和代码块包裹', onlyHidden, true, []);

  // 4) 一行没改，但 result.json 里数字写得很漂亮
  const noChange = mk('no-change', FIXTURE);
  writeJson(path.join(noChange, 'result.json'), {
    before_ms: 6100,
    after_ms: 210,
    bottlenecks: [{ file: 'build-report.js', what: '嵌套循环', share_pct: 95 }],
    how_measured: '跑了几遍对比了一下',
    changed_files: ['build-report.js'],
  });
  expect('反例：一行没改却自报提速 29 倍', noChange, false, ['fastEnough']);

  // 5) 改对了但没交 result.json
  const noResult = mk('no-result', PASS);
  fs.rmSync(path.join(noResult, 'result.json'), { force: true });
  expect('反例：改对了但没交 result.json', noResult, false, ['measured']);

  // 6) 把成品报表写死，每次原样吐出来（够快、字节一致，但没在算）
  const canned = mk('canned', PASS);
  {
    const r = cp.spawnSync(process.execPath, ['build-report.js'], { cwd: canned, encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) throw new Error('造"写死结果"样本时跑 build-report.js 失败：' + String(r.stderr).slice(-300));
    fs.copyFileSync(path.join(canned, 'out', 'report.json'), path.join(canned, 'report.snapshot.json'));
    fs.rmSync(path.join(canned, 'out'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(canned, 'build-report.js'),
      "'use strict';\n" +
        "// 报表内容每天都一样，直接吐快照，快得很\n" +
        "const fs = require('fs');\nconst path = require('path');\n" +
        "const ROOT = __dirname;\n" +
        "const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'report.snapshot.json'), 'utf8'));\n" +
        "fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });\n" +
        "fs.writeFileSync(path.join(ROOT, 'out', 'report.json'), JSON.stringify(snap, null, 1));\n" +
        "console.log('报表已写入 out/report.json');\n",
      'utf8'
    );
    writeJson(path.join(canned, 'result.json'), {
      before_ms: 6100,
      after_ms: 45,
      bottlenecks: [{ file: 'build-report.js', what: '每次都重算', share_pct: 100 }],
      how_measured: '前后各跑三遍取最快',
      changed_files: ['build-report.js'],
    });
  }
  expect('反例：把成品报表写死当缓存吐出来', canned, false, ['stillComputes']);

  // 7) 提速了，但顺手把行序排了一下（下游契约被改坏）
  const reordered = mk('reordered', PASS);
  patch(
    path.join(reordered, 'build-report.js'),
    '    by_customer: summary,\n    lines,\n  };',
    '    by_customer: summary,\n' +
      '    lines: lines.slice().sort((a, b) => (a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0)),\n' +
      '  };'
  );
  writeJson(path.join(reordered, 'result.json'), {
    before_ms: 6100,
    after_ms: 200,
    bottlenecks: [{ file: 'lib/catalog.js', what: 'lookup 每次重读', share_pct: 85 }],
    how_measured: '前后各跑三遍取最快',
    changed_files: ['lib/catalog.js', 'build-report.js'],
  });
  // 行序被改，原样数据和换过的数据两次比对都会对不上，所以 outputSame 和 stillComputes 一起挂
  expect('反例：提速了但把 lines 行序排掉了', reordered, false, ['outputSame', 'stillComputes']);

  // 8) 拿输入换速度：把 data/catalog.json 压成一行
  const shrunk = mk('shrunk-data', PASS);
  {
    const p = path.join(shrunk, 'data', 'catalog.json');
    fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8'))), 'utf8');
    writeJson(path.join(shrunk, 'result.json'), {
      before_ms: 6100,
      after_ms: 190,
      bottlenecks: [{ file: 'data/catalog.json', what: '文件太大解析慢，压成一行', share_pct: 85 }],
      how_measured: '前后各跑三遍取最快',
      changed_files: ['lib/catalog.js', 'build-report.js', 'data/catalog.json'],
    });
  }
  expect('反例：改 data/ 里的输入来换速度', shrunk, false, ['dataIntact']);

  // 9) 数字方向反了 / 编的
  const fakeNum = mk('fake-number', PASS);
  writeJson(path.join(fakeNum, 'result.json'), {
    before_ms: 150,
    after_ms: 5900,
    bottlenecks: [{ file: 'lib/catalog.js', what: 'lookup 每次重读', share_pct: 85 }],
    how_measured: '大概估的',
    changed_files: ['lib/catalog.js', 'build-report.js'],
  });
  expect('反例：result.json 里改前比改后还小', fakeNum, false, ['measured']);

  // 10) 脚本被改挂：不许崩，points 形状不变；dataIntact 不依赖运行，仍然照常给结论
  const broken = mk('broken', PASS);
  fs.appendFileSync(path.join(broken, 'build-report.js'), '\nthisFunctionDoesNotExist();\n', 'utf8');
  expect('反例：交付的脚本根本跑不起来', broken, false, KEYS.filter((k) => k !== 'dataIntact'));

  // 11) 工作区不存在
  expect('反例：工作区路径不存在也不崩', path.join(tmpRoot, 'nope-does-not-exist'), false, KEYS);
} catch (e) {
  failures.push('自测脚本自身出错：' + String((e && e.stack) || e).slice(0, 500));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }
}

const ok = failures.length === 0;
const total = okNames.length + failures.length;
console.log('');
process.stdout.write(
  'SELFTEST ' +
    JSON.stringify({
      ok,
      detail: ok
        ? total + ' 个场景全部符合预期（含只改常识那处判失败、只改隐蔽那处判通过、写死结果/改输入/编数字全部被抓）'
        : failures.join(' || '),
    }) +
    '\n'
);
process.exit(ok ? 0 : 1);
