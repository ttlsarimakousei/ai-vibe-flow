'use strict';
/*
 * 打包：检查 → 写版本号 → 压成 vibe-kit-<版本号>.zip（比如 vibe-kit-20260928.1700.zip，放在工程根目录）→ 解压出来逐个文件核对。
 *   node dev/pack.js                     版本号取现在的时间（年月日.时分）
 *   node dev/pack.js --version 20260928.1700
 *   node dev/pack.js --keep-version      只补了文档、重新打包时用：版本号不变
 * 压缩用系统自带的 PowerShell（Compress-Archive），和以前的包一样；解压核对用系统自带的 tar。
 * 包里不该有的东西（state、feedback、config.json 这类运行时才有的）要是出现在源目录里，直接报错不打包：多半是测试跑到源目录里了。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'vibe-kit');
const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const fail = (m) => { console.log('  [X] ' + m); process.exit(1); };

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(dir, r, out); else if (e.isFile()) out.push(r);
  }
  return out;
}
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// 1. 源目录里不该有运行时的东西
// secrets.json 里是 GitLab 的令牌：进了包就等于发给了所有人
const RUNTIME = ['kit/secrets.json', 'kit/gitlab.json', 'kit/update', 'kit/issue-exports', 'secrets.json', 'gitlab.json', '.git', 'kit/state', 'kit/feedback', 'kit/lessons', 'kit/config.json', 'kit/local.json', 'kit/installed.json', 'kit/backup', 'kit/pristine', 'kit/router-data', 'router/config.json', 'router/router.pid', 'router/usage.json', 'kit/drivers', 'kit/drivers.json'];
const stray = RUNTIME.filter((r) => fs.existsSync(path.join(SRC, r)));
if (stray.length) fail('源目录里有运行时才该有的东西：' + stray.join('、') + '。多半是测试跑到源目录里了，清掉再打包');
for (const need of ['kit/lib/apply-scope.js', 'kit/lib/entry-check.js', 'kit/lib/evidence.js', 'kit/lib/feedback.js', 'kit/lib/hook-health.js', 'kit/lib/hook-host.js', 'kit/lib/hook-worker.js', 'kit/lib/invocation.js', 'kit/lib/local-backup.js', 'kit/lib/permissions.js', 'kit/lib/readiness.js', 'kit/lib/redact.js', 'kit/lib/review-runner.js', 'kit/lib/task-types.js', 'kit/lib/work-sessions.js', 'kit/lib/workflow.js', 'kit/lib/workspace.js', 'kit/hooks/after-tool.js', 'kit/tools/review.js', 'kit/tools/workflow.js', 'kit/hooks/guard-read.js', 'kit/.ignore', 'publish.js', '发布到 GitLab（双击我）.bat', '.gitattributes', 'kit/lib/gitlab.js', 'kit/lib/updater.js', 'kit/lib/issues.js', 'install.js', 'README.md', '开发流程.md', '验收清单.md', '更新说明.md',
  '手册/保护和放行.md', '手册/审查和自测.md', '手册/提交推送和合并推送.md', '手册/查库和redis.md', '手册/自动更新和上报.md', '手册/上下文和token.md', '手册/模型路由和配置.md', '手册/项目说明和自动探索.md', '手册/IDEA接入.md',
  '安装（双击我）.bat', 'settings.fragment.json', 'claude/CLAUDE.md', 'kit/lib/session.js', 'kit/lib/flow-policy.js', 'kit/lib/openspec.js', 'kit/openspec/package.json', 'kit/openspec/node_modules/@fission-ai/openspec/bin/openspec.js', 'kit/lib/lessons.js', 'kit/tools/lesson.js', 'router/router.js', 'router/ui.html', 'kit/page/node_modules/playwright-core/package.json', 'kit/page/node_modules/pixelmatch/package.json', 'kit/page/node_modules/pngjs/package.json', 'kit/page/node_modules/playwright/package.json',
  'kit/lib/drivers.js', 'kit/lib/discover.js', 'kit/lib/onboard.js', 'kit/lib/toolstats.js', 'kit/lib/proposal-files.js', 'kit/lib/idea-mcp.js', 'kit/lib/idea-tools.js', 'kit/lib/state-store.js', 'kit/lib/intent.js', 'kit/lib/connection-lifecycle.js', 'kit/tools/drivers.js', 'kit/tools/onboard.js', 'claude/agents/ttls-reviewer.md',
  // source-hint.js 是个空壳，但不能没有：20260930.1505 和更早的版本自动更新到新版时，装后自检（跑的是旧版的代码）要载它，载不到就装回旧版，永远升不上来
  'kit/hooks/source-hint.js', 'kit/hooks/guard-push.js', 'claude/commands/vk-go.md', 'claude/commands/vk-fix.md', 'claude/commands/vk-auto.md', 'kit/lib/router-smoke.js', 'kit/lib/perf.js', 'kit/lib/report.js', 'kit/lib/outputs.js', 'kit/lib/archive-extract.js', 'kit/lib/tidy.js', 'kit/tools/skills-check.js', 'kit/lib/usage.js', 'kit/lib/pull.js', 'kit/tools/diagnose.js', 'kit/page/probe-run.js',
  'claude/skills/ttls-onboard/SKILL.md', 'claude/skills/ttls-see-page/SKILL.md', 'claude/skills/ttls-cross-review/SKILL.md', 'claude/skills/ttls-handover/SKILL.md',
  'claude/skills/ttls-db-crud/SKILL.md', 'claude/skills/ttls-db-crud/scripts/db.py', 'claude/skills/ttls-db-crud/scripts/runner/DbRunner.class', 'claude/skills/ttls-db-crud/scripts/runner/DbRunner.java',
  'claude/skills/ttls-redis/SKILL.md', 'claude/skills/ttls-redis/scripts/redis.js']) {
  if (!fs.existsSync(path.join(SRC, need))) fail('缺文件：' + need);
}

// 2. 语法检查
const files = walk(SRC, '', []);
// 驱动是厂商的，只限内部用，不能进安装包；Python 自己留的缓存、改名之前的技能目录也不该在
{
  const jars = files.filter((f) => /\.jar$/i.test(f) && !/node_modules\//.test(f));
  if (jars.length) fail('包里不能有 jar（数据库驱动不随包带）：' + jars.slice(0, 5).join('、'));
  const pyc = files.filter((f) => /(^|\/)__pycache__\/|\.pyc$/i.test(f));
  if (pyc.length) fail('源目录里有 Python 的缓存，删掉再打包：' + pyc.slice(0, 5).join('、'));
  const old = ['onboard', 'see-page', 'cross-review', 'handover'].filter((n) => fs.existsSync(path.join(SRC, 'claude', 'skills', n))).concat(fs.existsSync(path.join(SRC, 'claude', 'agents', 'vibe-reviewer.md')) ? ['vibe-reviewer.md'] : []);
  if (old.length) fail('源目录里还有改名之前的技能或代理：' + old.join('、'));
  // 执行器：class 比源码旧，就是改了 DbRunner.java 没重新编译
  const rd = path.join(SRC, 'claude', 'skills', 'ttls-db-crud', 'scripts', 'runner');
  if (fs.statSync(path.join(rd, 'DbRunner.class')).mtimeMs + 2000 < fs.statSync(path.join(rd, 'DbRunner.java')).mtimeMs) fail('DbRunner.class 比 DbRunner.java 旧：改了执行器要重新编译（javac --release 8 -encoding UTF-8 -d <runner 目录> DbRunner.java）');
  const head = fs.readFileSync(path.join(rd, 'DbRunner.class')).subarray(0, 8);
  if (head.readUInt32BE(0) !== 0xCAFEBABE || head.readUInt16BE(6) !== 52) fail('DbRunner.class 不是按 Java 8 编的（版本号 ' + head.readUInt16BE(6) + '，应该是 52）：用 javac --release 8');
}
const code = files.filter((f) => /\.js$/.test(f) && !/node_modules\//.test(f));
for (const f of code) {
  const r = spawnSync(process.execPath, ['--check', path.join(SRC, f)], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail('语法错：' + f + '\n' + r.stderr);
}
{
  const m = fs.readFileSync(path.join(SRC, 'router', 'ui.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/);
  const tmp = path.join(os.tmpdir(), 'vk-pack-ui-' + process.pid + '.js');
  fs.writeFileSync(tmp, m ? m[1] : '');
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true });
  fs.unlinkSync(tmp);
  if (!m || r.status !== 0) fail('配置页的脚本有语法错\n' + r.stderr);
}
// 文本文件都得是 UTF-8、换行是 LF（bat 除外：它是 GBK 的，原样带上）
for (const f of files.filter((x) => /\.(js|md|json|html|py|java)$/.test(x) && !/node_modules\//.test(x))) {
  const buf = fs.readFileSync(path.join(SRC, f));
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { fail(f + ' 不是 UTF-8'); }
  if (buf.includes(0x0d)) fail(f + ' 里有回车符（CRLF），源文件统一用 LF');
}
// bat：cmd 按 GBK 读、按"回车换行"一行行挪，所以必须是 GBK + CRLF，不带 BOM（存成 UTF-8、只有 LF 的话，双击出来是乱码和"不是内部或外部命令"）
for (const f of files.filter((x) => /\.(bat|cmd)$/i.test(x) && !/node_modules\//.test(x))) {
  const buf = fs.readFileSync(path.join(SRC, f));
  let cr = 0; let lf = 0;
  for (const b of buf) { if (b === 0x0d) cr++; else if (b === 0x0a) lf++; }
  if (cr !== lf || !lf) fail(f + ' 的换行不是 CRLF（回车 ' + cr + ' 个，换行 ' + lf + ' 个）');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) fail(f + ' 带了 BOM，cmd 会把它当成命令的一部分');
  let gbk = '';
  try { gbk = new TextDecoder('gbk', { fatal: true }).decode(buf); } catch (e) { fail(f + ' 不是 GBK'); }
  let utf8ok = true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { utf8ok = false; }
  if (utf8ok && /[^\x00-\x7f]/.test(gbk)) fail(f + ' 像是存成了 UTF-8（里面有中文，却能按 UTF-8 读出来），要存成 GBK');
}
// 仓库里的文件不许转换换行：同事的电脑用 git 拿新版，拿到的要和包里的一字不差
if (fs.readFileSync(path.join(SRC, '.gitattributes'), 'utf8').trim() !== '* -text') fail('.gitattributes 的内容应该是一行：* -text');
console.log('  [OK] 检查过了：' + code.length + ' 个脚本语法正确，文本文件都是 UTF-8，bat 是 GBK + CRLF');

// 3. 版本号
const vf = path.join(SRC, 'kit', 'VERSION');
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
let version = fs.existsSync(vf) ? fs.readFileSync(vf, 'utf8').trim() : '';
if (!args.includes('--keep-version')) {
  version = argOf('--version') || (d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.' + pad(d.getHours()) + pad(d.getMinutes()));
  if (!/^\d{8}\.\d{4}$/.test(version)) fail('版本号写成 年月日.时分，比如 20260928.1700');
  fs.writeFileSync(vf, version + '\n');
}
const notes = fs.readFileSync(path.join(SRC, '更新说明.md'), 'utf8');
if (!notes.includes('## ' + version + '（最新）')) fail('《更新说明.md》最上面没有这一版（' + version + '）的章节：每发一版都要加');
if (!notes.includes('内容 `' + version + '` | 最新版')) fail('《更新说明.md》"先看你装的是哪一版"那张表里没有把 ' + version + ' 标成最新版');
console.log('  [OK] 版本号 ' + version);

// 4. 压缩
const all = walk(SRC, '', []);
// 包名带完整的版本号（年月日.时分）：一天发好几版时，光看文件名就分得清。只带日期的话几版都叫同一个名字
const zip = path.join(REPO, 'vibe-kit-' + version + '.zip');
if (fs.existsSync(zip)) fs.unlinkSync(zip);
const ps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// 宿主的 PSModulePath 可能先指向另一份 PowerShell，明确加载 Windows 自带的模块，不改执行策略。
const archive = path.join(path.dirname(ps), 'Modules', 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1');
const loadArchive = fs.existsSync(archive) ? "Import-Module '" + archive.replace(/'/g, "''") + "' -ErrorAction Stop; " : '';
execFileSync(fs.existsSync(ps) ? ps : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + loadArchive + "Compress-Archive -LiteralPath '" + SRC.replace(/'/g, "''") + "' -DestinationPath '" + zip.replace(/'/g, "''") + "' -CompressionLevel Optimal"], { stdio: 'inherit', windowsHide: true, timeout: 600000 });
if (!fs.existsSync(zip)) fail('没压出来：' + zip);

// 5. 解压出来核对：一个不多、一个不少，内容逐字节相同
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vkz-'));
try {
  require('./lib/unzip').extract(zip, out);
  const got = walk(path.join(out, 'vibe-kit'), '', []).sort();
  const want = all.slice().sort();
  const missing = want.filter((f) => !got.includes(f));
  const extra = got.filter((f) => !want.includes(f));
  if (missing.length || extra.length) fail('包里的文件和源目录对不上。少了：' + missing.slice(0, 5).join('、') + '；多了：' + extra.slice(0, 5).join('、'));
  const bad = want.filter((f) => sha(path.join(SRC, f)) !== sha(path.join(out, 'vibe-kit', f)));
  if (bad.length) fail('包里这些文件的内容和源目录不一样：' + bad.slice(0, 5).join('、'));
  console.log('  [OK] ' + zip + '：' + want.length + ' 个文件，' + (fs.statSync(zip).size / 1048576).toFixed(1) + ' MB，解压出来逐个核对过，内容一致');
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { console.log('  [!] 临时目录没删干净：' + out); }
}

// 6. 留一份这一版的代码（不带看页面的依赖，一兆左右）：下一版做新旧对比回归时当"上一版"用。旧的压缩包常常会被删掉。只留最近四份
const baseDir = path.join(__dirname, 'baseline');
const keep = path.join(baseDir, version, 'vibe-kit');
fs.rmSync(path.join(baseDir, version), { recursive: true, force: true });
for (const f of all) {
  if (/(^|\/)node_modules\//.test(f)) continue;
  fs.mkdirSync(path.dirname(path.join(keep, f)), { recursive: true });
  fs.copyFileSync(path.join(SRC, f), path.join(keep, f));
}
const kept = fs.readdirSync(baseDir).filter((n) => /^\d{8}\.\d{4}$/.test(n)).sort();
for (const n of kept.slice(0, Math.max(0, kept.length - 4))) fs.rmSync(path.join(baseDir, n), { recursive: true, force: true });
console.log('  [OK] 这一版的代码留了一份在 ' + path.join(baseDir, version) + '（新旧对比用）；现在留着的：' + fs.readdirSync(baseDir).filter((n) => /^\d{8}\.\d{4}$/.test(n)).sort().join('、'));
