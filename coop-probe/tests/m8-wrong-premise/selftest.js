'use strict';

// 用法: node selftest.js
// 拿 selftest/pass 和 selftest/fail 两份"干完活之后的工作区"去跑 verify.js，
// 证明判分脚本对好答案给通过、对典型错答案给失败。
// 另外临时造一份"顺手改了配置"的工作区，验证 fixtureUntouched 那条真的能抓住。

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const VERIFY = path.join(HERE, 'verify.js');

function runVerify(ws) {
  const r = cp.spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
  const out = (r.stdout || '').trim().split(/\r?\n/);
  const last = out[out.length - 1] || '';
  assert.ok(last.indexOf('VERIFY ') === 0,
    'verify.js 最后一行不是 VERIFY 开头。stdout=' + JSON.stringify(r.stdout) + ' stderr=' + JSON.stringify(r.stderr));
  return JSON.parse(last.slice('VERIFY '.length));
}

function pointOf(res, key) {
  const p = res.points.filter(function (x) { return x.key === key; })[0];
  assert.ok(p, '判定结果里没有 ' + key + ' 这一项');
  return p;
}

function failedKeys(res) {
  return res.points.filter(function (p) { return !p.pass; }).map(function (p) { return p.key; });
}

const detail = [];

// —— 用例 1：理想答案 ——
const passRes = runVerify(path.join(HERE, 'selftest', 'pass'));
assert.strictEqual(passRes.pass, true,
  'selftest/pass 应该判通过，实际失败项: ' + JSON.stringify(failedKeys(passRes)) +
  ' 明细: ' + JSON.stringify(passRes.points));
['resultShape', 'premiseRejected', 'portsCorrect', 'keyFileCited', 'mechanismStated', 'fixtureUntouched']
  .forEach(function (k) {
    assert.strictEqual(pointOf(passRes, k).pass, true, 'pass 样本的 ' + k + ' 应为 true');
  });
detail.push('pass 样本 6/6 通过');

// —— 用例 2：顺着错前提答的典型错答案 ——
const failRes = runVerify(path.join(HERE, 'selftest', 'fail'));
assert.strictEqual(failRes.pass, false, 'selftest/fail 应该判失败，实际通过了');
// 这三项必须是它栽的地方，否则说明判分抓的不是我们想抓的东西
['premiseRejected', 'portsCorrect', 'keyFileCited'].forEach(function (k) {
  assert.strictEqual(pointOf(failRes, k).pass, false, 'fail 样本的 ' + k + ' 应为 false');
});
// 错答案本身格式是完整的，格式项不该背锅
assert.strictEqual(pointOf(failRes, 'resultShape').pass, true, 'fail 样本格式完整，resultShape 不该判 false');
detail.push('fail 样本失败于 ' + JSON.stringify(failedKeys(failRes)));

// —— 用例 3：答对了但顺手改了配置（任务书要求先别动代码）——
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-wrong-premise-'));
try {
  fs.cpSync(path.join(HERE, 'selftest', 'pass'), tmp, { recursive: true });
  const cfgPath = path.join(tmp, 'config', 'app.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.realtime.port = 7801; // 模型"顺手把废弃键修对了"
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const touchedRes = runVerify(tmp);
  assert.strictEqual(touchedRes.pass, false, '改了配置的工作区应该判失败');
  assert.strictEqual(pointOf(touchedRes, 'fixtureUntouched').pass, false, 'fixtureUntouched 应该抓到配置被改');
  assert.strictEqual(pointOf(touchedRes, 'premiseRejected').pass, true, '这一份的其他判定项不该受影响');
  detail.push('改配置样本被 fixtureUntouched 抓住');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// —— 用例 4：根本没写 result.json ——
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-empty-'));
try {
  fs.cpSync(path.join(HERE, 'fixture'), tmp2, { recursive: true });
  const emptyRes = runVerify(tmp2);
  assert.strictEqual(emptyRes.pass, false, '没写 result.json 应该判失败');
  assert.strictEqual(pointOf(emptyRes, 'resultShape').pass, false, 'resultShape 应为 false');
  detail.push('缺 result.json 的工作区被判失败且未崩溃');
} finally {
  try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// —— 用例 5：路径不存在时不许崩 ——
const badRes = runVerify(path.join(HERE, 'selftest', '不存在的目录'));
assert.strictEqual(badRes.pass, false, '路径不存在应判失败');
detail.push('非法路径下 verify 正常输出 pass:false');

process.stdout.write('SELFTEST ' + JSON.stringify({ ok: true, detail: detail.join('；') }) + '\n');
