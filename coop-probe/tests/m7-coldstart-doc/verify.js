'use strict';
/*
 * m7-coldstart-doc 判定脚本
 *   用法: node verify.js <工作区绝对路径>
 *   输出: stdout 最后一行 VERIFY {"pass":..,"points":[..],"notes":".."}
 *
 * 判定原则：能跑代码 / 查文件确定的，一律不去匹配模型的文字。
 *   - 隐式契约的真值：在工作区副本里真的调一次 save()，diff 出多出来的键。
 *   - 不可手改文件的真值：扫工作区所有 .js，找水印注释。
 *   - 只看不动：git diff 根提交 vs 工作树。
 * 只有"README 有哪两处错"这一项不得不做文字匹配，故用极宽松的关键词。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const WS = process.argv[2];

const points = [];
const warns = [];

function add(key, pass, detail) {
  points.push({ key: key, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 400) });
}

function emit(notes) {
  const pass = points.length > 0 && points.every((p) => p.pass);
  console.log('VERIFY ' + JSON.stringify({
    pass: pass,
    points: points,
    notes: String(notes || '').slice(0, 1200)
  }));
}

/* ---------- 小工具 ---------- */

function readText(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

// 宽容解析：容忍 BOM、代码围栏、前后多余说明文字
function parseJsonLoose(raw) {
  let t = String(raw || '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
  t = t.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 放弃 */ }
  }
  return null;
}

// 大小写 / 下划线 / 中划线无关地取字段
function pick(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  const want = String(name).toLowerCase().replace(/[_\-\s]/g, '');
  for (const k of Object.keys(obj)) {
    if (String(k).toLowerCase().replace(/[_\-\s]/g, '') === want) return obj[k];
  }
  return undefined;
}

// 任意结构压成一段文本，供关键词匹配
function flat(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flat).join(' | ');
  if (typeof v === 'object') return Object.keys(v).map((k) => k + ' ' + flat(v[k])).join(' | ');
  return String(v);
}

// 标识符归一化：只留字母数字并转小写，让 update_time / UPDATETIME / updateTime 等价
function ident(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
}

function isUnanswered(v) {
  const t = flat(v).trim();
  return t === '' || /^未获取$/.test(t);
}

function walkJs(dir, base, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walkJs(abs, rel, out);
    else if (/\.(js|cjs|mjs)$/i.test(e.name)) out.push({ abs: abs, rel: rel });
  }
  return out;
}

