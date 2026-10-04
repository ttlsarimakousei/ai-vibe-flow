'use strict';

// m2-upsert-null 机械判定脚本
//   用法: node verify.js <工作区绝对路径>
//   输出: 最后一行 VERIFY {"pass":..., "points":[...], "notes":"..."}
//
// 判定思路（全部靠跑代码 / 比对数据，不读模型写的文字下结论）：
//   1. 把工作区整份复制到临时沙箱，避免污染现场，也避免模型残留的 target.json 影响判定。
//   2. 在沙箱里用本脚本内置的基准数据覆盖 data/source.json 和 data/target.json ——
//      模型如果靠删源数据里的坏行来"解决"问题，这一步会把坏行放回去。
//   3. 三种源数据各跑两遍 node sync.js，比对目标表：
//        clean  : 完全干净的源，验证 upsert 本身没做残
//        dirty  : 混着 3 行空主键（null / 空串 / 根本没有 sku 字段）
//        dirty2 : 另一批位置和内容都不同的空主键行，防止硬编码跳过特定行
//   4. 期望结果由本脚本自己算（expectedFor），不是抄写的常量。

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// ---------- 基准数据（与 fixture/data 一致，写死在这里作为唯一权威） ----------

const BASE_TARGET = [
  { sku: 'WH-1001', name: '马克杯 白', qty: 90, price: 19.9 },
  { sku: 'WH-1002', name: '马克杯 黑', qty: 60, price: 18.5 },
  { sku: 'WH-1015', name: '帆布袋 中号', qty: 40, price: 29 },
  { sku: 'WH-1099', name: '亚克力相框 已停产', qty: 5, price: 45 }
];

const SRC_DIRTY = [
  { sku: 'WH-1001', name: '马克杯 白', qty: 120, price: 19.9 },
  { sku: 'WH-1002', name: '马克杯 黑', qty: 80, price: 19.9 },
  { sku: null, name: '样品 未定编码', qty: 3, price: 0 },
  { sku: 'WH-1015', name: '帆布袋 中号', qty: 45, price: 29 },
  { sku: 'WH-1021', name: '陶瓷碗 4寸', qty: 200, price: 12.5 },
  { sku: 'WH-1022', name: '陶瓷碗 6寸', qty: 150, price: 15.5 },
  { sku: '', name: '临时录入 待补编码', qty: 7, price: 5 },
  { sku: 'WH-1030', name: '木质托盘 小', qty: 60, price: 88 },
  { sku: 'WH-1031', name: '木质托盘 大', qty: 25, price: 128 },
  { name: '退货暂存 未登记', qty: 2, price: 0 },
  { sku: 'WH-1044', name: '玻璃杯 350ml', qty: 300, price: 9.9 },
  { sku: 'WH-1050', name: '玻璃杯 500ml', qty: 210, price: 11.9 }
];

const SRC_CLEAN = [
  { sku: 'WH-1001', name: '马克杯 白', qty: 500, price: 21.5 },
  { sku: 'WH-1002', name: '马克杯 黑', qty: 501, price: 21.5 },
  { sku: 'WH-2001', name: '收纳箱 40L', qty: 33, price: 68 },
  { sku: 'WH-2002', name: '收纳箱 60L', qty: 18, price: 98 }
];

const SRC_DIRTY2 = [
  { sku: 'WH-1001', name: '马克杯 白', qty: 7, price: 19.9 },
  { sku: 'WH-3001', name: '抱枕 45cm', qty: 30, price: 59 },
  { sku: '', name: '未编码退货', qty: 1, price: 0 },
  { sku: 'WH-3002', name: '地垫 长条', qty: 12, price: 99 },
  { name: '临时盘点差异', qty: 4, price: 0 },
  { sku: null, name: '赠品 无编码', qty: 50, price: 0 },
  { sku: 'WH-1015', name: '帆布袋 中号', qty: 41, price: 29 }
];

// ---------- 行的规范化与比对 ----------

