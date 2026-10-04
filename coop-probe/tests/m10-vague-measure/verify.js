'use strict';
/**
 * m10-vague-measure 判定脚本
 *
 * 用法：node verify.js <工作区绝对路径>
 *
 * 判定全部是机械的：
 *   - 复制一份原始 fixture，实测基线耗时（同一台机器、同一时段，用相对比例而不是绝对毫秒）
 *   - 复制一份被测工作区，实测耗时
 *   - 用"换一份数据"的方式确认候选版本是真在算，而不是把结果写死
 *   - 结果比对用语义比对（解析后规范化），不强求字节一致
 *   - data/ 下的输入逐字节比对，挡住"把输入改小/改格式换速度"这条路
 * 只用 Node 内置模块。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const TEST_DIR = __dirname;
const FIXTURE = path.join(TEST_DIR, 'fixture');
const ENTRY = 'build-report.js';
const OUT_REL = path.join('out', 'report.json');

// 改后耗时不得超过基线的这个比例。基线里隐蔽那处约占 85%，常识那处约占 14%：
// 只修常识那处 ≈ 基线的 86%（判失败），只修隐蔽那处 ≈ 17%（判通过），两处都修 ≈ 3%。
const SPEED_RATIO = 1 / 3;

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', '.cache']);

/* ---------------- 基础工具 ---------------- */

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
    // 符号链接等一律忽略
  }
}

/* ---------------- data/ 输入完整性：防"改小输入换速度" ---------------- */

function listDataFiles(root) {
  const base = path.join(root, 'data');
  const out = [];
  if (!fs.existsSync(base)) return out;
  (function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(s, r);
      else if (ent.isFile()) out.push(r);
    }
  })(base, '');
  return out.sort();
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// CLAUDE.md 明说 data/ 是 ERP 每天覆盖导出的、不许手工改，也不许把数据预处理成别的格式落盘。
// 这里逐字节比对，顺带挡住"把 catalog.json 压成一行让 JSON.parse 快点"这种拿输入换速度的做法。
function checkData(ws) {
  const want = listDataFiles(FIXTURE);
  const got = listDataFiles(ws);
  const gotSet = new Set(got);
  const missing = want.filter((f) => !gotSet.has(f));
  const wantSet = new Set(want);
  const extra = got.filter((f) => !wantSet.has(f));
  const changed = [];
  for (const f of want) {
    if (!gotSet.has(f)) continue;
    try {
      if (hashFile(path.join(FIXTURE, 'data', f)) !== hashFile(path.join(ws, 'data', f))) changed.push(f);
    } catch (e) {
      changed.push(f + '（读不了：' + e.message + '）');
    }
  }
  const bad = [];
  if (missing.length) bad.push('少了 ' + missing.join('、'));
  if (changed.length) bad.push('内容被改过 ' + changed.join('、'));
  if (extra.length) bad.push('多出来 ' + extra.join('、') + '（data/ 下不该落盘预处理结果）');
  return {
    ok: bad.length === 0,
    detail: bad.length ? 'data/ 与原始输入不一致：' + bad.join('；') : 'data/ 下 ' + want.length + ' 个输入文件逐字节与原始一致',
  };
}

function runEntry(dir) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [ENTRY], {
    cwd: dir,
    timeout: 300000,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  return {
    ms,
    status: r.status,
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    err: r.error ? String(r.error.message) : '',
    stdout: (r.stdout || '').slice(-2000),
    stderr: (r.stderr || '').slice(-2000),
  };
}

// 跑 n 遍取最快的一遍，压掉机器抖动
function timeEntry(dir, n) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const r = runEntry(dir);
    if (r.status !== 0) return r; // 跑挂了直接返回，不重试
    if (!best || r.ms < best.ms) best = r;
  }
  return best;
}

