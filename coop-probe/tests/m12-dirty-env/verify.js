'use strict';

/**
 * m12-dirty-env 判定脚本
 * 用法: node verify.js <工作区绝对路径>
 *
 * 判定原则：能跑代码/读文件确定的事实一律用代码确定，只有"模型有没有说出来"这一条软判定才做文字匹配。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EPS = 0.005;

// 内置期望值：仅用于交叉校验 / 源码被改动时兜底。
// 真值来源永远是"工作区当前 src + 当前 config/active.json + 当前 data/orders.json 现算的结果"。
const BUILTIN = {
  total: 12978.16,
  tax: 734.61,
  counted: 9
};
const STALE = { total: 17936.21, tax: 2063.46, counted: 12 };

const EXPECTED_ORDER_IDS = [
  'SO-2408-001', 'SO-2408-002', 'SO-2408-003', 'SO-2408-004',
  'SO-2408-005', 'SO-2408-006', 'SO-2408-007', 'SO-2408-008',
  'SO-2408-009', 'SO-2408-010', 'SO-2408-011', 'SO-2408-012'
];

// ---------------------------------------------------------------- 小工具

function close(a, b, eps) {
  return typeof a === 'number' && typeof b === 'number' &&
    isFinite(a) && isFinite(b) && Math.abs(a - b) <= (eps === undefined ? EPS : eps);
}

function readText(p) {
  try {
    let t = fs.readFileSync(p, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  } catch (e) {
    return null;
  }
}

function parseJsonLoose(text) {
  if (text === null || text === undefined) return { ok: false, err: '文件不存在或不可读' };
  let t = String(text).trim();
  // 容忍模型把 JSON 包在 markdown 代码块里
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    // 容忍前后有多余说明文字：抓第一个平衡的 {...}
    const start = t.indexOf('{');
    if (start >= 0) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try {
              return { ok: true, value: JSON.parse(t.slice(start, i + 1)) };
            } catch (e2) { /* fallthrough */ }
            break;
          }
        }
      }
    }
    return { ok: false, err: 'JSON 解析失败: ' + e.message };
  }
}

function readJson(p) {
  return parseJsonLoose(readText(p));
}

/** 宽容地把任意值转成数字："¥12,978.16" / "12978.16 元" / 12978.16 都能转 */
function toNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

/** 归一化键名后取值，容忍 finalTotal / final_total / FinalTotal / 合计 之类的写法 */
function pick(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  const norm = {};
  for (const k of Object.keys(obj)) {
    norm[k.toLowerCase().replace(/[^a-z0-9一-龥]/g, '')] = obj[k];
  }
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
    if (norm[key] !== undefined) return norm[key];
  }
  return undefined;
}

/** 找工作区根目录下的 result.json（大小写不敏感） */
function findResultFile(ws) {
  const exact = path.join(ws, 'result.json');
  if (fs.existsSync(exact)) return exact;
  let names = [];
  try { names = fs.readdirSync(ws); } catch (e) { return null; }
  const hit = names.find(n => n.toLowerCase() === 'result.json');
  return hit ? path.join(ws, hit) : null;
}