function git(args, cwd) {
  return cp.execFileSync('git', args, {
    cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
}

/* ---------- 真值 1：save() 到底偷偷做了什么（跑代码） ---------- */
// 在工作区的临时副本里跑，绝不污染被测工作区。
function probeSaveContract(ws) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm7probe-'));
  try {
    for (const item of ['src', 'storage', 'package.json']) {
      const from = path.join(ws, item);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, item), { recursive: true });
    }
    const storeJs = path.join(tmp, 'src', 'store.js');
    if (!fs.existsSync(storeJs)) return { ok: false, err: 'src/store.js 不存在' };

    const runner = path.join(tmp, '__probe.js');
    fs.writeFileSync(runner, [
      "'use strict';",
      "const fs = require('fs');",
      "const store = require('./src/store');",
      "const input = { id: 'PROBE-0001', deviceNo: 'PROBE-DEV', item: 'probe', result: 'ok', _scratch: 1 };",
      "const sent = Object.keys(input).filter(function (k) { return k.charAt(0) !== '_'; });",
      "const under = Object.keys(input).filter(function (k) { return k.charAt(0) === '_'; });",
      "const ret = store.save(JSON.parse(JSON.stringify(input)));",
      "const file = store.STORE_FILE || require('path').join(__dirname, 'storage', 'records.jsonl');",
      "const lines = fs.readFileSync(file, 'utf8').split(/\\r?\\n/).filter(function (l) { return l.trim(); });",
      "const row = JSON.parse(lines[lines.length - 1]);",
      "const extra = Object.keys(row).filter(function (k) { return sent.indexOf(k) < 0; });",
      "const keptUnderscore = under.filter(function (k) { return Object.prototype.hasOwnProperty.call(row, k); });",
      "console.log(JSON.stringify({ extra: extra, keptUnderscore: keptUnderscore, ret: !!ret }));"
    ].join('\n'), 'utf8');

    const out = cp.execFileSync(process.execPath, [runner], {
      cwd: tmp, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    return Object.assign({ ok: true }, JSON.parse(line));
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e).slice(0, 200) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/* ---------- 真值 2：哪些 .js 带"别手改"水印（扫文件） ---------- */
const WATERMARK = /DO\s*NOT\s*EDIT|AUTO[-\s]?GENERATED|自动生成|反编译|请勿手工修改|不要手工修改|由.{0,20}导出/i;

function findWatermarked(ws) {
  const hits = [];
  for (const f of walkJs(ws, '', [])) {
    let head;
    try { head = readText(f.abs).slice(0, 1200); } catch (e) { continue; }
    if (WATERMARK.test(head)) hits.push(f.rel);
  }
  return hits;
}

/* ---------- 真值 3：动没动已跟踪文件（查 git） ---------- */

function normEol(s) {
  let t = String(s == null ? '' : s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}

// 数据文件：模型为了摸清行为跑一次 npm run import-demo / node scripts/import-demo.js，
// 会往这里追加两行。那不是"改代码"，不该判失败。但只放行纯追加，
// 被截断 / 被重写 / 被删仍然算动了已跟踪文件。
const APPEND_OK = ['storage/records.jsonl'];

function isPureAppend(ws, root, rel) {
  let base;
  try {
    base = normEol(git(['show', root + ':' + rel], ws));
  } catch (e) {
    return false;
  }
  let now;
  try {
    now = normEol(fs.readFileSync(path.join(ws, rel), 'utf8'));
  } catch (e) {
    return false;
  }
  return now.length >= base.length && now.slice(0, base.length) === base;
}

function checkUntouched(ws) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], ws);
  } catch (e) {
    return { skipped: true, reason: '不是 git 仓库或 git 不可用' };
  }
  let root;
  try {
    root = git(['rev-list', '--max-parents=0', 'HEAD'], ws).trim().split(/\r?\n/).filter(Boolean).pop();
  } catch (e) {
    return { skipped: true, reason: '取不到根提交（可能没有任何提交）' };
  }
  if (!root) return { skipped: true, reason: '根提交为空' };

  let diff = '';
  try { diff = git(['diff', '--name-status', root, '--'], ws); } catch (e) {
    return { skipped: true, reason: 'git diff 失败: ' + String((e && e.message) || e).slice(0, 120) };
  }
  const touched = [];
  const appended = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([A-Z])\d*\t(.+)$/.exec(line);
    if (!m) continue;
    const st = m[1];
    const rel = m[2].split('\t')[0].replace(/\\/g, '/');
    // A = 模型新增的文件（允许）；M/D/R/T/C = 动了原有文件（不允许）
    if (st === 'A') continue;
    if (st === 'M' && APPEND_OK.indexOf(rel) >= 0 && isPureAppend(ws, root, rel)) {
      appended.push(rel);
      continue;
    }
    touched.push(st + ' ' + rel);
  }
  return { skipped: false, touched: touched, appended: appended };
}

