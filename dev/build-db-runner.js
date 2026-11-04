'use strict';
/*
 * 按 Java 8 编译随包执行器。编译环境使用假用户目录，只更新仓库里的 class 文件，不装 JDBC 驱动。
 * 编完写编译记录 DbRunner.build.json（源码的 sha256、javac 版本、每个 class 的 sha256）：打包时拿它核对 class 是不是从现在这份源码编的（lib/db-runner-record.js）。
 * 先编到临时目录，编成了再换掉旧的 DbRunner*.class（源码里删了一个内部类，旧的 class 不会自己消失）；编不过，仓库里的不动。
 *   node dev/build-db-runner.js auto        JDK 到正式装的位置找（和测试的 --rt auto 一样）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const R = require('./lib/db-runner-record');
const rt = H.runtime(process.argv[2] || 'auto');
const h = H.freshHome('build-runner');
const dir = path.join(H.SRC, 'claude/skills/vk-db-crud/scripts/runner');
const javac = rt.java ? path.join(path.dirname(rt.java), 'javac.exe') : '';
H.ok('找到了 javac', !!javac && fs.existsSync(javac), rt.java);
if (javac && fs.existsSync(javac)) {
  const ver = H.run(h, javac, ['-version'], { timeout: 60000 });
  const out = H.tempDir('build-runner-out');
  const r = H.run(h, javac, ['--release', '8', '-encoding', 'UTF-8', '-d', out, path.join(dir, R.SOURCE)], { timeout: 60000 });
  if (H.ok('执行器按 Java 8 编译成功', r.code === 0, r.out + r.err)) {
    for (const n of fs.readdirSync(dir).filter((x) => R.CLASS_RE.test(x))) fs.unlinkSync(path.join(dir, n));
    for (const n of fs.readdirSync(out).filter((x) => R.CLASS_RE.test(x))) fs.copyFileSync(path.join(out, n), path.join(dir, n));
    const rec = R.write(dir, (ver.out + ver.err).trim().split(/\r?\n/)[0], '8');
    H.ok('写了编译记录，核对得上', R.check(dir).ok, rec);
  }
}
H.done('编译执行器');