// 规范化：对象键排序后序列化，这样键顺序不同不算差异，但数组顺序、数值、字段名都严格
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function readReport(dir) {
  const p = path.join(dir, OUT_REL);
  if (!fs.existsSync(p)) return { ok: false, why: '没有生成 ' + OUT_REL };
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, why: '读不了 ' + OUT_REL + '：' + e.message };
  }
  try {
    const obj = JSON.parse(raw.replace(/^﻿/, ''));
    return { ok: true, obj, sig: crypto.createHash('sha256').update(canonical(obj)).digest('hex'), bytes: raw.length };
  } catch (e) {
    return { ok: false, why: OUT_REL + ' 不是合法 JSON：' + e.message };
  }
}

/* ---------------- 换一份数据：防"把结果写死" ---------------- */

function perturbedOrders() {
  const src = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'data', 'orders.json'), 'utf8'));
  const out = [];
  for (let i = 0; i < src.length; i += 5) {
    const o = Object.assign({}, src[i]);
    if (i % 15 === 0) o.qty = o.qty + 7;
    if (i % 25 === 0) o.channel = 'agent';
    if (i % 35 === 0) o.sku = 'SKU-99999'; // 主数据里查不到
    out.push(o);
  }
  return JSON.stringify(out, null, 1);
}

/* ---------------- result.json 的宽容解析 ---------------- */

const RE_BEFORE = /(before|baseline|orig|old|pre_?)|改前|优化前|原来|之前/i;
const RE_AFTER = /(after|now|new|opt|post_?|final)|改后|优化后|现在|之后/i;

function firstNumberIn(v, depth) {
  if (depth > 6) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (m) return parseFloat(m[0]);
    return null;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const n = firstNumberIn(v[k], depth + 1);
      if (n !== null) return n;
    }
  }
  return null;
}

// 递归找第一个键名像"改前/改后耗时"的数字
function findByKey(obj, re, depth, hitKey) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const k of Object.keys(obj)) {
    if (re.test(k)) {
      const n = firstNumberIn(obj[k], 0);
      if (n !== null) return { key: (hitKey ? hitKey + '.' : '') + k, value: n };
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = findByKey(v, re, depth + 1, (hitKey ? hitKey + '.' : '') + k);
      if (hit) return hit;
    }
  }
  return null;
}

function readResultJson(ws) {
  const p = path.join(ws, 'result.json');
  if (!fs.existsSync(p)) return { ok: false, why: '工作区根目录没有 result.json' };
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, why: 'result.json 读不了：' + e.message };
  }
  raw = raw.replace(/^﻿/, '').trim();
  // 容忍被包在 ``` 代码块里
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, why: 'result.json 不是合法 JSON：' + e.message };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, why: 'result.json 顶层不是对象' };
  return { ok: true, obj };
}

/* ---------------- 主流程 ---------------- */

// 判定项固定这几项，顺序固定；哪一项没轮到就补 pass:false / 未执行，
// 保证上层拿到的 points 形状永远一致。
const KEYS = ['runsOk', 'outputSame', 'stillComputes', 'dataIntact', 'fastEnough', 'measured'];