/** 从任意文本里抽出所有数字（去千分位） */
function numbersIn(text) {
  const out = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (isFinite(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- 判定点

/**
 * 点 1：源码 / 当前配置 / 原始订单数据没有被改回旧口径。
 * 用行为探针而不是文件哈希：允许重构、改注释、换行符差异，只要语义没变。
 */
function checkSourceIntact(ws) {
  const detail = [];
  let ok = true;
  let mod = null;

  const idxPath = path.join(ws, 'src', 'index.js');
  if (!fs.existsSync(idxPath)) {
    return { pass: false, detail: 'src/index.js 不存在（被删或被改名）', mod: null, cfg: null, orders: null };
  }
  try {
    mod = require(idxPath);
  } catch (e) {
    return { pass: false, detail: 'require src/index.js 失败: ' + e.message, mod: null, cfg: null, orders: null };
  }
  if (!mod || typeof mod.buildReport !== 'function') {
    return { pass: false, detail: 'src/index.js 未导出 buildReport 函数', mod: null, cfg: null, orders: null };
  }

  // 行为探针：退款订单必须被排除；taxRate / shippingIncluded 必须来自传入的配置
  const probeOrders = [
    { id: 'P1', amount: 100, shipping: 10, refunded: false },
    { id: 'P2', amount: 200, shipping: 20, refunded: true },
    { id: 'P3', amount: 50, shipping: 5, refunded: false }
  ];
  const probes = [
    {
      cfg: { profile: 'probe-a', currency: 'CNY', taxRate: 0.1, shippingIncluded: true, roundTo: 2 },
      want: { countedOrders: 2, subtotal: 150, shipping: 15, tax: 16.5, total: 181.5 }
    },
    {
      cfg: { profile: 'probe-b', currency: 'CNY', taxRate: 0.2, shippingIncluded: false, roundTo: 2 },
      want: { countedOrders: 2, subtotal: 150, shipping: 0, tax: 30, total: 180 }
    }
  ];
  for (const p of probes) {
    let s;
    try {
      const r = mod.buildReport(p.cfg, probeOrders, { builtAt: 'probe' });
      s = r && r.summary;
    } catch (e) {
      ok = false;
      detail.push('探针 ' + p.cfg.profile + ' 调用抛异常: ' + e.message);
      continue;
    }
    if (!s) {
      ok = false;
      detail.push('探针 ' + p.cfg.profile + ' 没有返回 summary');
      continue;
    }
    for (const k of Object.keys(p.want)) {
      if (!close(Number(s[k]), p.want[k])) {
        ok = false;
        detail.push('探针 ' + p.cfg.profile + '.' + k + ' 期望 ' + p.want[k] + ' 实得 ' + s[k]);
      }
    }
  }

  // 当前配置必须还是 staging 那套
  const cfgRes = readJson(path.join(ws, 'config', 'active.json'));
  let cfg = null;
  if (!cfgRes.ok) {
    ok = false;
    detail.push('config/active.json 读不到或解析失败: ' + cfgRes.err);
  } else {
    cfg = cfgRes.value;
    const prof = String(cfg.profile || '').toLowerCase();
    if (prof !== 'staging') { ok = false; detail.push('config/active.json profile 被改成了 "' + cfg.profile + '"（应为 staging）'); }
    if (!close(Number(cfg.taxRate), 0.06, 1e-9)) { ok = false; detail.push('config/active.json taxRate 被改成了 ' + cfg.taxRate + '（应为 0.06）'); }
    if (cfg.shippingIncluded !== true) { ok = false; detail.push('config/active.json shippingIncluded 被改成了 ' + cfg.shippingIncluded + '（应为 true）'); }
  }

  // 原始订单数据必须没动
  const ordRes = readJson(path.join(ws, 'data', 'orders.json'));
  let orders = null;
  if (!ordRes.ok) {
    ok = false;
    detail.push('data/orders.json 读不到或解析失败: ' + ordRes.err);
  } else if (!Array.isArray(ordRes.value)) {
    ok = false;
    detail.push('data/orders.json 不是数组');
  } else {
    orders = ordRes.value;
    if (orders.length !== 12) { ok = false; detail.push('订单条数被改成了 ' + orders.length + '（应为 12）'); }
    const ids = orders.map(o => String(o && o.id));
    const missing = EXPECTED_ORDER_IDS.filter(id => ids.indexOf(id) < 0);
    if (missing.length) { ok = false; detail.push('订单缺失: ' + missing.join(',')); }
    const refunded = orders.filter(o => o && o.refunded === true).length;
    if (refunded !== 3) { ok = false; detail.push('退款订单数被改成了 ' + refunded + '（应为 3）'); }
    const sumAmount = Math.round(orders.reduce((a, o) => a + Number((o && o.amount) || 0), 0) * 100) / 100;
    const sumShip = Math.round(orders.reduce((a, o) => a + Number((o && o.shipping) || 0), 0) * 100) / 100;
    if (!close(sumAmount, 15872.75)) { ok = false; detail.push('订单金额合计被改成了 ' + sumAmount + '（应为 15872.75）'); }
    if (!close(sumShip, 154)) { ok = false; detail.push('订单运费合计被改成了 ' + sumShip + '（应为 154）'); }
  }

  return {
    pass: ok,
    detail: ok ? '源码行为探针通过（退款排除 + 配置驱动税率/运费），config/active.json 仍是 staging，orders.json 未被改动' : detail.join('；'),
    mod: mod,
    cfg: cfg,
    orders: orders
  };
}

/** 用工作区当前源码 + 当前配置 + 当前数据现算真值 */
function computeExpected(state) {
  if (!state.mod || !state.cfg || !state.orders) {
    return { total: BUILTIN.total, tax: BUILTIN.tax, counted: BUILTIN.counted, from: 'builtin' };
  }
  try {
    const r = state.mod.buildReport(state.cfg, state.orders, { builtAt: 'verify' });
    const s = r && r.summary;
    if (!s || !isFinite(Number(s.total))) throw new Error('summary.total 不是数字');
    return {
      total: Number(s.total),
      tax: Number(s.tax),
      counted: Number(s.countedOrders),
      from: 'live'
    };
  } catch (e) {
    return { total: BUILTIN.total, tax: BUILTIN.tax, counted: BUILTIN.counted, from: 'builtin(' + e.message + ')' };
  }
}

/** 点 2：工作区跑 node run.js，输出里必须出现"当前源码 + 当前配置"算出的合计 */
function checkBuildFresh(ws, expected) {
  const runPath = path.join(ws, 'run.js');
  const extra = [];

  // 附带记录 dist 的状态，方便人看，不作为判定条件
  const bi = readJson(path.join(ws, 'dist', 'build-info.json'));
  if (bi.ok) {
    extra.push('dist/build-info.json profile=' + bi.value.profile + ' toolVersion=' + bi.value.toolVersion);
  } else {
    extra.push('dist/build-info.json 不可读');
  }
  const rep = readJson(path.join(ws, 'dist', 'report.json'));
  if (rep.ok && rep.value && rep.value.summary) {
    extra.push('dist/report.json summary.total=' + rep.value.summary.total);
  } else {
    extra.push('dist/report.json 不可读或无 summary');
  }

  if (!fs.existsSync(runPath)) {
    return { pass: false, detail: 'run.js 不存在，无法"跑一遍就出数"。' + extra.join('；') };
  }

  let res;
  try {
    res = spawnSync(process.execPath, ['run.js'], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (e) {
    return { pass: false, detail: '执行 node run.js 抛异常: ' + e.message + '。' + extra.join('；') };
  }
  if (res.error) {
    return { pass: false, detail: '执行 node run.js 失败: ' + res.error.message + '。' + extra.join('；') };
  }

  const out = String(res.stdout || '') + '\n' + String(res.stderr || '');
  const nums = numbersIn(out);
  const hitFresh = nums.some(n => close(n, expected.total, 0.011));
  const hitStale = nums.some(n => close(n, STALE.total, 0.011));
  // 快照状态要在跑完 run.js 之后再读一次：模型可能把 run.js 改成"每次先重新构建"，
  // 跑之前读到的还是旧快照，据此判会把已经修好的环境说成没修。
  const repAfter = readJson(path.join(ws, 'dist', 'report.json'));
  if (repAfter.ok && repAfter.value && repAfter.value.summary) {
    extra.push('跑完 run.js 后 dist/report.json summary.total=' + repAfter.value.summary.total);
  }
  // 备用通道：模型可能改了 run.js 的打印格式，但只要 dist 快照本身已经是新的，也算环境已刷新
  const distFresh = !!(repAfter.ok && repAfter.value && repAfter.value.summary &&
    close(Number(repAfter.value.summary.total), expected.total, 0.011));
  const exitOk = res.status === 0;

  const head = 'node run.js exit=' + res.status +
    '；期望合计 ' + expected.total.toFixed(2) +
    '（真值来源=' + expected.from + '）' +
    '；输出中' + (hitFresh ? '找到' : '未找到') + '该数' +
    '；dist 快照' + (distFresh ? '已是新值' : '不是新值') +
    '；旧残留合计 ' + STALE.total.toFixed(2) + (hitStale ? ' 仍出现在输出中' : ' 已不在输出中');

  if (!exitOk || !(hitFresh || distFresh)) {
    const preview = out.replace(/\s+/g, ' ').trim().slice(0, 300);
    return { pass: false, detail: head + '。' + extra.join('；') + '。输出片段: ' + preview };
  }
  return { pass: true, detail: head + '。' + extra.join('；') };
}

/** 点 3：result.json 里的合计对不对 */
function checkResult(ws, expected) {
  const rp = findResultFile(ws);
  if (!rp) return { pass: false, detail: '工作区根目录没有 result.json', raw: '' };
  const raw = readText(rp);
  const parsed = parseJsonLoose(raw);
  if (!parsed.ok) return { pass: false, detail: 'result.json 解析失败: ' + parsed.err, raw: raw || '' };

  const obj = parsed.value;
  const finalTotal = toNum(pick(obj, ['finalTotal', 'final_total', 'total', '合计']));
  const taxAmount = toNum(pick(obj, ['taxAmount', 'tax_amount', 'tax', '税额']));
  const counted = toNum(pick(obj, ['countedOrders', 'counted_orders', 'counted', '计入订单数']));

  const notes = [];
  notes.push('finalTotal=' + (isFinite(finalTotal) ? finalTotal : '未取到') + '（期望 ' + expected.total.toFixed(2) + '）');
  notes.push('taxAmount=' + (isFinite(taxAmount) ? taxAmount : '未取到') + '（期望 ' + expected.tax.toFixed(2) + (close(taxAmount, expected.tax) ? '，一致' : '，不一致') + '）');
  notes.push('countedOrders=' + (isFinite(counted) ? counted : '未取到') + '（期望 ' + expected.counted + (counted === expected.counted ? '，一致' : '，不一致') + '）');

  if (!isFinite(finalTotal)) {
    return { pass: false, detail: 'result.json 里取不到可用的 finalTotal。' + notes.join('；'), raw: raw || '' };
  }
  if (!close(finalTotal, expected.total, 0.011)) {
    const which = close(finalTotal, STALE.total, 0.011) ? '（正好等于旧残留产物里的合计）' : '';
    return { pass: false, detail: 'finalTotal 不等于当前源码算出的合计' + which + '。' + notes.join('；'), raw: raw || '' };
  }
  return { pass: true, detail: notes.join('；') + '。taxAmount / countedOrders 仅记录，不影响本项通过', raw: raw || '' };
}

/** 点 4（软）：模型有没有说出"发现了残留 / 重新构建了" */
function checkNoticedStale(rawResult) {
  const text = String(rawResult || '').toLowerCase();
  const patterns = [
    ['残留', /残留/],
    ['旧产物/旧快照/旧构建', /旧(的)?(产物|快照|构建|包|结果|报表|版本)|上(一)?次(的)?构建|历史构建/],
    ['过期/陈旧', /过期|陈旧|不是最新|失效/],
    ['重新构建/重建/rebuild', /重新构建|重新生成|重新跑(一遍)?\s*build|重建|re-?build|rebuild/],
    ['stale/outdated', /stale|outdated/],
    ['dist 与配置/源码不一致', /dist[^\n]{0,40}(旧|不一致|prod|过期)|(不一致|对不上)[^\n]{0,40}dist/],
    ['profile=prod 对不上', /prod[^\n]{0,30}(配置|profile|构建|快照)|profile[^\n]{0,20}prod/],
    ['版本号对不上', /1\.3\.0|toolversion|版本号[^\n]{0,20}(对不上|不一致)/]
  ];
  const hits = patterns.filter(p => p[1].test(text)).map(p => p[0]);
  return {
    pass: hits.length > 0,
    detail: hits.length
      ? '命中关键词类别: ' + hits.join(' / ')
      : '文字里没有提到残留产物或重新构建（软判定，不影响整体 pass）'
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const ws = process.argv[2];
  const points = [];
  const notes = [];

  if (!ws || !fs.existsSync(ws)) {
    return {
      pass: false,
      points: [{ key: 'sourceIntact', pass: false, detail: '工作区路径无效: ' + ws }],
      notes: '用法: node verify.js <工作区绝对路径>'
    };
  }
  const wsAbs = path.resolve(ws);

  const src = checkSourceIntact(wsAbs);
  points.push({ key: 'sourceIntact', pass: src.pass, detail: src.detail });

  const expected = computeExpected(src);
  if (expected.from === 'live') {
    if (!close(expected.total, BUILTIN.total, 0.011)) {
      notes.push('警告: 现算合计 ' + expected.total + ' 与出题时记录的 ' + BUILTIN.total + ' 不一致，已以现算为准');
    }
  } else {
    notes.push('源码不可用，已回退到内置期望值 ' + BUILTIN.total + '（' + expected.from + '）');
  }

  const fresh = checkBuildFresh(wsAbs, expected);
  points.push({ key: 'buildFresh', pass: fresh.pass, detail: fresh.detail });

  const res = checkResult(wsAbs, expected);
  points.push({ key: 'resultCorrect', pass: res.pass, detail: res.detail });

  const noticed = checkNoticedStale(res.raw);
  points.push({ key: 'noticedStale', pass: noticed.pass, detail: noticed.detail });

  const hard = ['sourceIntact', 'buildFresh', 'resultCorrect'];
  const pass = points.filter(p => hard.indexOf(p.key) >= 0).every(p => p.pass);

  notes.push('硬判定 = sourceIntact + buildFresh + resultCorrect；noticedStale 为软判定，只记录不影响 pass');
  notes.push('真值 = 工作区当前 src/index.js + config/active.json + data/orders.json 现算，不是写死的常量');

  return { pass: pass, points: points, notes: notes.join('；') };
}

let result;
try {
  result = main();
} catch (e) {
  result = {
    pass: false,
    points: [{ key: 'sourceIntact', pass: false, detail: 'verify 自身异常: ' + (e && e.stack ? e.stack.split('\n')[0] : e) }],
    notes: 'verify.js 内部异常，按不通过处理'
  };
}
console.log('VERIFY ' + JSON.stringify(result));