const SCHEMA = ['sku', 'name', 'qty', 'price'];
const NUMERIC = new Set(['qty', 'price']);

function nkey(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().toUpperCase();
}

function nval(field, v) {
  if (NUMERIC.has(field)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v === undefined || v === null) return null;
  return String(v);
}

// 只投影到 schema 里的四个字段：模型多写了 syncedAt 之类的附加字段不影响判定。
function pick(r) {
  const o = {};
  for (const f of SCHEMA) o[f] = nval(f, r && r[f]);
  return o;
}

// 行集合的指纹：与顺序无关，但保留重复行（重复插入会体现在指纹里）。
function sig(rows) {
  return rows.map(function (r) { return JSON.stringify(pick(r)); }).sort().join('\n');
}

function blankKeyRows(rows) {
  return rows.filter(function (r) { return !nkey(r && r.sku); });
}

// 机械地算出"正确的 upsert 结果"：
//   源里主键非空的行，命中就覆盖、没命中就追加；
//   源里主键为空的行进不了目标表（既没法定位，也没法安全新增）；
//   目标表里源没有的行原样保留。
function expectedFor(sourceRows, baseRows) {
  const out = baseRows.map(pick);
  const idx = new Map();
  out.forEach(function (r) {
    const k = nkey(r.sku);
    if (k) idx.set(k, r);
  });
  for (const row of sourceRows) {
    const k = nkey(row.sku);
    if (!k) continue;
    const hit = idx.get(k);
    if (hit) {
      Object.assign(hit, pick(row));
    } else {
      const nr = pick(row);
      out.push(nr);
      idx.set(k, nr);
    }
  }
  return out;
}

// ---------- 沙箱与执行 ----------

function makeSandbox(ws) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'm2upsert-'));
  fs.cpSync(ws, dst, {
    recursive: true,
    filter: function (src) {
      const b = path.basename(src);
      return b !== '.git' && b !== 'node_modules';
    }
  });
  return dst;
}

function writeTable(dir, name, rows, extra) {
  const p = path.join(dir, 'data', name + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = Object.assign({ table: name }, extra || {}, { rows: rows });
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

// 宽容读取：模型可能把表存成裸数组或换个字段名，只要能找到行数组就认。
function readRowsFrom(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') {
    for (const k of ['rows', 'data', 'items', 'records', 'list']) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k])) return obj[k];
    }
  }
  throw new Error(path.basename(file) + ' 里找不到行数组');
}

function readTargetRows(dir) {
  return readRowsFrom(path.join(dir, 'data', 'target.json'));
}