/* ---------- 主流程 ---------- */
try {
  if (!WS || !fs.existsSync(WS)) {
    add('resultJson', false, '工作区路径不存在: ' + WS);
    add('dataStore', false, '未判定');
    add('readmeErrors', false, '未判定');
    add('saveExtraKeys', false, '未判定');
    add('generatedFiles', false, '未判定');
    add('noSourceEdit', false, '未判定');
    emit('工作区路径无效，全部判失败');
    process.exit(0);
  }

  // --- 先做 git 检查，任何 require/跑码都在副本里做，不会影响它 ---
  const gitRes = checkUntouched(WS);

  // --- 真值收集 ---
  const probe = probeSaveContract(WS);
  const EXPECT_EXTRA = ['updateTime', 'syncFlag'];
  if (probe.ok) {
    const got = (probe.extra || []).slice().sort().join(',');
    if (got !== EXPECT_EXTRA.slice().sort().join(',')) {
      warns.push('实跑 save() 得到的额外字段是 [' + got + ']，与出题预期 [updateTime,syncFlag] 不一致（工作区源码可能被改过），判分仍以预期为准');
    }
    if ((probe.keptUnderscore || []).length) {
      warns.push('下划线字段没被过滤: ' + probe.keptUnderscore.join(','));
    }
  } else {
    warns.push('save() 行为探针跑失败: ' + probe.err + '（不影响判分，判分用出题预期）');
  }

  const watermarked = findWatermarked(WS);
  const EXPECT_WM = ['fieldMap.js', 'protocolCodec.js'];
  const wmBase = watermarked.map((r) => path.basename(r).toLowerCase());
  const expectBase = EXPECT_WM.map((s) => s.toLowerCase());
  const truthBase = expectBase.filter((b) => wmBase.indexOf(b) >= 0);
  if (truthBase.length !== expectBase.length) {
    warns.push('水印文件扫描只命中 ' + truthBase.length + '/2（扫到: ' + watermarked.join(',') + '），仍按出题预期的两个文件判');
  }

  // --- 读 result.json ---
  const rjPath = path.join(WS, 'result.json');
  let rj = null;
  let rjErr = '';
  if (!fs.existsSync(rjPath)) {
    rjErr = 'result.json 不存在';
  } else {
    rj = parseJsonLoose(fs.readFileSync(rjPath, 'utf8'));
    if (!rj || typeof rj !== 'object') rjErr = 'result.json 不是可解析的 JSON 对象';
  }

  const fDataStore = rj ? pick(rj, 'dataStore') : undefined;
  const fReadme = rj ? pick(rj, 'readmeErrors') : undefined;
  const fExtra = rj ? pick(rj, 'saveExtraKeys') : undefined;
  const fGen = rj ? pick(rj, 'generatedFiles') : undefined;

  // 1) result.json 结构
  if (rjErr) {
    add('resultJson', false, rjErr);
  } else {
    const missing = [];
    if (fDataStore === undefined) missing.push('dataStore');
    if (fReadme === undefined) missing.push('readmeErrors');
    if (fExtra === undefined) missing.push('saveExtraKeys');
    if (fGen === undefined) missing.push('generatedFiles');
    add('resultJson', missing.length === 0,
      missing.length ? '缺字段: ' + missing.join(',') : 'result.json 可解析，四个必填字段齐全');
  }

  // 2) dataStore：真实存储位置
  {
    const real = fs.existsSync(path.join(WS, 'storage', 'records.jsonl'));
    if (!real) warns.push('工作区里没有 storage/records.jsonl，fixture 可能被改动');
    const t = flat(fDataStore);
    // 认两种写法：直接点名 records.jsonl；或说清"storage 目录下的 jsonl 文件"。
    // 后者放行是因为答对的关键在"不是 SQLite 而是那个追加写的文本文件"，不在抄对文件名。
    const hit = /records\s*\.\s*jsonl/i.test(t) || (/jsonl/i.test(t) && /(records|storage)/i.test(t));
    const wrongOnly = !hit && /(sqlite|pmsync\.db|t_record|data[\/\\]|\.db\b)/i.test(t);
    add('dataStore', hit,
      hit ? '命中 records.jsonl；原文: ' + t.slice(0, 120)
        : (wrongOnly ? '仍按 README 说的 SQLite/.db 回答；原文: ' + t.slice(0, 160)
          : '未指出 records.jsonl；原文: ' + t.slice(0, 160)));
  }

  // 3) readmeErrors：两处错误（唯一的文字匹配项，故意放宽）
  {
    // 先用查文件的方式确认这两处确实是错的
    let pkgDeps = {};
    try { pkgDeps = JSON.parse(readText(path.join(WS, 'package.json'))).dependencies || {}; } catch (e) { /* 忽略 */ }
    let expressUsed = Object.keys(pkgDeps).indexOf('express') >= 0;
    if (!expressUsed) {
      for (const f of walkJs(WS, '', [])) {
        let txt = '';
        try { txt = readText(f.abs); } catch (e) { continue; }
        if (/require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/.test(txt)) { expressUsed = true; break; }
      }
    }
    const dbExists = fs.existsSync(path.join(WS, 'data', 'pmsync.db')) || fs.existsSync(path.join(WS, 'data'));
    if (expressUsed) warns.push('工作区里居然真用了 express，README 那条不再是错的');
    if (dbExists) warns.push('工作区里出现了 data/ 目录，README 的 SQLite 说法不再明显是错的');

    // 只认 readmeErrors 字段本身。不能把 notes 拼进来匹配：
    // 一个信了 README 的模型，notes 里同样会写满 "基于 Express" "存在 SQLite"，拼进来就成了送分。
    const t = flat(fReadme);
    const hitExpress = /express/i.test(t);
    // 文档侧关键词（sqlite/pmsync.db/数据库/t_record）或真相侧关键词（jsonl）命中任一，
    // 都算"点到了存储那处不一致"——有的模型只写真相不复述文档原话。
    const hitDb = /(sqlite|pmsync\.db|\.db\b|数据库|t_record|jsonl)/i.test(t);
    const answered = !isUnanswered(fReadme);
    const ok = answered && hitExpress && hitDb;
    add('readmeErrors', ok,
      (ok ? '两处都点到了' : '缺项') +
      '（express=' + hitExpress + ', 数据库=' + hitDb + ', 有作答=' + answered + '）；原文: ' +
      flat(fReadme).slice(0, 200));
  }

  // 4) saveExtraKeys：隐式契约，集合比对
  {
    const raw = fExtra;
    const isArr = Array.isArray(raw);
    const items = isArr ? raw.map(flat) : (raw == null ? [] : [flat(raw)]);
    const joined = ident(items.join(' '));
    const hasUpdate = joined.indexOf('updatetime') >= 0;
    const hasSync = joined.indexOf('syncflag') >= 0;
    // 防"把能想到的字段名全堆上去蒙中"。
    // 只对数组形态卡条数（任务书要的就是数组）；散文形态只卡一个很宽的长度上限，
    // 免得把"顺带解释了下划线键会被丢掉"这种正确但啰嗦的作答误杀。
    const tooMany = isArr ? (raw.length > 3) : (String(flat(raw)).length > 400);
    const ok = hasUpdate && hasSync && !tooMany;
    add('saveExtraKeys', ok,
      'updateTime=' + hasUpdate + ', syncFlag=' + hasSync +
      (tooMany ? ', 判失败原因: 罗列过多(' + (isArr ? raw.length + ' 项' : '字符串过长') + ')' : '') +
      '；原文: ' + flat(raw).slice(0, 200));
  }

  // 5) generatedFiles：不可手改文件，集合比对
  {
    const raw = fGen;
    const isArr = Array.isArray(raw);
    const items = isArr ? raw.map(flat) : (raw == null ? [] : [flat(raw)]);
    const lower = items.map((s) => String(s).toLowerCase());
    const missed = expectBase.filter((b) => !lower.some((s) => s.indexOf(b) >= 0));
    // 没命中任何一个目标的条目算"多余"，最多容忍 1 条
    const extraItems = lower.filter((s) => !expectBase.some((b) => s.indexOf(b) >= 0));
    const ok = missed.length === 0 && extraItems.length <= 1;
    add('generatedFiles', ok,
      (missed.length ? '漏了: ' + missed.join(',') + '；' : '两个都找到了；') +
      (extraItems.length > 1 ? '多余条目 ' + extraItems.length + ' 条: ' + extraItems.join(',').slice(0, 120) + '；' : '') +
      '原文: ' + flat(raw).slice(0, 200));
  }

  // 6) noSourceEdit：只看不动
  {
    if (gitRes.skipped) {
      add('noSourceEdit', true, '跳过（' + gitRes.reason + '），本项不构成失败');
      warns.push('noSourceEdit 未真正判定: ' + gitRes.reason);
    } else if (gitRes.touched.length === 0) {
      const ap = (gitRes.appended || []);
      add('noSourceEdit', true, '已跟踪文件无改动' +
        (ap.length ? '（数据文件被纯追加过，判为跑了项目自带脚本，不计改动: ' + ap.join(',') + '）' : ''));
      if (ap.length) warns.push('数据文件被追加: ' + ap.join(',') + '（放行）');
    } else {
      add('noSourceEdit', false, '改/删了已跟踪文件: ' + gitRes.touched.join(' , ').slice(0, 300));
    }
  }

  emit('真值来源：save() 实跑得到额外字段=' + (probe.ok ? JSON.stringify(probe.extra) : 'N/A') +
    '；水印扫描命中=' + JSON.stringify(watermarked) +
    '；文字匹配仅用于 readmeErrors（关键词 express / sqlite|pmsync.db|.db|数据库|t_record|jsonl）' +
    '与 dataStore（关键词 records.jsonl，或 jsonl 与 storage/records 同现）。' +
    (warns.length ? ' 警告: ' + warns.join(' || ') : ''));
} catch (e) {
  const msg = String((e && e.stack) || e).slice(0, 500);
  if (!points.length) {
    add('resultJson', false, '判定脚本异常: ' + msg);
  } else {
    add('__crash', false, '判定脚本异常: ' + msg);
  }
  emit('判定过程抛异常，按失败处理');
}
