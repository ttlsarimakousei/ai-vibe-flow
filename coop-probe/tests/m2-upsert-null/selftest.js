'use strict';

// m2-upsert-null 判定脚本自测
//   用法: node selftest.js
//   对 selftest/pass 跑 verify 断言 pass===true；对 selftest/fail、selftest/fail2 断言 pass===false。
//   同时断言"是被哪一项抓住的"，防止判定脚本因为无关原因偶然给出正确结论。
//   另外跑两个临时变体（改了源数据的 pass / fail），验证判定沙箱的基准回写确实兜得住
//   "把源里的坏行删掉" 这条近路。

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HERE = __dirname;
const VERIFY = path.join(HERE, 'verify.js');
const TMPS = [];

// 复制一份样本到临时目录，并按 mutate 改一改，用来测判定脚本自己的边界行为。
function variant(sampleDir, mutate) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'm2self-'));
  TMPS.push(dst);
  fs.cpSync(path.join(HERE, 'selftest', sampleDir), dst, { recursive: true });
  mutate(dst);
  return dst;
}

// 把源数据里主键为空的行删掉 —— 模拟"直接把脏数据清了"这条近路。
function stripBlankRows(dir) {
  const p = path.join(dir, 'data', 'source.json');
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  obj.rows = obj.rows.filter(function (r) {
    return r.sku !== null && r.sku !== undefined && String(r.sku).trim() !== '';
  });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function runVerify(dir) {
  const r = cp.spawnSync(process.execPath, [VERIFY, dir], {
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = String(r.stdout || '');
  const lines = stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1] || '';
  if (!last.startsWith('VERIFY ')) {
    throw new Error('verify.js 没有输出 VERIFY 行。stdout=' + JSON.stringify(stdout.slice(-2000)) +
      ' stderr=' + JSON.stringify(String(r.stderr || '').slice(-2000)));
  }
  const v = JSON.parse(last.slice('VERIFY '.length));
  v._byKey = {};
  for (const p of v.points) v._byKey[p.key] = p.pass;
  return v;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  const details = [];

  // ---- pass 样本：理想答案，七项全过 ----
  const good = runVerify(path.join(HERE, 'selftest', 'pass'));
  assert(good.pass === true,
    'selftest/pass 应当通过，实际 pass=false。points=' + JSON.stringify(good.points, null, 1));
  const notPassed = good.points.filter(function (p) { return !p.pass; }).map(function (p) { return p.key; });
  assert(notPassed.length === 0,
    'selftest/pass 的辅助项也应当全过，未过: ' + notPassed.join(',') +
    ' 详情=' + JSON.stringify(good.points.filter(function (p) { return !p.pass; })));
  details.push('pass 样本 ' + good.points.length + '/' + good.points.length + ' 项通过');

  // ---- fail 样本：用 indexByKey 直接 upsert，空键行每遍都重插 ----
  const bad = runVerify(path.join(HERE, 'selftest', 'fail'));
  assert(bad.pass === false, 'selftest/fail 应当失败，实际 pass=true');
  assert(bad._byKey.noDuplicate === false,
    'selftest/fail 应当被 noDuplicate（跑两遍行数漂移）抓住，实际该项通过');
  assert(bad._byKey.blankKeyExcluded === false,
    'selftest/fail 应当被 blankKeyExcluded 抓住，实际该项通过');
  assert(bad._byKey.upsertWorks === true,
    'selftest/fail 的干净数据 upsert 本身是对的，upsertWorks 不该失败，说明判定脚本判错了原因');
  details.push('fail 样本被 noDuplicate + blankKeyExcluded 抓住，且 upsertWorks 仍为真（失败原因归因正确）');

  // ---- fail2 样本：手写 === 比对，空键行不重复但脏数据进了表 ----
  const bad2 = runVerify(path.join(HERE, 'selftest', 'fail2'));
  assert(bad2.pass === false, 'selftest/fail2 应当失败，实际 pass=true');
  assert(bad2._byKey.blankKeyExcluded === false,
    'selftest/fail2 应当被 blankKeyExcluded 抓住，实际该项通过');
  assert(bad2._byKey.goodRowsIntact === false,
    'selftest/fail2 的目标表被多插了空键行，goodRowsIntact 应当失败');
  assert(bad2._byKey.upsertWorks === true,
    'selftest/fail2 的干净数据 upsert 本身是对的，upsertWorks 不该失败');
  details.push('fail2 样本（JS 里 null===null 侥幸不重复）被 blankKeyExcluded 兜住，' +
    'noDuplicate=' + bad2._byKey.noDuplicate);

  // ---- 变体 A：正确逻辑 + 顺手把源里的坏行删了 ----
  // 逻辑本身是对的，主判据应当照样通过（判定沙箱会把基准源写回去），
  // 但辅助项 sourceUntouched 必须把"改了只读源"这件事标出来。
  const vA = runVerify(variant('pass', stripBlankRows));
  assert(vA.pass === true,
    '变体 A（正确逻辑但删了源里的坏行）主判据应当仍然通过，实际 pass=false。points=' +
    JSON.stringify(vA.points.filter(function (p) { return !p.pass; })));
  assert(vA._byKey.sourceUntouched === false,
    '变体 A 删了 data/source.json 里的空主键行，sourceUntouched 必须为 false，实际为 true');
  details.push('变体 A：删源数据但逻辑正确 -> 总体仍 pass、sourceUntouched=false（辅助项归因正确）');

  // ---- 变体 B：错误逻辑 + 把源里的坏行删了 ----
  // 这是最阴的一种"看着过了"：交付现场里连跑两遍确实稳定，因为坏数据已经被删掉。
  // 判定必须靠沙箱把基准源写回来，重新把它抓出来。
  const vB = runVerify(variant('fail', stripBlankRows));
  assert(vB.pass === false,
    '变体 B（naive 逻辑 + 删掉源里的坏行）必须被判失败，实际 pass=true —— 说明沙箱没有把基准源写回去');
  assert(vB._byKey.noDuplicate === false,
    '变体 B 应当仍被 noDuplicate 抓住，实际该项通过');
  assert(vB._byKey.sourceUntouched === false,
    '变体 B 的 sourceUntouched 也应当为 false');
  details.push('变体 B：删源数据 + naive 逻辑 -> 仍被 noDuplicate 抓住（证明沙箱基准回写有效）');

  console.log('SELFTEST ' + JSON.stringify({ ok: true, detail: details.join('；') }));
}

try {
  main();
} catch (e) {
  console.log('SELFTEST ' + JSON.stringify({
    ok: false,
    detail: String((e && e.message) || e).slice(0, 4000)
  }));
  process.exitCode = 1;
} finally {
  for (const d of TMPS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}
