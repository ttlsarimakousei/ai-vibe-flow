'use strict';
/* 按 Java 8 编译随包执行器。编译环境使用假用户目录，只更新仓库里的 class 文件，不装 JDBC 驱动。 */
const path = require('path');
const H = require('./lib/harness');
const rt = H.runtime(process.argv[2] || 'auto');
const h = H.freshHome('build-runner');
const dir = path.join(H.SRC, 'claude/skills/ttls-db-crud/scripts/runner');
const r = H.run(h, path.join(path.dirname(rt.java), 'javac.exe'), ['--release', '8', '-encoding', 'UTF-8', '-d', dir, path.join(dir, 'DbRunner.java')], { timeout: 60000 });
H.ok('执行器按 Java 8 编译成功', r.code === 0, r.out + r.err);
H.done('编译执行器');
