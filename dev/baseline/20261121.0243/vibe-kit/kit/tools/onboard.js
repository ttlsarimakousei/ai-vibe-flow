'use strict';
/*
 * 后台自动探索：钩子甩出来的后台进程跑的就是这个；也可以手动跑。
 *   node onboard.js status [--dir <目录>]          这个目录下各个项目探索得怎么样了
 *   node onboard.js run [--dir <目录>] [--force]   该探索的探索一遍；--force 不管到没到时候都重新探索
 *   node onboard.js scan [--dir <目录>]            只看不写：配置文件里有哪些数据库、redis 的连接，各是哪个环境的
 * 探索只读项目里的文件、写项目的 .vibe/ 目录，不跑项目的构建命令，不连数据库。
 * 加 --json 输出一行 JSON；--quiet 什么都不输出（后台跑的时候用）。
 */
const path = require('path');
const O = require('../lib/onboard.js');

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !/^--/.test(args[i + 1]) ? args[i + 1] : ''; };
const dir = path.resolve(valOf('--dir') || process.cwd());
const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');
const KIND = { maven: 'Maven 工程', gradle: 'Gradle 工程', frontend: '前端', 'legacy-web': '老式 Java Web', skills: '技能工程', scripts: '脚本、工具', docs: '文档', unknown: '没认出来' };

function print(obj, text) {
  if (has('--quiet')) return;
  if (has('--json')) process.stdout.write(JSON.stringify(obj) + '\n'); else console.log(text);
}
try {
  if (cmd === 'run') {
    const r = O.run(dir, has('--force'));
    const L = [];
    for (const x of r) {
      if (x.error) { L.push('✗ ' + x.root + '：出错了（' + x.error + '）'); continue; }
      L.push('✓ ' + x.root + '：' + (KIND[x.kind] || x.kind) + (x.first ? '，第一次探索' : '，' + x.why));
      if (x.wroteProject) L.push('    项目说明：' + path.join(x.root, '.vibe', 'project.md'));
      if (x.db && x.db.names.length) L.push('    数据库连接：' + x.db.names.join('、') + '（' + x.db.file + '）');
      if (x.redis && x.redis.names.length) L.push('    redis 连接：' + x.redis.names.join('、') + '（' + x.redis.file + '）');
      if (x.drivers.length) L.push('    顺手登记了驱动：' + x.drivers.join('、'));
      for (const c of x.changes) L.push('    · ' + c);
      for (const n of x.notDev || []) L.push('    没配进来：' + n.url + '（' + n.source + '，' + n.why + '）');
    }
    print({ ok: true, results: r }, L.join('\n') || '没有要探索的（都探索过，依据的文件也没变）。要重新探索加 --force。');
  } else if (cmd === 'scan') {
    const s = O.scan(dir);
    const L = [];
    const tail = (x) => (x.unresolved ? '连接串里有没展开的占位符' : x.devOnly ? '开发环境的' : x.why) + '，口令' + (x.encrypted ? '是加密的' : x.hasPassword ? '有' : '没找到');
    for (const x of s.db) L.push(x.url + '\n    ' + x.source + ':' + x.line + '　用户 ' + (x.user || '没找到') + '　' + tail(x));
    for (const x of s.redis) L.push('redis ' + x.host + ':' + x.port + ' 库 ' + x.db + '\n    ' + x.source + ':' + x.line + '　' + tail(x));
    print(Object.assign({ ok: true }, s), L.join('\n') || '在 ' + dir + ' 下没找到数据库、redis 的连接配置。');
  } else if (cmd === 'status') {
    const s = O.status(dir);
    const L = s.map((x) => (x.explored ? '✓ ' : '· ') + x.root + '：' + (x.explored ? (KIND[x.kind] || x.kind) + '，' + when(x.updatedAt) + ' 探索的，依据 ' + x.tracked + ' 个文件' + (x.skippedNonDev ? '，有 ' + x.skippedNonDev + ' 个测试、生产环境的连接没配进来' : '') : '还没探索过') + (x.running ? '（正在探索）' : x.due ? '（该重新探索了：' + x.due + '）' : ''));
    print({ ok: true, projects: s }, L.join('\n') || '这个目录下没有要探索的项目。');
  } else {
    print({ ok: false, msg: '没有这个命令：' + cmd }, '用法：node onboard.js status | scan | run [--dir <目录>] [--force]');
    process.exitCode = 2;
  }
} catch (e) {
  print({ ok: false, msg: String((e && e.message) || e) }, '出错：' + ((e && e.stack) || e));
  process.exitCode = 1;
}
