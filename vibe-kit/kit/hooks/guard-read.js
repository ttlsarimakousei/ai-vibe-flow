'use strict';
/*
 * PreToolUse 钩子（Read、Grep）：读、搜的范围里有放令牌、放模型 key 的地方，而且要把内容读出来的，拦下。
 *
 * 为什么要有它（2.1.120 上实测）：
 *   Read 这两处                      被 settings.json 里的权限规则挡住（安装器加的）
 *   Grep 直接对着这两处搜            也被权限规则挡住
 *   Grep 对着它们的上级目录搜        权限规则管不到，内容原样带出来（套件目录、~/.claude、用户目录、整个盘）
 * 2026-11-21 起 Read 也管（全量审核 A3，dev/probes/cc-read-deny.js 在 2.1.289 上实测，仓库主人定的"先实测，挡不住再加钩子"）：
 *   权限规则按路径的字面比：8.3 短名（VIBE-K~1）、\\?\ 前缀、\\localhost\C$ 管理共享这三种写法它认不出。
 *   普通模式下弹权限框（没人点，到点 ask-timeout 按允许放行），跳过权限时令牌直接读出来。
 *   正常写法、正斜杠、大小写不同、相对路径、~ 开头、目录联接，规则本身挡得住。
 * 这里先把路径换成普通写法、再按真实路径比（session-kitfiles 的 localPath、realpath），几种写法一样认。
 * Grep 只看文件名、只数个数的（files_with_matches、count）不拦：带不出内容。
 * 套件目录里还放了一个 .ignore，让搜索工具跳过这两处，算第二道；但搜索时带了文件名通配（glob）它就不管用，所以不能只靠它。
 * 用命令读（cat、grep -r、node -e）由 guard-commit 拦。
 * 每次读文件都起这个进程：顶上只载 Node 自带的模块和 session-kitfiles（不载整个 session.js），拦的时候才载别的
 */
const fs = require('fs');
const path = require('path');
const { localPath, expandHome } = require('../lib/session-kitfiles');

const KIT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
function norm(p) {
  let r = path.resolve(localPath(p));
  // 目录联接、大小写不同、8.3 短名，都按真实路径比；不存在的就按写的比。
  // 别的电脑的共享（换完还是 \\主机\ 开头）不去算：网络不通时 realpath 会卡住，而令牌不会在别的电脑上。
  // 设备路径（\\?\Volume{…}\、\\.\GLOBALROOT\…）要算：realpath 把它们还原成盘符（复审 R1）
  if (!/^[\\/]{2}(?![?.][\\/])/.test(r)) { try { r = fs.realpathSync.native(r); } catch (e) { /* 不存在 */ } }
  r = localPath(r).replace(/\\/g, '/').replace(/\/+$/, '');
  return WIN ? r.toLowerCase() : r;
}
const SECRETS = ['secrets.json', 'router-data'];

function protectedRange(base) { const kit = norm(KIT); base = norm(base); return SECRETS.some((s) => { const f = kit + '/' + s; return f === base || f.startsWith(base + '/') || base.startsWith(f + '/'); }); }
const S = () => require('../lib/session');
function denied(j, what, msg) {
  try { S().hookLog('guard-read block ' + j.tool_name + ' ' + what); } catch (e) { /* 记不了不影响 */ }
  try { require('../lib/feedback.js').countBlock('guard-read', '[vibe-kit] ' + (j.tool_name === 'Read' ? '读' : '搜索的范围里有') + '放令牌、放模型 key 的文件', String(j.session_id || '')); } catch (e) { /* 数不了不影响 */ }
  return require('../lib/session-out').blockOut('PreToolUse', msg);
}
function readCheck(j) {
  const f = String((j.tool_input || {}).file_path || '');
  if (!f) return null;
  let target;
  try { target = norm(path.resolve(String(j.cwd || process.cwd()), /^[~$%]/.test(f) ? expandHome(f) : f)); } catch (e) { return null; }
  const kit = norm(KIT);
  const hit = SECRETS.map((s) => kit + '/' + s).find((s) => target === s || target.startsWith(s + '/'));
  if (!hit) return null;
  return denied(j, f, '[vibe-kit] ' + f + ' 是套件放令牌、放模型 key 的文件，内容不能读：读出来会进会话记录。要看套件的开关，读 config.json；要知道令牌、模型配没配好，让用户看配置页。');
}
function handle(j) {
  if (j && j.tool_name === 'Read') return readCheck(j);
  if (!j || j.tool_name !== 'Grep') return null;
  const input = j.tool_input || {};
  if (String(input.output_mode || 'files_with_matches') !== 'content') return null;
  let base;
  try { base = norm(path.resolve(String(j.cwd || process.cwd()), expandHome(String(input.path || '.')))); } catch (e) { return null; }
  const kit = norm(KIT);
  const hit = SECRETS.map((s) => kit + '/' + s).find((s) => s === base || s.startsWith(base + '/') || base.startsWith(s + '/'));
  if (!hit) return null;
  return denied(j, String(input.path || '.'), '[vibe-kit] 这次搜索的范围（' + String(input.path || '当前目录') + '）里有放令牌、放模型 key 的文件，它们的内容不能搜出来：搜出来会进会话记录。把 path 缩小到具体的子目录（比如套件的 hooks、lib，或者你要查的那个项目），或者把 output_mode 换成 files_with_matches 只看文件名。要知道令牌、模型配没配好，让用户看配置页。');
}

module.exports = { handle, protectedRange };
if (require.main === module) require('../lib/session-out').cli(handle);
