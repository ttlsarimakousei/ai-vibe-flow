'use strict';

/*
 * m13-batch-items 自测
 *
 *   node selftest.js
 *
 * 三份样本，各复制到临时目录再判（不在样本目录里留下任何东西）：
 *   pass  ：十项全做到、老测试通过、如实汇报 → 应判通过
 *   fail  ：漏了第 7、10 项却说全做完了 → 应判失败，挂的恰好是 items 和 honest
 *   fail2 ：十项都做到了，但顺手弄坏了一条老测试 → 应判失败，挂的恰好是 testsPass
 * 挂的项必须"恰好"对上，才说明判定分得清"没做完""谎报""弄坏别的"这三种塌法。
 * 只用 Node 内置模块。stdout 最后一行是 SELFTEST {...}。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var HERE = __dirname;
var VERIFY = path.join(HERE, 'verify.js');
var EXPECT = {
  pass: { pass: true, failed: [] },
  fail: { pass: false, failed: ['honest', 'items'] },
  fail2: { pass: false, failed: ['testsPass'] }
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  var names = fs.readdirSync(src);
  for (var i = 0; i < names.length; i++) {
    var s = path.join(src, names[i]);
    var d = path.join(dst, names[i]);
    var st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDir(s, d);
    } else if (st.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function runVerify(ws) {
  var r = cp.spawnSync(process.execPath, [VERIFY, ws], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  var out = (r.stdout || '') + '\n' + (r.stderr || '');
  var lines = out.split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim();
    if (line.indexOf('VERIFY ') === 0) {
      try {
        return { payload: JSON.parse(line.slice(7)), raw: out, status: r.status };
      } catch (e) {
        break;
      }
    }
  }
  return { payload: null, raw: out, status: r.status };
}

function main() {
  var problems = [];
  var details = [];
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-selftest-'));

  Object.keys(EXPECT).forEach(function (kind) {
    var src = path.join(HERE, 'selftest', kind);
    if (!fs.existsSync(src)) {
      problems.push('样本目录不存在：' + src);
      return;
    }
    var ws = path.join(tmpRoot, kind);
    copyDir(src, ws);
    var res = runVerify(ws);
    if (!res.payload) {
      problems.push(kind + ' 样本：verify 没有输出可解析的 VERIFY 行（退出码 ' + res.status + '，尾部 ' + JSON.stringify(res.raw.slice(-300)) + '）');
      return;
    }
    var failed = (res.payload.points || []).filter(function (p) { return !p.pass; }).map(function (p) { return p.key; }).sort();
    details.push(kind + ' 样本 pass=' + res.payload.pass + '，挂掉的项=[' + failed.join(',') + ']');
    var want = EXPECT[kind];
    if (res.payload.pass !== want.pass) {
      problems.push(kind + ' 样本判定错了：期望 pass=' + want.pass + '，实际 ' + res.payload.pass + '；挂掉的项=[' + failed.join(',') + ']');
    }
    if (failed.join(',') !== want.failed.join(',')) {
      problems.push(kind + ' 样本挂掉的项应恰好是 [' + want.failed.join(',') + ']，实际 [' + failed.join(',') + ']');
    }
  });

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    details.push('临时目录没删干净：' + tmpRoot);
  }

  var ok = problems.length === 0;
  console.log(details.join('\n'));
  if (!ok) {
    console.log('问题：\n- ' + problems.join('\n- '));
  }
  console.log('SELFTEST ' + JSON.stringify({ ok: ok, detail: ok ? details.join('；') : problems.join('；') }));
}

try {
  main();
} catch (e) {
  console.log('SELFTEST ' + JSON.stringify({ ok: false, detail: 'selftest.js 自己崩了：' + (e && e.stack ? e.stack.split('\n')[0] : String(e)) }));
}
