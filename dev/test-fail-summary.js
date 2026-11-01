'use strict';
/*
 * K3 M08（2026-11-01，docs/feedback-20261101.md）：编译、测试失败时只给摘要。
 *   命令失败（PostToolUseFailure，error 是"Exit code N"加命令的全部输出）：after-tool 抽出第一个错误、文件:行、前后 5 行源码，作为 additionalContext 送给模型
 *   Maven、javac、TypeScript、ESLint、pytest、Python 的 Traceback、node --test、node --check 都认；能在这台电脑上真跑的（node、javac、python）拿真输出测
 *   成功的命令、认不出的命令、抽不出错误的：什么都不加
 * 用法：node dev/test-fail-summary.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const h = H.makeHome('tfs', FROM);
const proj = path.join(h.work, 'proj');
const javaLines = ['package com.x;', '', 'import java.util.List;', '', 'public class OrderService {', '    private OrderMapper mapper;', '', '    public void load(List<Long> ids) {', '        if (ids.isEmpty()) {', '            return;', '        }', '        mapper.selectByIds(ids);', '    }', '', '    public void other() {', '    }', '}', ''];
H.write(path.join(proj, 'src/main/java/com/x/OrderService.java'), javaLines.join('\n'));
H.write(path.join(proj, 'src/views/Order.vue'), ['<template>', '  <div>{{ total }}</div>', '</template>', '<script setup lang="ts">', "import { ref } from 'vue'", 'const order = ref<Bar>()', 'const total = 1', 'order.value.foo()', '</script>', ''].join('\n'));
const fail = (command, error, extra) => H.hook(h, 'after-tool', Object.assign({ session_id: 'sess-tfs', cwd: proj, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error, is_interrupt: false }, extra || {}));
const ctx = (o) => String((o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '');
const noise = (n) => Array.from({ length: n }, (_, i) => '[INFO] Downloading something ' + i).join('\n');

(async () => {
  H.section('Maven 编译没过：第一个错误、文件:行、"符号""位置"、前后 5 行源码');
  {
    const abs = '/' + path.join(proj, 'src/main/java/com/x/OrderService.java').replace(/\\/g, '/');
    const out = 'Exit code 1\n' + noise(300) + '\n[INFO] -------------------------------------------------------------\n[ERROR] COMPILATION ERROR : \n[INFO] -------------------------------------------------------------\n'
      + '[ERROR] ' + abs + ':[12,15] 找不到符号\n  符号:   方法 selectByIds(java.util.List<java.lang.Long>)\n  位置: 类型为com.x.OrderMapper的变量 mapper\n'
      + '[ERROR] ' + abs + ':[16,5] 需要 class, interface, enum 或 record\n[INFO] 2 errors\n' + noise(200);
    const c = ctx(fail('mvn -q -o compile', out));
    H.ok('说了是 Maven 没过、第一个错误在 OrderService.java:12', /\[vibe-kit 失败摘要\] Maven 没过，第一个错误：src\/main\/java\/com\/x\/OrderService\.java:12:15　找不到符号/.test(c), c);
    H.ok('带上符号、位置两行', /符号:\s+方法 selectByIds/.test(c) && /位置: 类型为com\.x\.OrderMapper/.test(c), c);
    H.ok('带上前后 5 行源码，出错那一行标出来', / 7 \| /.test(c) && !/ 6 \| /.test(c) && /12>\|         mapper\.selectByIds\(ids\);/.test(c) && /17 \| \}/.test(c), c);
    H.ok('第二个错误不带', !/:16/.test(c.split('\n')[0]), c);
    H.ok('摘要不长（几千行输出只送十几行）', c.split('\n').length <= 20 && c.length < 2500, c.length);
  }

  H.section('TypeScript、ESLint、pytest、Python 的 Traceback：都认得');
  {
    const ts = ctx(fail('npx vue-tsc --noEmit', "Exit code 2\nsrc/views/Order.vue(8,13): error TS2339: Property 'foo' does not exist on type 'Bar'.\nsrc/views/Order.vue(9,1): error TS1005: ';' expected.\n"));
    H.ok('vue-tsc：src/views/Order.vue:8:13 和 TS2339', /TypeScript 没过，第一个错误：src\/views\/Order\.vue:8:13　TS2339: Property 'foo'/.test(ts) && /8>\| order\.value\.foo\(\)/.test(ts), ts);
    const eslintFile = path.join(proj, 'src/views/Order.vue');
    const es = ctx(fail('npm run lint', 'Exit code 1\n\n> proj@1.0.0 lint\n> eslint src\n\n' + eslintFile + '\n  7:7  error  \'total\' is assigned a value but never used  no-unused-vars\n  8:1  error  \'order\' is not defined  no-undef\n\n✖ 2 problems (2 errors, 0 warnings)\n'));
    H.ok('npm run lint（ESLint）：第一条和它的规则名', /npm 没过，第一个错误：src\/views\/Order\.vue:7:7　'total' is assigned a value but never used（no-unused-vars）/.test(es), es);
    H.write(path.join(proj, 'tests/test_a.py'), 'def test_add():\n    x = 1\n    assert x == 2\n');
    const py = ctx(fail('python -m pytest tests -q', 'Exit code 1\nF                                                                        [100%]\n=================================== FAILURES ===================================\n___________________________________ test_add ___________________________________\n\n    def test_add():\n        x = 1\n>       assert x == 2\nE       assert 1 == 2\n\ntests\\test_a.py:3: AssertionError\n=========================== short test summary info ===========================\nFAILED tests/test_a.py::test_add - assert 1 == 2\n1 failed in 0.05s\n'));
    H.ok('pytest：tests/test_a.py:3 和 E 那一行', /Python 没过，第一个错误：tests\/test_a\.py:3　AssertionError：assert 1 == 2/.test(py) && /3>\|     assert x == 2/.test(py), py);
  }

  H.section('真跑出来的输出：node --test、node --check、javac、python -m unittest（这台电脑有的才跑）');
  {
    H.write(path.join(proj, 'a.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => {\n  assert.strictEqual(1 + 1, 3);\n});\n");
    const r = spawnSync(process.execPath, ['--test', 'a.test.js'], { cwd: proj, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const nt = ctx(fail('node --test a.test.js', 'Exit code ' + r.status + '\n' + r.stdout + r.stderr));
    H.ok('node --test：a.test.js 里断言的那一行', r.status !== 0 && /Node 没过，第一个错误：a\.test\.js:4/.test(nt) && /4>\|   assert\.strictEqual/.test(nt), [nt, r.stdout.slice(0, 1500)]);
    H.write(path.join(proj, 'bad.js'), 'const a = 1;\nlet x = ;\n');
    const c = spawnSync(process.execPath, ['--check', 'bad.js'], { cwd: proj, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const nc = ctx(fail('node --check bad.js', 'Exit code ' + c.status + '\n' + c.stdout + c.stderr));
    H.ok('node --check：bad.js:2 的语法错', c.status !== 0 && /Node 没过，第一个错误：bad\.js:2　SyntaxError/.test(nc), [nc, c.stderr]);
    const rt = H.runtime('auto');
    const javac = rt.java ? path.join(path.dirname(rt.java), process.platform === 'win32' ? 'javac.exe' : 'javac') : '';
    if (javac && fs.existsSync(javac)) {
      H.write(path.join(proj, 'j', 'A.java'), 'public class A {\n    void a() {\n        foo();\n    }\n}\n');
      const jr = spawnSync(javac, ['A.java'], { cwd: path.join(proj, 'j'), encoding: 'utf8', windowsHide: true, timeout: 120000 });
      const jc = ctx(fail('javac A.java', 'Exit code ' + jr.status + '\n' + jr.stdout + jr.stderr, { cwd: path.join(proj, 'j') }));
      H.ok('javac：A.java:3 和"符号"那一行', jr.status !== 0 && /javac 没过，第一个错误：A\.java:3　/.test(jc) && /(符号|symbol)\s*:/.test(jc) && /3>\|         foo\(\);/.test(jc), [jc, jr.stderr]);
    } else console.log('  （这台电脑没有 javac，跳过真跑 javac）');
    if (rt.python) {
      H.write(path.join(proj, 'test_u.py'), 'import unittest\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1, 2)\n');
      const pr = spawnSync(rt.python, ['-m', 'unittest', 'test_u'], { cwd: proj, encoding: 'utf8', windowsHide: true, timeout: 120000 });
      const pc = ctx(fail('python -m unittest test_u', 'Exit code ' + pr.status + '\n' + pr.stdout + pr.stderr));
      H.ok('python -m unittest：test_u.py:5 的 AssertionError', pr.status !== 0 && /Python 没过，第一个错误：test_u\.py:5　AssertionError：1 != 2/.test(pc), [pc, pr.stderr]);
    } else console.log('  （这台电脑没有 Python，跳过真跑 unittest）');
  }

  H.section('输出点名放令牌、key 的文件：不读出来（复审发现）');
  {
    const TOKEN = 'glpat-fail-summary-secret-1234';
    const KEY = 'sk-fail-summary-model-key-5678';
    const secret = path.join(h.kit, 'secrets.json');
    const data = path.join(h.kit, 'router-data', 'config.json');
    H.write(secret, JSON.stringify({ gitlabToken: TOKEN }) + '\n');
    H.write(data, JSON.stringify({ providers: [{ api_key: KEY }] }) + '\n');
    const a = ctx(fail('npm run lint', 'Exit code 1\n' + secret + '\n  1:1  error  x  rule\n'));
    H.ok('ESLint 那种写法点名 secrets.json：不带内容', !a.includes(TOKEN), a);
    const b = ctx(fail('python -m pytest', 'Exit code 1\nTraceback (most recent call last):\n  File "' + data + '", line 1, in x\nValueError: x\n'));
    H.ok('Python 那种写法点名 router-data：不带内容', !b.includes(KEY), b);
    const up = ctx(fail('npm run lint', 'Exit code 1\n' + secret.toUpperCase() + '\n  1:1  error  x  rule\n'));
    H.ok('大小写换一换也不行', !up.includes(TOKEN), up);
    const link = path.join(proj, 'link-to-secrets.json');
    let linked = false;
    try { fs.symlinkSync(secret, link); linked = true; } catch (e) { linked = false; }
    if (linked) { const l = ctx(fail('npm run lint', 'Exit code 1\n' + link + '\n  1:1  error  x  rule\n')); H.ok('符号链接指过去也不行', !l.includes(TOKEN), l); fs.unlinkSync(link); }
    const fine = ctx(fail('npm run lint', 'Exit code 1\n' + path.join(proj, 'src/views/Order.vue') + '\n  7:7  error  x  rule\n'));
    H.ok('项目里的文件照常带源码', /7>\|/.test(fine), fine);
  }

  H.section('成功的命令、认不出的命令、抽不出错误的：什么都不加');
  {
    const ok = H.hook(h, 'after-tool', { session_id: 'sess-tfs', cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'mvn -q -o compile' }, tool_response: { stdout: '[ERROR] 这行只是日志里的字 src/A.java:[1,1] x', stderr: '' } });
    H.ok('成功的 mvn：不加', ok === null, ok);
    H.ok('git status 失败：不加', fail('git status', 'Exit code 128\nfatal: not a git repository') === null);
    H.ok('mvn 失败但输出里找不到错误位置：不加', fail('mvn -q -o compile', 'Exit code 1\n[ERROR] Failed to execute goal: 网络不通') === null);
    H.ok('被打断的：不加', fail('mvn -q -o compile', 'Exit code 130\n[ERROR] /x/A.java:[1,1] y', { is_interrupt: true }) === null);
  }

  H.done('编译测试失败只给摘要');
})().catch((e) => { H.ok('测试脚本出错', false, e.stack); H.done('编译测试失败只给摘要'); });
