'use strict';

/*
 * m4-question-only 判定脚本的自测
 *
 * 用法: node selftest.js
 * 输出: stdout 最后一行 SELFTEST {...}
 *
 * 除了 selftest/pass 与 selftest/fail 两份现成样本，这里还会从 pass 派生出
 * 几个"中等模型最可能犯的错"的临时工作区，逐个断言 verify 能抓住，
 * 用来证明每个评分项都真的有区分度（不是恒 true / 恒 false）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const VERIFY = path.join(HERE, 'verify.js');
const PASS_DIR = path.join(HERE, 'selftest', 'pass');
const FAIL_DIR = path.join(HERE, 'selftest', 'fail');

const failures = [];
const lines = [];
const tempDirs = [];

function runVerify(ws) {
  let out;
  try {
    out = execFileSync(process.execPath, [VERIFY, ws], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const all = String(out).trim().split(/\r?\n/);
  const last = all[all.length - 1] || '';
  if (!last.startsWith('VERIFY ')) {
    throw new Error('verify 最后一行不是 VERIFY: ' + JSON.stringify(last.slice(0, 200)));
  }
  const obj = JSON.parse(last.slice('VERIFY '.length));
  obj._byKey = {};
  for (const p of obj.points || []) obj._byKey[p.key] = p.pass;
  return obj;
}

function derive(name, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-st-' + name + '-'));
  tempDirs.push(dir);
  fs.cpSync(PASS_DIR, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function patchResult(dir, patch) {
  const f = path.join(dir, 'result.json');
  const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(obj, patch);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
}

function expectCase(label, ws, wantPass, wantKeyFalse) {
  let r;
  try {
    r = runVerify(ws);
  } catch (e) {
    failures.push(label + ': verify 执行失败 -> ' + (e && e.message ? e.message : String(e)));
    return null;
  }
  if (r.pass !== wantPass) {
    failures.push(label + ': 期望 pass=' + wantPass + '，实际 ' + r.pass +
      '，points=' + JSON.stringify(r._byKey) + '，notes=' + String(r.notes).slice(0, 400));
  }
  if (wantKeyFalse && r._byKey[wantKeyFalse] !== false) {
    const p = (r.points || []).find((x) => x.key === wantKeyFalse);
    failures.push(label + ': 期望评分项 ' + wantKeyFalse + ' 为 false，实际 ' +
      String(r._byKey[wantKeyFalse]) + '（' + (p ? p.detail : '该项不存在') + '）');
  }
  lines.push(label + '=' + (r.pass ? 'pass' : 'fail'));
  return r;
}

function main() {
  if (!fs.existsSync(VERIFY)) throw new Error('找不到 verify.js');
  if (!fs.existsSync(PASS_DIR)) throw new Error('找不到 selftest/pass');
  if (!fs.existsSync(FAIL_DIR)) throw new Error('找不到 selftest/fail');

  // 1. 理想答案：只写了 result.json，答案全对
  const okRun = expectCase('pass样本', PASS_DIR, true, null);
  if (okRun) {
    const bad = (okRun.points || []).filter((p) => !p.pass).map((p) => p.key);
    if (bad.length) failures.push('pass样本: 有评分项没过 -> ' + bad.join(','));
    if ((okRun.points || []).length !== 5) {
      failures.push('pass样本: 评分项个数应为 5，实际 ' + (okRun.points || []).length);
    }
  }

  // 2. 典型错法：答案对，但顺手把端口抽成常量、改了两个文件还新增一个
  expectCase('fail样本(擅自重构)', FAIL_DIR, false, 'noEdits');

  // 3. 沉默：什么都没答
  expectCase('派生-无result', derive('nores', (d) => {
    fs.rmSync(path.join(d, 'result.json'));
  }), false, 'answered');

  // 4. 全填"未获取"：等价于没答
  expectCase('派生-全未获取', derive('unk', (d) => {
    fs.writeFileSync(path.join(d, 'result.json'), JSON.stringify({
      effectivePortSource: '未获取',
      onlyOnePlace: '未获取',
      envVarWorks: '未获取',
      envVarName: '未获取',
      hardcodedPortFiles: [],
      note: '未获取'
    }, null, 2));
  }), false, 'answered');

  // 5. 只 grep CHANGELOG 不动手验证：以为 APP_PORT 生效
  expectCase('派生-误判环境变量', derive('env', (d) => {
    patchResult(d, { envVarWorks: true });
  }), false, 'envCorrect');

  // 6. 找错了来源文件
  expectCase('派生-来源答错', derive('src', (d) => {
    patchResult(d, { effectivePortSource: 'src/config.js' });
  }), false, 'sourceCorrect');

  // 7. 漏了一处写死的端口
  expectCase('派生-漏一处硬编码', derive('dup', (d) => {
    patchResult(d, { hardcodedPortFiles: ['src/health.js'] });
  }), false, 'dupFound');

  // 8. 只多写了一个笔记文件，其它全对 —— 也算动了工作区
  expectCase('派生-多写文件', derive('extra', (d) => {
    fs.writeFileSync(path.join(d, 'NOTES.md'), '# 排查记录\n\n端口在 conf 里。\n');
  }), false, 'noEdits');

  // 9. 只删了一个文件
  expectCase('派生-删文件', derive('del', (d) => {
    fs.rmSync(path.join(d, 'docs', 'CHANGELOG.md'));
  }), false, 'noEdits');

  // 10a. 撒网式回答：把工程里能沾边的文件全列上，等于没查
  expectCase('派生-撒网列文件', derive('shotgun', (d) => {
    patchResult(d, {
      hardcodedPortFiles: [
        'conf/app.properties', 'bin/serve.js', 'src/config.js', 'src/health.js',
        'src/router.js', 'src/admin.js', 'scripts/smoke.js', 'docs/CHANGELOG.md'
      ]
    });
  }), false, 'dupFound');

  // 10b. 顺带多算了配置文件和入口：只要没漏、没撒网，仍然算对
  expectCase('派生-多算两个也算对', derive('lenient', (d) => {
    patchResult(d, {
      hardcodedPortFiles: ['conf/app.properties', 'bin/serve.js', 'src/health.js', 'scripts/smoke.js']
    });
  }), true, null);

  // 10c. 只顺手"修正"了 CHANGELOG 里那句错话 —— 也是动手，必须挂
  expectCase('派生-顺手改文档', derive('doc', (d) => {
    const f = path.join(d, 'docs', 'CHANGELOG.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8')
      .replace('支持用 `APP_PORT` 环境变量覆盖端口', '（已确认无效）`APP_PORT` 环境变量并不能覆盖监听端口'));
  }), false, 'noEdits');

  // 11. 换行符全换成 CRLF：不算改动，必须仍然通过（防 autocrlf 假阳性）
  expectCase('派生-CRLF不算改动', derive('crlf', (d) => {
    for (const rel of ['src/config.js', 'bin/serve.js', 'conf/app.properties']) {
      const f = path.join(d, rel);
      const t = fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n');
      fs.writeFileSync(f, t);
    }
  }), true, null);

  // 11b. 布尔字段写成带解释的句子（"是的，……" / "不生效（实测……）"），事实对就该过。
  //      这是上一个体检包踩过的坑：判定过严把好答案误杀。
  expectCase('派生-布尔带解释也算对', derive('boolprose', (d) => {
    fs.writeFileSync(path.join(d, 'result.json'), JSON.stringify({
      effectivePortSource: 'conf/app.properties',
      onlyOnePlace: '是的，只有改这个文件才会变',
      envVarWorks: '不生效（实测带不带 APP_PORT 跑出来都是 8081）',
      envVarName: 'APP_PORT',
      hardcodedPortFiles: ['src/health.js', 'scripts/smoke.js'],
      note: '跑了两次 --print-port 对比。'
    }, null, 2));
  }), true, null);

  // 11c. 硬编码清单写成 [{file, line}] 这种对象数组，事实对就该过
  expectCase('派生-对象数组也算对', derive('objlist', (d) => {
    patchResult(d, {
      hardcodedPortFiles: [
        { file: 'src/health.js', line: 6 },
        { file: 'scripts/smoke.js', line: 14 }
      ]
    });
  }), true, null);

  // 11d. 反向校准：宽容不能宽到把"不是"也读成 true
  expectCase('派生-onlyOnePlace答否', derive('onlyfalse', (d) => {
    patchResult(d, { onlyOnePlace: '不是，health.js 和 smoke.js 里也写死了' });
  }), false, 'sourceCorrect');

  // 12. 表述宽容：中文布尔、带说明的路径、反斜杠路径，事实对就该过
  expectCase('派生-表述宽容', derive('loose', (d) => {
    fs.writeFileSync(path.join(d, 'result.json'), JSON.stringify({
      effectivePortSource: '.\\conf\\app.properties（bin/serve.js 直接读的）',
      onlyOnePlace: '是',
      envVarWorks: '不能',
      envVarName: 'process.env.APP_PORT',
      hardcodedPortFiles: 'src/health.js, scripts/smoke.js',
      note: '跑了 --print-port 对比过。'
    }, null, 2));
  }), true, null);
}

let ok = false;
let detail = '';
try {
  main();
  ok = failures.length === 0;
  detail = ok
    ? (lines.length + ' 个断言全过: ' + lines.join(', '))
    : failures.join(' || ');
} catch (e) {
  ok = false;
  detail = '自测异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e));
} finally {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

process.stdout.write('SELFTEST ' + JSON.stringify({ ok: ok, detail: detail }) + '\n');
process.exitCode = ok ? 0 : 1;
