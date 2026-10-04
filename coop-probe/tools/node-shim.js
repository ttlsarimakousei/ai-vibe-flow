'use strict';
/*
 * Node 垫片：通过 NODE_OPTIONS=--require 预加载，只替换 fs.cpSync 一个函数。
 * 原因：本包随带的 Node 22 在 Windows 上，fs.cpSync 碰到含中文的路径会直接崩溃
 * （退出码 -1073740791，即 0xC0000409，进程被系统强制结束，一个字都不输出）。
 * 内网把包解压在带中文的目录里，12 个用例的自检有 8 个因此"没有任何输出"。
 * 这里换成只用 readdirSync / mkdirSync / copyFileSync 的纯 JS 实现，行为与原版常用选项一致。
 */
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

function toPath(p) { return (p instanceof URL) ? fileURLToPath(p) : String(p); }
function eexist(d) { const e = new Error('Target already exists: ' + d); e.code = 'ERR_FS_CP_EEXIST'; return e; }

function cpSyncJs(src, dest, opts) {
  opts = opts || {};
  const force = opts.force !== false;
  const filter = typeof opts.filter === 'function' ? opts.filter : null;
  function copy(s, d) {
    if (filter && !filter(s, d)) return;
    const st = opts.dereference ? fs.statSync(s) : fs.lstatSync(s);
    if (st.isDirectory()) {
      if (!opts.recursive) { const e = new Error('Recursive option is required to copy a directory: ' + s); e.code = 'ERR_FS_EISDIR'; throw e; }
      fs.mkdirSync(d, { recursive: true });
      for (const name of fs.readdirSync(s)) copy(path.join(s, name), path.join(d, name));
      return;
    }
    if (fs.existsSync(d)) {
      if (!force) { if (opts.errorOnExist) throw eexist(d); return; }
      if (st.isSymbolicLink()) fs.unlinkSync(d);
    }
    fs.mkdirSync(path.dirname(d), { recursive: true });
    if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(s), d); return; }
    fs.copyFileSync(s, d);
    if (opts.preserveTimestamps) fs.utimesSync(d, st.atime, st.mtime);
  }
  copy(path.resolve(toPath(src)), path.resolve(toPath(dest)));
}

fs.cpSync = cpSyncJs;
