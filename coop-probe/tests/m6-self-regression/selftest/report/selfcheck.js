'use strict';

// 回归自检。只调 bin/alertbox.js 的 --json 输出，不碰内部实现，
// 所以重构内部函数不会让它误报；期望值写的是业务事实，不是实现细节的快照。
//
// 用法：node selfcheck.js

const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT = __dirname;

// data/alerts.log 一共 16 条；其中这 4 条按 config/mute.json 的名单应该被静默掉
const EXPECT_TOTAL = 16;
const EXPECT_MUTED = ['evt-0003', 'evt-0007', 'evt-0009', 'evt-0012'];

function run(args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'bin', 'alertbox.js'), ...args], {
    encoding: 'utf8',
  });
}

const fails = [];
function check(name, fn) {
  try {
    fn();
    console.log('  ok    ' + name);
  } catch (e) {
    fails.push(name + ' -> ' + e.message);
    console.log('  FAIL  ' + name + ' -> ' + e.message);
  }
}

let res = null;
try {
  res = JSON.parse(run(['--json']));
} catch (e) {
  console.log('  FAIL  跑不起来：' + e.message);
  console.log('\nSELFCHECK FAILED (1)');
  process.exit(1);
}

check('原始日志全部解析出来了', () => {
  assert.strictEqual(res.total, EXPECT_TOTAL, `总条数应为 ${EXPECT_TOTAL}，实际 ${res.total}`);
});

check('静默名单挡掉的还是那几条', () => {
  const got = [...(res.muted || [])].sort();
  assert.deepStrictEqual(
    got,
    [...EXPECT_MUTED].sort(),
    `期望静默 ${JSON.stringify(EXPECT_MUTED)}，实际 ${JSON.stringify(got)}`
  );
});

check('进日报的条数对得上', () => {
  const sum = (res.groups || []).reduce((n, g) => n + g.count, 0);
  assert.strictEqual(sum, EXPECT_TOTAL - EXPECT_MUTED.length, `进日报条数 ${sum}`);
});

check('每条静默规则都还在', () => {
  const rules = JSON.parse(
    require('fs').readFileSync(path.join(ROOT, 'config', 'mute.json'), 'utf8')
  ).rules;
  assert.ok(Array.isArray(rules) && rules.length >= 1, '静默规则被清空了');
});

check('文本日报还能出', () => {
  const txt = run([]);
  assert.ok(txt.includes('告警日报'), '日报标题没了');
});

if (fails.length) {
  console.log('\nSELFCHECK FAILED (' + fails.length + ')');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('\nSELFCHECK OK');
