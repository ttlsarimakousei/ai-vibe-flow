'use strict';
/*
 * 查库技能的执行器（ttls-db-crud/scripts/runner）：DbRunner.java 和编好的 class 一起进安装包。编译记录 DbRunner.build.json 记着
 * 这批 class 是拿哪一份源码（sha256）、哪个 javac、按哪个 Java 版本编的，每个 class 的 sha256 是多少（K1-6，Codex 改进路线第 11 节）。
 * 以前打包时比修改时间（class 比 .java 旧就不打），重新检出之后修改时间说明不了什么：.java 改了没重编也照样打进包。
 *   dev/build-db-runner.js  编完写记录（write）
 *   dev/pack.js              核对记录（check）：源码的哈希对不上、class 多了少了或者内容对不上，都不打包
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RECORD = 'DbRunner.build.json';
const SOURCE = 'DbRunner.java';
/** DbRunner.class 和它的内部类（DbRunner$Scope.class 这些） */
const CLASS_RE = /^DbRunner(?:\$[\w$]+)?\.class$/;
const REBUILD = 'node dev/build-db-runner.js auto（要 JDK 9 以上，按 --release 8 编，同时重写编译记录 ' + RECORD + '）';
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 目录里现在的样子：源码的哈希、每个 class 的哈希 */
function current(dir) {
  const classes = {};
  for (const n of fs.readdirSync(dir).filter((x) => CLASS_RE.test(x)).sort()) classes[n] = sha256(path.join(dir, n));
  return { source: { file: SOURCE, sha256: sha256(path.join(dir, SOURCE)) }, classes };
}
/** 刚编完：写编译记录。javac 是 "javac 17.0.20.1" 这样的版本说明，release 是 --release 的值 */
function write(dir, javac, release) {
  const rec = Object.assign({ javac: String(javac || '').trim(), release: String(release || '8') }, current(dir));
  fs.writeFileSync(path.join(dir, RECORD), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}
/** 读编译记录；没有、读不懂返回 null */
function read(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')); return j && j.source && j.classes ? j : null; } catch (e) { return null; }
}
/** 核对：class 是不是从现在这份 .java 编出来的。返回 { ok, why } */
function check(dir) {
  const rec = read(dir);
  if (!rec) return { ok: false, why: '执行器没有编译记录（' + RECORD + '），说不清 class 是从哪份源码编的：' + REBUILD };
  const now = current(dir);
  if (now.source.sha256 !== String(rec.source.sha256 || '')) return { ok: false, why: SOURCE + ' 改了没重新编译（编译记录里源码的 sha256 是 ' + String(rec.source.sha256 || '').slice(0, 12) + '…，现在是 ' + now.source.sha256.slice(0, 12) + '…）：' + REBUILD };
  const want = Object.keys(rec.classes).sort();
  const have = Object.keys(now.classes);
  const extra = have.filter((n) => !want.includes(n));
  const lack = want.filter((n) => !have.includes(n));
  const diff = want.filter((n) => have.includes(n) && now.classes[n] !== rec.classes[n]);
  if (extra.length || lack.length || diff.length) return { ok: false, why: 'class 和编译记录对不上（' + [lack.length && '少了 ' + lack.join('、'), extra.length && '多了 ' + extra.join('、'), diff.length && '内容不一样 ' + diff.join('、')].filter(Boolean).join('；') + '），不是这份源码编出来的：' + REBUILD };
  return { ok: true, rec };
}

module.exports = { RECORD, SOURCE, CLASS_RE, REBUILD, current, write, read, check };