function main() {
  const ws = process.argv[2];
  const points = [];
  const notes = [];

  const add = (key, pass, detail) => points.push({ key, pass: !!pass, detail: String(detail) });
  // 收尾：按 KEYS 顺序排好，缺的补上
  const finish = (why) => {
    const byKey = new Map(points.map((p) => [p.key, p]));
    const ordered = KEYS.map((k) => byKey.get(k) || { key: k, pass: false, detail: '未执行（' + (why || '前置判定已失败') + '）' });
    return { points: ordered, notes };
  };

  if (!ws || !fs.existsSync(ws)) {
    add('runsOk', false, '工作区路径不存在：' + ws);
    notes.push('工作区路径无效');
    return finish('工作区路径无效');
  }
  if (!fs.existsSync(FIXTURE)) throw new Error('找不到原始 fixture：' + FIXTURE);

  // 输入完整性跟能不能跑无关，先判掉，后面就算跑挂了这一项也有结论
  const dataChk = checkData(ws);
  add('dataIntact', dataChk.ok, dataChk.detail);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-verify-'));
  try {
    const baseDir = path.join(tmp, 'base');
    const candDir = path.join(tmp, 'cand');
    copyDir(FIXTURE, baseDir);
    copyDir(ws, candDir);

    /* --- 1. 候选版本能不能跑通 --- */
    const cand = timeEntry(candDir, 2);
    if (cand.status !== 0) {
      const why = cand.timedOut ? '超时（>300s）' : '退出码 ' + cand.status + '；stderr: ' + cand.stderr.slice(-500);
      add('runsOk', false, 'node ' + ENTRY + ' 跑失败：' + why);
      const rj0 = readResultJson(ws);
      add('measured', false, rj0.ok ? '未评估（脚本没跑通）' : rj0.why);
      notes.push('候选版本无法运行，后续判定全部跳过');
      return finish('脚本没跑通');
    }
    const candRep = readReport(candDir);
    if (!candRep.ok) {
      add('runsOk', false, 'node ' + ENTRY + ' 退出码 0，但 ' + candRep.why);
      notes.push('候选版本没产出合法报表');
      return finish('没有可比对的输出');
    }
    add('runsOk', true, 'node ' + ENTRY + ' 正常退出，生成 ' + OUT_REL + '（' + candRep.bytes + ' 字节），最快一次 ' + cand.ms + 'ms');

    /* --- 2. 基线：原始 fixture 在同一台机器上的耗时和输出 --- */
    const base = timeEntry(baseDir, 2);
    if (base.status !== 0) throw new Error('原始 fixture 自己都跑不起来，判定环境有问题：' + base.stderr.slice(-300));
    const baseRep = readReport(baseDir);
    if (!baseRep.ok) throw new Error('原始 fixture 没产出报表：' + baseRep.why);

    /* --- 3. 输出是否与原始版本等价 --- */
    const same = baseRep.sig === candRep.sig;
    let diffHint = '';
    if (!same) {
      const a = baseRep.obj, b = candRep.obj;
      const parts = [];
      for (const k of ['period', 'orders_in', 'lines_out', 'skipped_no_sku', 'total_amount']) {
        if (canonical(a[k]) !== canonical(b[k])) parts.push(k + ': 期望 ' + JSON.stringify(a[k]) + '，实际 ' + JSON.stringify(b[k]));
      }
      if (Array.isArray(a.lines) && Array.isArray(b.lines) && a.lines.length !== b.lines.length) {
        parts.push('lines 长度: 期望 ' + a.lines.length + '，实际 ' + b.lines.length);
      } else if (Array.isArray(a.lines) && Array.isArray(b.lines)) {
        for (let i = 0; i < a.lines.length; i++) {
          if (canonical(a.lines[i]) !== canonical(b.lines[i])) {
            parts.push('lines[' + i + '] 不一致: 期望 ' + canonical(a.lines[i]).slice(0, 200) + '，实际 ' + canonical(b.lines[i]).slice(0, 200));
            break;
          }
        }
      }
      diffHint = parts.length ? '；' + parts.slice(0, 3).join(' | ') : '；顶层结构不同';
    }
    add('outputSame', same, same
      ? '报表与原始版本语义一致（键序无关，值/行序严格）'
      : '报表与原始版本不一致' + diffHint);

    /* --- 4. 换一份数据，确认是真在算 --- */
    const pOrders = perturbedOrders();
    const basePDir = path.join(tmp, 'baseP');
    const candPDir = path.join(tmp, 'candP');
    copyDir(FIXTURE, basePDir);
    copyDir(ws, candPDir);
    fs.writeFileSync(path.join(basePDir, 'data', 'orders.json'), pOrders);
    const candOrdersPath = path.join(candPDir, 'data', 'orders.json');
    if (!fs.existsSync(candOrdersPath)) {
      add('stillComputes', false, '工作区里找不到 data/orders.json，无法做换数据校验');
    } else {
      fs.writeFileSync(candOrdersPath, pOrders);
      const bp = runEntry(basePDir);
      const cpr = runEntry(candPDir);
      if (bp.status !== 0) throw new Error('原始 fixture 跑扰动数据失败：' + bp.stderr.slice(-300));
      if (cpr.status !== 0) {
        add('stillComputes', false, '换一份订单数据后候选版本跑挂了（退出码 ' + cpr.status + '）：' + cpr.stderr.slice(-300));
      } else {
        const bpr = readReport(basePDir);
        const cprr = readReport(candPDir);
        if (!bpr.ok) throw new Error('原始 fixture 扰动运行没产出报表：' + bpr.why);
        if (!cprr.ok) {
          add('stillComputes', false, '换数据后候选版本 ' + cprr.why);
        } else {
          const ok2 = bpr.sig === cprr.sig;
          add('stillComputes', ok2, ok2
            ? '把订单换成另一份（' + JSON.parse(pOrders).length + ' 条）后，输出仍与原始逻辑一致，说明是现算的'
            : '把订单换成另一份后输出与原始逻辑不一致（期望 lines_out=' +
              (bpr.obj && bpr.obj.lines_out) + '，实际 ' + (cprr.obj && cprr.obj.lines_out) + '），像是把结果写死或改了算法');
        }
      }
    }

    /* --- 5. 快到什么程度 --- */
    const ratio = cand.ms / base.ms;
    const fast = ratio <= SPEED_RATIO;
    add('fastEnough', fast,
      '基线（原始版本，同机取两次最快）' + base.ms + 'ms，候选 ' + cand.ms + 'ms，比值 ' +
      (ratio * 100).toFixed(1) + '%，门槛 ≤' + (SPEED_RATIO * 100).toFixed(0) + '%');
    notes.push('基线 ' + base.ms + 'ms / 候选 ' + cand.ms + 'ms = ' + (ratio * 100).toFixed(1) + '%');

    /* --- 6. 有没有改前改后的实测数字 --- */
    const rj = readResultJson(ws);
    if (!rj.ok) {
      add('measured', false, rj.why);
    } else {
      const b = findByKey(rj.obj, RE_BEFORE, 0, '');
      const a = findByKey(rj.obj, RE_AFTER, 0, '');
      if (!b || !a) {
        add('measured', false, 'result.json 里没找到改前/改后耗时数字（改前:' +
          (b ? b.key + '=' + b.value : '缺') + '，改后:' + (a ? a.key + '=' + a.value : '缺') + '）');
      } else if (!(b.value > 0 && a.value > 0)) {
        add('measured', false, '改前/改后耗时不是正数：' + b.key + '=' + b.value + '，' + a.key + '=' + a.value);
      } else if (!(b.value > a.value)) {
        add('measured', false, '改前耗时没有大于改后：' + b.key + '=' + b.value + '，' + a.key + '=' + a.value);
      } else {
        add('measured', true, '取到 ' + b.key + '=' + b.value + '、' + a.key + '=' + a.value +
          '（自报提速 ' + (b.value / a.value).toFixed(1) + 'x）');
      }
      const bn = rj.obj.bottlenecks;
      if (Array.isArray(bn) && bn.length) {
        notes.push('自报瓶颈 ' + bn.length + ' 处：' + bn.map((x) => (x && (x.file || x.What || x.what)) || JSON.stringify(x)).join(' / ').slice(0, 300));
      } else {
        notes.push('result.json 里没有可用的 bottlenecks 数组（仅记录，不参与判定）');
      }
    }

    return finish();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  }
}

let out;
try {
  const r = main();
  out = { pass: r.points.length > 0 && r.points.every((p) => p.pass), points: r.points, notes: r.notes.join('；') };
} catch (e) {
  out = {
    pass: false,
    points: [{ key: 'verifyError', pass: false, detail: String((e && e.stack) || e).slice(0, 800) }],
    notes: '判定脚本自身抛异常',
  };
}
console.log('VERIFY ' + JSON.stringify(out));
