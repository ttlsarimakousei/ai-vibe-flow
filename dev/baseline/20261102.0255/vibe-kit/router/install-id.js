'use strict';
/*
 * 这一份安装的标识（E1，2026-11-01）：路由的 /version 带上它，service.js 停路由、认"端口上的是不是这份安装的路由"时比对。
 * 远程桌面几个人共用一台电脑时各装各的套件，路由都默认用 15730：以前只看 /version 有回话就当是自己的，会连到、停掉别人的路由。
 * 按套件目录（这个文件所在目录的上一级，装好后是 ~/.claude/vibe-kit）的真实路径算哈希，不带用户名、路径原文。
 * 路由（base.js）和 service.js 都用这一份算法；老版本的路由 /version 不带标识，service.js 照以前的规矩处理。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** kitDir 不给就是这个文件所在的那一份安装 */
function installId(kitDir) {
  let p = path.resolve(kitDir || path.dirname(__dirname));
  // 目录联接、大小写、短文件名写法不同，都算同一份
  try { p = fs.realpathSync.native(p); } catch (e) { /* 不存在就按原样 */ }
  if (process.platform === 'win32') p = p.toLowerCase();
  return crypto.createHash('sha256').update('vibe-kit-install\n' + p).digest('hex').slice(0, 16);
}

module.exports = { installId };
