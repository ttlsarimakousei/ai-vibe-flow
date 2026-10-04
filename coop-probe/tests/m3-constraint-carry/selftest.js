'use strict';

/*
 * m3-constraint-carry 自测
 *
 *   node selftest.js
 *
 * 干三件事：
 *   1. 把 selftest/pass、selftest/fail 各复制一份到临时目录（避免 verify 跑脚本时
 *      在样本目录里落下 logs/ out/ 之类的产物），对副本跑 verify.js
 *   2. 断言 pass 样本 pass===true、fail 样本 pass===false
 *   3. 对 fail 样本额外断言"挂掉的项恰好只有 es5Clean" —— 这一条才是真正的区分点。
 *      如果 fail 样本连功能项都挂了，说明它是个废样本（分不清模型是没遵守约束还是没干活）
 *
 * 只用 Node 内置模块。stdout 最后一行是 SELFTEST {...}。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var HERE = __dirname;
var VERIFY = path.join(HERE, 'verify.js');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  var names = fs.readdirSync(src);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (n === '.git' || n === 'node_modules') {
      continue;
    }
    var s = path.join(src, n);
    var d = path.join(dst, n);
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
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  var out = (r.stdout || '') + '\n' + (r.stderr || '');
  var lines = out.split('\n');
  var payload = null;
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim();
    if (line.indexOf('VERIFY ') === 0) {
      try {
        payload = JSON.parse(line.slice('VERIFY '.length));
      } catch (e) {
        payload = null;
      }
      break;
    }
  }
  return { payload: payload, raw: out, status: r.status };
}

function failedKeys(payload) {
  if (!payload || !Array.isArray(payload.points)) {
    return ['<无 points>'];
  }
  return payload.points.filter(function (p) {
    return !p.pass;
  }).map(function (p) {
    return p.key;
  });
}

function main() {
  var problems = [];
  var details = [];
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-selftest-'));

  ['pass', 'fail'].forEach(function (kind) {
    var src = path.join(HERE, 'selftest', kind);
    if (!fs.existsSync(src)) {
      problems.push('样本目录不存在：' + src);
      return;
    }
    var ws = path.join(tmpRoot, kind);
    copyDir(src, ws);

    var res = runVerify(ws);
    if (!res.payload) {
      problems.push(kind + ' 样本：verify 没有输出可解析的 VERIFY 行（退出码 ' + res.status +
        '，尾部输出 ' + JSON.stringify(res.raw.slice(-400)) + '）');
      return;
    }

    var got = res.payload.pass === true;
    var want = (kind === 'pass');
    var fk = failedKeys(res.payload);
    details.push(kind + ' 样本 pass=' + got + '，挂掉的项=[' + fk.join(',') + ']');

    if (got !== want) {
      problems.push(kind + ' 样本判定错了：期望 pass=' + want + '，实际 ' + got +
        '；挂掉的项=[' + fk.join(',') + ']；notes=' + (res.payload.notes || ''));
    }

    if (kind === 'fail') {
      // fail 样本的功能是对的，只有 ES5 约束没带过来 —— 挂的项必须恰好是 es5Clean
      if (!(fk.length === 1 && fk[0] === 'es5Clean')) {
        problems.push('fail 样本不是"只挂 es5Clean"：实际挂了 [' + fk.join(',') +
          ']。这说明它区分不出"没遵守硬约束"和"根本没干成活"');
      }
    }

    if (kind === 'pass') {
      var n = (res.payload.points || []).length;
      if (n < 4) {
        problems.push('pass 样本的判定项只有 ' + n + ' 条，少于预期的 4 条');
      }
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
  console.log('SELFTEST ' + JSON.stringify({
    ok: ok,
    detail: ok ? details.join('；') : problems.join('；')
  }));
}

try {
  main();
} catch (e) {
  console.log('SELFTEST ' + JSON.stringify({
    ok: false,
    detail: 'selftest.js 自己崩了：' + (e && e.stack ? e.stack.split('\n')[0] : String(e))
  }));
}
