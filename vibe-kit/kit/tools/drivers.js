'use strict';
/*
 * 数据库驱动：看现在用的是哪个、到 Maven 本地仓库里找、登记一个。配置页"数据库驱动"那一页做的是同样的事。
 *   node drivers.js list                      每种数据库现在用哪个驱动
 *   node drivers.js auto [--only dm,mysql] [--force] [--by-user]   到 Maven 本地仓库里找，没登记驱动的数据库自动登记一个
 *                                             （项目的 pom 里写明的版本 → 查库用的 JDK 加载得了的里面最新的）。
 *                                             用户在配置页里去掉过的不登记，除非带 --by-user（配置页上点的带这个）
 *   node drivers.js scan [--repo <目录>]      只找不登记：列出找到的
 *   node drivers.js use <jar 的路径>          用这个 jar（自己会认它是哪种数据库的驱动）
 *   node drivers.js remove <数据库>           从登记表里去掉
 * 加 --json 输出一行 JSON（给配置页用）。
 */
const path = require('path');
const D = require('../lib/drivers.js');

const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !/^--/.test(args[i + 1]) ? args[i + 1] : ''; };
const JSON_OUT = has('--json');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const FROM = { maven: 'Maven 仓库里找到的', manual: '自己选的', rescue: '从旧的 urai-db-crud 技能里挪过来的' };
function out(obj, text) {
  if (JSON_OUT) process.stdout.write(JSON.stringify(obj) + '\n');
  else console.log(text);
}
function listText(s) {
  const L = ['数据库驱动（登记在 ' + s.registry + '）', ''];
  for (const d of s.drivers) {
    if (d.ok) L.push('  ✓ ' + d.name + '（' + d.dialect + '）  ' + d.file + (d.version ? '  ' + d.version : '') + '  ' + mb(d.size) + '  ' + (FROM[d.from] || d.from));
    else if (d.lost) L.push('  ✗ ' + d.name + '（' + d.dialect + '）  登记的文件不见了：' + d.jar);
    else L.push('  · ' + d.name + '（' + d.dialect + '）  还没有驱动');
  }
  L.push('');
  L.push(s.repos.length ? 'Maven 本地仓库：' + s.repos.map((r) => r.dir + '（' + r.from + '）').join('；') : '这台电脑上没找到 Maven 本地仓库（在配置页"本机环境"里配，或者用 use 直接指定 jar）');
  const miss = s.drivers.filter((d) => !d.ok);
  if (miss.length) L.push('没有驱动的：先试 node "' + __filename + '" auto；找不到就 node "' + __filename + '" use <jar 的路径>，或者在配置页"数据库驱动"里选。');
  return L.join('\n');
}
function scanText(r) {
  const L = ['看了 ' + r.dirs.length + ' 个仓库、' + r.scanned + ' 个目录，用了 ' + (r.ms / 1000).toFixed(1) + ' 秒' + (r.timedOut ? '（到时间了，没看完：仓库太大，可以用 --repo 指到更小的目录）' : '') + '。', ''];
  if (!r.dirs.length) L.push('这台电脑上没找到 Maven 本地仓库。在配置页"本机环境"里配 Maven，或者用 --repo <目录> 指定。');
  for (const k of Object.keys(D.DIALECTS)) {
    const list = r.found[k] || [];
    L.push(D.DIALECTS[k].name + '（' + k + '）：' + (list.length ? '' : '没找到'));
    for (const x of list.slice(0, 6)) L.push('    ' + (x.version || '?').padEnd(14) + mb(x.size).padStart(8) + '  ' + x.jar + (x.java > 8 ? '  （要 Java ' + x.java + ' 以上）' : ''));
    if (list.length > 6) L.push('    …还有 ' + (list.length - 6) + ' 个');
  }
  return L.join('\n');
}

try {
  if (cmd === 'list') { const s = D.status(); out(s, listText(s)); }
  else if (cmd === 'scan') {
    const repo = valOf('--repo');
    const r = D.scan({ dirs: repo ? [{ dir: path.resolve(repo), from: '指定的目录' }] : undefined, budgetMs: Number(valOf('--budget')) || undefined });
    out(r, scanText(r));
  } else if (cmd === 'auto') {
    const repo = valOf('--repo');
    const only = valOf('--only').split(',').map((s) => s.trim()).filter(Boolean);
    // 在项目目录里跑的：项目的 pom 里写明了驱动版本的，优先用那一个
    let prefer = [];
    try { prefer = D.projectDrivers(process.cwd()); } catch (e) { prefer = []; }
    const r = D.auto({ dirs: repo ? [{ dir: path.resolve(repo), from: '指定的目录' }] : undefined, only, force: has('--force'), byUser: has('--by-user'), prefer, budgetMs: Number(valOf('--budget')) || undefined });
    const L = [];
    for (const u of r.used) L.push('  ✓ ' + u.msg + '  来自 ' + u.source + (u.why ? '（' + u.why + '）' : ''));
    if (r.skipped.length) L.push('  没有自动登记：' + r.skipped.map((k) => D.DIALECTS[k].name).join('、') + '。这' + (r.skipped.length > 1 ? '几种' : '一种') + '的驱动是用户在配置页里去掉的：告诉用户，让他在配置页"数据库驱动"里选一个。');
    if (r.kept.length) L.push('  已经登记过、没动的：' + r.kept.map((k) => D.DIALECTS[k].name).join('、') + '（要换成仓库里最新的加 --force）');
    const none = r.missing.filter((k) => !r.skipped.includes(k));
    if (none.length) L.push('  还是没有驱动的：' + none.map((k) => D.DIALECTS[k].name).join('、') + '。Maven 仓库里没找到，用 use <jar 的路径> 指定，或者在配置页"数据库驱动"里选。');
    if (!r.scan.dirs.length) L.push('  这台电脑上没找到 Maven 本地仓库。');
    out(Object.assign({ status: D.status() }, r), L.join('\n') || '没有要做的。');
    process.exitCode = r.missing.length ? 1 : 0;
  } else if (cmd === 'use') {
    const jar = args.slice(1).find((a) => !/^--/.test(a) && a !== valOf('--dialect'));
    if (!jar) { out({ ok: false, msg: '要给 jar 的路径' }, '用法：node drivers.js use <jar 的路径>'); process.exitCode = 2; } else {
      const r = D.use(jar, { dialect: valOf('--dialect') || undefined, from: 'manual' });
      out(r, r.msg);
      process.exitCode = r.ok ? 0 : 1;
    }
  } else if (cmd === 'remove') {
    const r = D.remove(args[1] || '', valOf('--jar'));
    out(r, r.msg);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    out({ ok: false, msg: '没有这个命令：' + cmd }, '用法：node drivers.js list | auto | scan [--repo <目录>] | use <jar> | remove <数据库>');
    process.exitCode = 2;
  }
} catch (e) {
  out({ ok: false, msg: String((e && e.message) || e) }, '出错：' + ((e && e.message) || e));
  process.exitCode = 1;
}
