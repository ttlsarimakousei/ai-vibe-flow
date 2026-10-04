'use strict';
/*
 * PreToolUse 钩子（Grep）：搜索的范围里有放令牌、放模型 key 的地方，而且要把内容搜出来的，拦下。
 *
 * 为什么要有它（2.1.120 上实测）：
 *   Read 这两处                      被 settings.json 里的权限规则挡住（安装器加的）
 *   Grep 直接对着这两处搜            也被权限规则挡住
 *   Grep 对着它们的上级目录搜        权限规则管不到，内容原样带出来（套件目录、~/.claude、用户目录、整个盘）
 * 所以这里只管第三种。只看文件名、只数个数的（files_with_matches、count）不拦：带不出内容。
 * 套件目录里还放了一个 .ignore，让搜索工具跳过这两处，算第二道；但搜索时带了文件名通配（glob）它就不管用，所以不能只靠它。
 * 用命令读（cat、grep -r、node -e）由 guard-commit 拦。
 */
const fs = require('fs');
const path = require('path');
const { blockOut, hookLog, expandHome, cli } = require('../lib/session');

const KIT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
function norm(p) {
  let r = path.resolve(p);
  // 目录联接、大小写不同、8.3 短名，都按真实路径比；不存在的就按写的比
  try { r = fs.realpathSync.native(r); } catch (e) { /* 不存在 */ }
  r = r.replace(/\\/g, '/').replace(/\/+$/, '');
  return WIN ? r.toLowerCase() : r;
}
const SECRETS = ['secrets.json', 'router-data'];

function handle(j) {
  if (!j || j.tool_name !== 'Grep') return null;
  const input = j.tool_input || {};
  if (String(input.output_mode || 'files_with_matches') !== 'content') return null;
  let base;
  try { base = norm(path.resolve(String(j.cwd || process.cwd()), expandHome(String(input.path || '.')))); } catch (e) { return null; }
  const kit = norm(KIT);
  const hit = SECRETS.map((s) => kit + '/' + s).find((s) => s === base || s.startsWith(base + '/') || base.startsWith(s + '/'));
  if (!hit) return null;
  hookLog('guard-read block Grep ' + String(input.path || '.'));
  return blockOut('PreToolUse', '[vibe-kit] 这次搜索的范围（' + String(input.path || '当前目录') + '）里有放令牌、放模型 key 的文件，它们的内容不能搜出来：搜出来会进会话记录。把 path 缩小到具体的子目录（比如套件的 hooks、lib，或者你要查的那个项目），或者把 output_mode 换成 files_with_matches 只看文件名。要知道令牌、模型配没配好，让用户看配置页。');
}

module.exports = { handle };
if (require.main === module) cli(handle);