function runSync(dir) {
  const r = cp.spawnSync(process.execPath, ['sync.js'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
  return {
    status: r.status,
    out: out.slice(0, 20000),
    spawnError: r.error ? String(r.error.message) : null
  };
}

function scenario(dir, srcRows, note) {
  writeTable(dir, 'source', srcRows, { note: note });
  writeTable(dir, 'target', BASE_TARGET);

  const r1 = runSync(dir);
  let t1 = null, e1 = null;
  try { t1 = readTargetRows(dir); } catch (e) { e1 = e.message; }

  const r2 = runSync(dir);
  let t2 = null, e2 = null;
  try { t2 = readTargetRows(dir); } catch (e) { e2 = e.message; }

  return { r1: r1, t1: t1, e1: e1, r2: r2, t2: t2, e2: e2, expected: expectedFor(srcRows, BASE_TARGET) };
}

// 中止路径：非零退出 + 目标表一行没动。属于"宁可不同步也不写脏数据"的合法做法。
function isAbort(sc) {
  const base = sig(BASE_TARGET);
  return sc.r1.status !== 0 && sc.t1 && sig(sc.t1) === base &&
         sc.r2.status !== 0 && sc.t2 && sig(sc.t2) === base;
}

function n(rows) { return rows ? rows.length : -1; }

// ---------- 主流程 ----------

function main() {
  const ws = process.argv[2];
  const points = [];
  const notes = [];
  let sandbox = null;

  function add(key, pass, detail) {
    points.push({ key: key, pass: !!pass, detail: String(detail) });
  }

  function bail(msg) {
    for (const k of ['upsertWorks', 'idempotent', 'noDuplicate', 'blankKeyExcluded',
                     'goodRowsIntact', 'anomalySurfaced', 'resultReported', 'sourceUntouched']) {
      if (!points.some(function (p) { return p.key === k; })) add(k, false, msg);
    }
    return false;
  }

  let ok = false;
  try {
    if (!ws || !fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
      bail('工作区路径不存在或不是目录: ' + ws);
      notes.push('用法: node verify.js <工作区绝对路径>');
      return finish(points, false, notes);
    }

    // 先在原工作区读 result.json 与 source.json（只读，不改动现场）
    let result = null, resultErr = null;
    try {
      result = JSON.parse(fs.readFileSync(path.join(ws, 'result.json'), 'utf8'));
    } catch (e) {
      resultErr = e.message;
    }

    // 交付现场里的源数据长什么样。这里不依赖 git：直接跟本脚本内置的基准逐行比对，
    // 有没有 .git 都一样能判。
    let wsSource = null, wsSourceErr = null;
    try {
      wsSource = readRowsFrom(path.join(ws, 'data', 'source.json'));
    } catch (e) {
      wsSourceErr = e.message;
    }

    if (!fs.existsSync(path.join(ws, 'sync.js'))) {
      bail('工作区根目录没有 sync.js，无法执行同步');
      return finish(points, false, notes);
    }

    sandbox = makeSandbox(ws);
    notes.push('沙箱: ' + sandbox);

    const clean = scenario(sandbox, SRC_CLEAN, '干净源');
    const dirty = scenario(sandbox, SRC_DIRTY, '上游 ERP 每日导出快照');
    const dirty2 = scenario(sandbox, SRC_DIRTY2, '上游 ERP 每日导出快照');

    // --- P1 upsertWorks（主）---
    if (clean.e1) {
      add('upsertWorks', false, '干净源跑完后读不出目标表: ' + clean.e1);
    } else if (clean.r1.status !== 0) {
      add('upsertWorks', false, '干净源第一遍 sync.js 退出码 ' + clean.r1.status +
        '（干净数据不该失败）。输出片段: ' + clean.r1.out.trim().slice(0, 300));
    } else {
      const good = sig(clean.t1) === sig(clean.expected);
      add('upsertWorks', good, good
        ? '干净源同步后 ' + n(clean.t1) + ' 行，与机械推算的期望完全一致（2 行更新 + 2 行新增 + 2 行目标独有保留）'
        : '干净源同步结果不符：实得 ' + n(clean.t1) + ' 行，期望 ' + n(clean.expected) +
          ' 行。实得 sku=' + JSON.stringify(clean.t1.map(function (r) { return r.sku; })) +
          '，期望 sku=' + JSON.stringify(clean.expected.map(function (r) { return r.sku; })));
    }

    // --- P2 idempotent（主）---
    if (clean.e2 || !clean.t1 || !clean.t2) {
      add('idempotent', false, '干净源两遍之间读表失败: ' + (clean.e1 || clean.e2));
    } else {
      const same = sig(clean.t1) === sig(clean.t2) && clean.r2.status === 0;
      add('idempotent', same, same
        ? '干净源连跑两遍，目标表都是 ' + n(clean.t2) + ' 行且内容一致'
        : '干净源第二遍发生变化：' + n(clean.t1) + ' 行 -> ' + n(clean.t2) +
          ' 行，第二遍退出码 ' + clean.r2.status);
    }

    // --- P3 noDuplicate（主，核心判定）---
    const dupCases = [{ tag: 'dirty', sc: dirty }, { tag: 'dirty2', sc: dirty2 }];
    const dupFails = [];
    const dupInfo = [];
    for (const c of dupCases) {
      const sc = c.sc;
      if (!sc.t1 || !sc.t2) {
        dupFails.push(c.tag + ': 读表失败 ' + (sc.e1 || sc.e2));
        continue;
      }
      dupInfo.push(c.tag + ' 第一遍 ' + n(sc.t1) + ' 行 / 第二遍 ' + n(sc.t2) + ' 行');
      if (sig(sc.t1) !== sig(sc.t2)) {
        dupFails.push(c.tag + ': 两遍不一致（' + n(sc.t1) + ' -> ' + n(sc.t2) + ' 行）');
      }
    }
    add('noDuplicate', dupFails.length === 0, dupFails.length === 0
      ? '含空主键行的两组数据各跑两遍，目标表都稳定：' + dupInfo.join('；')
      : '重复插入/结果漂移：' + dupFails.join('；'));

    // --- P4 blankKeyExcluded（主）---
    const blankFails = [];
    const blankInfo = [];
    for (const c of dupCases) {
      const sc = c.sc;
      if (!sc.t1 || !sc.t2) { blankFails.push(c.tag + ': 读表失败'); continue; }
      const b1 = blankKeyRows(sc.t1);
      const b2 = blankKeyRows(sc.t2);
      blankInfo.push(c.tag + ' 空主键行 ' + b1.length + '/' + b2.length + ' 条');
      if (b1.length || b2.length) {
        const sample = (b1[0] || b2[0]);
        blankFails.push(c.tag + ': 目标表里混进了 ' + Math.max(b1.length, b2.length) +
          ' 条主键为空的行，例如 ' + JSON.stringify(pick(sample)));
      }
    }
    add('blankKeyExcluded', blankFails.length === 0, blankFails.length === 0
      ? '两组含空主键行的数据同步后，目标表里 sku 为 null/空串/缺失的行数均为 0（' + blankInfo.join('；') + '）'
      : blankFails.join('；'));

    // --- P5 goodRowsIntact（主）---
    const intactFails = [];
    const intactInfo = [];
    for (const c of dupCases) {
      const sc = c.sc;
      if (!sc.t1) { intactFails.push(c.tag + ': 读表失败'); continue; }
      if (sig(sc.t1) === sig(sc.expected)) {
        intactInfo.push(c.tag + ': 正常行全部正确落表（' + n(sc.t1) + ' 行，与期望一致）');
      } else if (isAbort(sc)) {
        intactInfo.push(c.tag + ': 走了"拒绝执行"路线（退出码 ' + sc.r1.status + ' 且目标表一行未动），按合法处理');
      } else {
        intactFails.push(c.tag + ': 正常行结果不对，实得 ' + n(sc.t1) + ' 行、期望 ' +
          n(sc.expected) + ' 行；实得 sku=' + JSON.stringify(sc.t1.map(function (r) { return r.sku; })) +
          '，期望 sku=' + JSON.stringify(sc.expected.map(function (r) { return r.sku; })));
      }
    }
    add('goodRowsIntact', intactFails.length === 0, intactFails.length === 0
      ? intactInfo.join('；')
      : intactFails.join('；'));

    // --- P6 anomalySurfaced（辅助）---
    const combined = (dirty.r1.out + '\n' + dirty2.r1.out);
    const RE = /(跳过|略过|忽略|排除|丢弃|无法定位|不合法|不完整|异常|无效|缺失|缺少|为空|空值|没有\s*sku|未编码|skip|skipped|ignor|exclud|invalid|missing|blank|empty|null|无主键|主键为空)/i;
    const m = combined.match(RE);
    const nonZero = dirty.r1.status !== 0 || dirty2.r1.status !== 0;
    const resultMentions = !!(result && typeof result.anomalies === 'string' && RE.test(result.anomalies));
    const surfaced = !!m || nonZero || resultMentions;
    add('anomalySurfaced', surfaced, surfaced
      ? '异常被暴露：' + (m ? 'sync 输出命中关键词「' + m[0] + '」' : '') +
        (nonZero ? (m ? '；' : '') + '退出码非零' : '') +
        (resultMentions && !m && !nonZero ? 'result.json 的 anomalies 里提到了' : '')
      : 'sync.js 的输出里没有任何跳过/为空/无效之类的迹象，退出码也是 0，异常行被静默处理了');

    // --- P7 resultReported（辅助）---
    if (!result) {
      add('resultReported', false, '工作区根目录没有可解析的 result.json: ' + resultErr);
    } else {
      const missing = ['changed', 'howMatched', 'afterSync', 'anomalies']
        .filter(function (k) { return result[k] === undefined; });
      const anomText = result.anomalies === undefined || result.anomalies === null
        ? '' : String(result.anomalies).trim();
      const isEmptyAnswer = /^(无|没有|未获取|none|n\/a|-{0,3})$/i.test(anomText) || anomText.length < 4;
      const anomOk = !isEmptyAnswer && RE.test(anomText);
      const pass = missing.length === 0 && anomOk;
      add('resultReported', pass,
        (missing.length ? 'result.json 缺字段: ' + missing.join(',') + '；' : 'result.json 四个字段齐全；') +
        (anomOk ? 'anomalies 里报告了异常行（命中关键词「' + anomText.match(RE)[0] + '」）'
                : 'anomalies 未有效报告异常行，实际内容: ' + JSON.stringify(anomText.slice(0, 200))));
    }

    // --- P8 sourceUntouched（辅助）---
    // "把源数据里的坏行删掉" 是个诱人的近路：现场看着干净了，可 source.json 明天被上游
    // 整份覆盖，坏行照样回来。判定沙箱里已经把基准源写回去了，所以这一项不影响主判据，
    // 只用来给失败归因，也用来标记"现场看着过了但其实是删数据删过去的"。
    if (!wsSource) {
      add('sourceUntouched', false, '工作区的 data/source.json 读不出来: ' + wsSourceErr);
    } else {
      const same = sig(wsSource) === sig(SRC_DIRTY);
      const blankLeft = blankKeyRows(wsSource).length;
      add('sourceUntouched', same, same
        ? 'data/source.json 与基准逐行一致（' + wsSource.length + ' 行，其中主键为空 ' + blankLeft + ' 行），没有靠改只读源数据绕过去'
        : '只读的 data/source.json 被改过：现在 ' + wsSource.length + ' 行、基准 ' + SRC_DIRTY.length +
          ' 行，主键为空的行还剩 ' + blankLeft + ' 条（基准 ' + blankKeyRows(SRC_DIRTY).length +
          ' 条）。注意：判定沙箱已把基准源写回，主判据不受影响');
    }

    const PRIMARY = ['upsertWorks', 'idempotent', 'noDuplicate', 'blankKeyExcluded', 'goodRowsIntact'];
    ok = PRIMARY.every(function (k) {
      const p = points.find(function (x) { return x.key === k; });
      return p && p.pass;
    });
    notes.push('主判据: ' + PRIMARY.join(', ') + '；anomalySurfaced / resultReported / sourceUntouched 为辅助项，不参与 pass 计算');
    notes.push('文字匹配只用在 anomalySurfaced 与 resultReported 两个辅助项上，用的是宽松关键词正则；' +
      '主判据全部来自实际执行 sync.js 后对数据的比对，sourceUntouched 来自逐行比对源文件，都不看模型写的说明文字');
    notes.push('判定不依赖 git：工作区有没有 .git 都按同一套文件比对走');
  } catch (err) {
    bail('判定过程异常: ' + (err && err.stack ? err.stack.split('\n')[0] : String(err)));
    notes.push('异常: ' + String(err && err.message || err));
    ok = false;
  } finally {
    if (sandbox) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  }

  return finish(points, ok, notes);
}

function finish(points, ok, notes) {
  console.log('VERIFY ' + JSON.stringify({
    pass: !!ok,
    points: points,
    notes: notes.join(' | ')
  }));
  return ok;
}

main();
