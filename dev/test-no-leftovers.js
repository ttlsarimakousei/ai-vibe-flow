'use strict';
/*
 * 删干净了没有（仓库主人 2026-11-03："有很多东西都删了，你要彻底删除干净，不要有多余的残留"）：
 *   (a) 扫 vibe-kit/（不含 node_modules）和 dev/（不含 baseline、这个文件）里已删的名字；
 *   (b) 留着的都写进白名单：文件、名字、理由、什么时候能删。白名单里多余的也报错；
 *   (c) session.js 的每个导出，session*.js 之外至少一处在用；
 *   (d) 假用户目录真装一遍：路由、HTTP 钩子都没有，令牌保护的 deny 还在。
 * 用法：node dev/test-no-leftovers.js [旧版套件目录]（拿 2248 跑不过）。dev/pack.js 打包前也跑。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2];
const REPO = path.join(__dirname, '..');
const KIT_ROOT = FROM ? path.resolve(FROM) : path.join(REPO, 'vibe-kit');
const OLD_UPDATERS = '上报里没有 20261102.2248 及更早的机器之后';
const OLD_RENAME = '上报里没有 20261104.1301 及更早的机器之后（ttls- 改成 vk- 那一版之前）';

// 已删的名字：能认出来是残留的才放进来，太短的（router、路由）误伤多，单独按文件看
const GONE = [
  'hook-host', 'hook-worker', 'hook-health', 'router-smoke', 'idea-mcp', 'idea-tools', 'fake-busy', 'fake-idea', 'cc-http-hooks', 'cc-stream-cut',
  'statusUsage', 'hookTransport', 'reviewExecutor', 'reviewMaxFiles', 'requirementsReviewMaxRounds', 'applyReviewMaxRounds', 'reviewMaxRounds', 'reviewLoop',
  'nearGatewayLimit', 'gatewayLimit', 'autoCompactAt', 'autoCompactWindowOf', 'flagVersion', 'ensureRouter', 'router/service.js', 'router/ui.html', 'router/kit-api', 'router/router.js',
  'ttls-onboard', 'ttls-see-page', 'ttls-cross-review', 'ttls-handover', 'ttls-db-crud', 'ttls-redis', 'ttls-reviewer', 'ttls-lessons-',
  'kitLock', 'kitBypass', 'plan-unlisted', 'autoCrossReview', 'releaseThread', 'planIntent', 'handoverStage', 'review-waivers', 'handover-consumed', 'hook-stats', 'textDlg', '127.0.0.1:15730', 'model-router', 'vibe-kit-router', '模型路由和配置', '观察期',
];
// [相对仓库的文件, 名字, 理由, 什么时候能删]
const KEEP = [
  ['dev/README.md', 'ttls-lessons-', '说明 test-vk-names.js 测什么', OLD_RENAME],
  ['dev/diff-hooks.js', 'ttls-handover', '对比用例：那一版的技能名', OLD_RENAME],
  ['dev/diff-hooks.js', 'ttls-lessons-', '对比用例：那一版的规则文件名', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-onboard', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-see-page', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-cross-review', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-handover', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-db-crud', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-redis', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/install.js', 'ttls-reviewer', 'OLD_SKILLS、OLD_AGENTS：升级时删 ttls- 开头的旧技能和代理', OLD_RENAME],
  ['vibe-kit/kit/hooks/review-stop.js', 'ttls-reviewer', '升级那一刻开着的会话里审查代理还叫 ttls-reviewer', OLD_RENAME],
  ['vibe-kit/kit/lib/lessons.js', 'ttls-lessons-', 'OLD_FILE_RE：旧名字的规则文件并进新名字的', OLD_RENAME],
  ['vibe-kit/kit/lib/toolstats.js', 'ttls-db-crud', '统计文件里旧的工具名', OLD_RENAME],
  ['vibe-kit/claude/skills/vk-db-crud/CHANGELOG.md', 'ttls-db-crud', '技能自己的变更记录，照当时的名字写', '不删：历史'],
  ['dev/test-vk-names.js', 'ttls-see-page', '测从 ttls- 升上来', OLD_RENAME],
  ['dev/test-vk-names.js', 'ttls-handover', '测从 ttls- 升上来', OLD_RENAME],
  ['dev/test-vk-names.js', 'ttls-db-crud', '测从 ttls- 升上来', OLD_RENAME],
  ['dev/test-vk-names.js', 'ttls-redis', '测从 ttls- 升上来', OLD_RENAME],
  ['dev/test-vk-names.js', 'ttls-reviewer', '测从 ttls- 升上来', OLD_RENAME],
  ['dev/test-vk-names.js', 'ttls-lessons-', '测从 ttls- 升上来', OLD_RENAME],
  ['vibe-kit/kit/lib/config-fields.js', 'autoCrossReview', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'kitLock', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'kitBypass', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['dev/lib/harness.js', 'kitLock', '给旧版套件写封条（比旧版、从旧版升级时它们还认）', '基线里没有 20261104.1301 及更早之后'],
  ['dev/lib/harness.js', 'kitBypass', '给旧版套件写封条（比旧版、从旧版升级时它们还认）', '基线里没有 20261104.1301 及更早之后'],
  ['dev/test-config-fields.js', 'kitLock', '测配置页上没有这两个控件了', OLD_UPDATERS],
  ['dev/test-config-fields.js', 'kitBypass', '测配置页上没有这两个控件了', OLD_UPDATERS],
  ['dev/ui-kit-0929.js', 'kitLock', '测封条里没有这两项了', OLD_UPDATERS],
  ['dev/ui-kit-0929.js', 'kitBypass', '测封条、保存结果里没有这两项了', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'hook-stats', '收回旧状态文件', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'vibe-kit-router', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'model-router', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'statusUsage', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'hookTransport', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'reviewExecutor', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'reviewMaxFiles', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'requirementsReviewMaxRounds', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'applyReviewMaxRounds', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'reviewMaxRounds', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'reviewLoop', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/router-retire.js', 'idea-mcp', '升级时收回路由和旧开关、旧状态', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'statusUsage', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'hookTransport', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'reviewExecutor', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'reviewMaxFiles', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'requirementsReviewMaxRounds', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'applyReviewMaxRounds', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'reviewMaxRounds', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/kit/lib/config-fields.js', 'reviewLoop', 'REMOVED 名单：升级时清旧开关', OLD_UPDATERS],
  ['vibe-kit/install.js', 'hook-host', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/install.js', 'hook-worker', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/install.js', 'hook-health', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/install.js', 'router-smoke', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/install.js', 'idea-mcp', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/install.js', 'idea-tools', 'DROPPED_FILES：升级时删旧文件', OLD_UPDATERS],
  ['vibe-kit/手册/配置页.md', 'model-router', '手册写明升级时收回什么', '用户手册的说明，跟着 router-retire 一起删'],
  ['vibe-kit/手册/配置页.md', 'vibe-kit-router', '手册写明升级时收回什么', '用户手册的说明，跟着 router-retire 一起删'],
  ['vibe-kit/手册/自动更新和上报.md', '观察期', '说明观察期取消了', '下下版删'],
  ['dev/lib/harness.js', 'hook-host', '比旧版基线时读它的钩子名单；盯真实\'启动\'文件夹不被碰', '基线里没有 2248 及更早之后'],
  ['dev/lib/harness.js', 'vibe-kit-router', '比旧版基线时读它的钩子名单；盯真实\'启动\'文件夹不被碰', '基线里没有 2248 及更早之后'],
  ['dev/test-config-fields.js', 'requirementsReviewMaxRounds', '测旧开关升级时清掉', OLD_UPDATERS],
  ['dev/test-config-fields.js', 'applyReviewMaxRounds', '测旧开关升级时清掉', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'reviewExecutor', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'reviewMaxFiles', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'requirementsReviewMaxRounds', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'applyReviewMaxRounds', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'reviewMaxRounds', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-feedback1102.js', 'reviewLoop', '测旧开关不在字段表里', OLD_UPDATERS],
  ['dev/test-update-canary.js', 'flagVersion', '测自动报的入口和观察期都没了', OLD_UPDATERS],
  ['dev/test-update-canary.js', '观察期', '测自动报的入口和观察期都没了', OLD_UPDATERS],
  ['dev/probes/up-no-router.js', 'vibe-kit-router', '测真装着旧路由的电脑升级', OLD_UPDATERS],
  ['dev/ui-update.js', 'vibe-kit-router', '测不写开机自启', OLD_UPDATERS],
];
// 整个文件都是历史或者就是在讲这些的
const SKIP_FILES = [/^vibe-kit\/更新说明/, /^dev\/test-router-retire\.js$/, /^dev\/test-no-leftovers\.js$/, /^dev\/baseline\//, /^dev\/contracts\.md$/, /^dev\/check-old-repro/];

function walk(dir, out) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git' || n === 'baseline') continue;
    const f = path.join(dir, n);
    const st = fs.statSync(f);
    if (st.isDirectory()) walk(f, out);
    else if (/\.(js|md|html|json|py|bat|txt|ps1)$/i.test(n) && st.size < 3 * 1024 * 1024) out.push(f);
  }
  return out;
}

H.section('已删的名字：除了白名单，一处都没有');
const hits = [];
const roots = FROM ? [KIT_ROOT] : [KIT_ROOT, path.join(REPO, 'dev')];
for (const root of roots) {
  for (const f of walk(root, [])) {
    const rel = path.relative(FROM ? path.dirname(KIT_ROOT) : REPO, f).split(path.sep).join('/');
    if (SKIP_FILES.some((re) => re.test(rel))) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const g of GONE) if (t.includes(g)) hits.push([rel, g]);
  }
}
const key = (r) => r[0] + ' : ' + r[1];
const allowed = new Set(KEEP.map(key));
const extra = hits.filter((r) => !allowed.has(key(r)));
if (extra.length) console.log(extra.map(key).join('\n'));
H.ok('没有白名单之外的残留', extra.length === 0, extra.length + ' 处，列在上面');
if (!FROM) {
  const seen = new Set(hits.map(key));
  const stale = KEEP.filter((r) => !seen.has(key(r)));
  H.ok('白名单里没有多余的', stale.length === 0, stale.map(key));
}
H.ok('白名单每条都写了理由和能删的条件', KEEP.every((r) => r[2] && r[3]));

H.section('删了的文件真的没了');
for (const f of ['router', 'kit/lib/hook-host.js', 'kit/lib/hook-worker.js', 'kit/lib/hook-health.js', 'kit/lib/router-smoke.js', 'kit/lib/idea-mcp.js', 'kit/lib/idea-tools.js', '手册/模型路由和配置.md']) {
  H.ok('没有 ' + f, !fs.existsSync(path.join(KIT_ROOT, f)));
}
H.ok('钩子文件一个不少：guard-push、source-hint 留空壳（硬规矩 11）', fs.existsSync(path.join(KIT_ROOT, 'kit', 'hooks', 'guard-push.js')) && fs.existsSync(path.join(KIT_ROOT, 'kit', 'hooks', 'source-hint.js')));

H.section('随包依赖：只留用得上的（2026-11-04）');
if (!FROM) {
  const page = path.join(KIT_ROOT, 'kit', 'page', 'node_modules');
  H.ok('看页面的依赖只有三个包，playwright-core 只有一份', fs.readdirSync(page).sort().join() === 'pixelmatch,playwright-core,pngjs', fs.readdirSync(page));
  H.ok('套件的代码只 require playwright-core', !/require\('playwright'\)/.test(fs.readFileSync(path.join(KIT_ROOT, 'kit', 'page', 'browser.js'), 'utf8') + fs.readFileSync(path.join(KIT_ROOT, 'kit', 'page', 'scenario-run.js'), 'utf8')));
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'prune-deps.js'), '--check'], { encoding: 'utf8', windowsHide: true });
  H.ok('依赖里没有类型声明、source map 这些', r.status === 0, r.stdout);
  H.ok('playwright-core 不带录制器、trace 查看器这些网页界面（lib/vite）', !fs.existsSync(path.join(page, 'playwright-core', 'lib', 'vite')));
  H.ok('LICENSE 留着', fs.existsSync(path.join(page, 'playwright-core', 'LICENSE')));
  H.ok('OpenSpec 的模板留着', fs.readdirSync(path.join(KIT_ROOT, 'kit', 'openspec', 'node_modules', '@fission-ai', 'openspec', 'schemas', 'spec-driven', 'templates')).some((n) => /\.md$/.test(n)));
}

H.section('session.js 的每个导出都有人用');
{
  const lib = path.join(KIT_ROOT, 'kit');
  const S = require(path.join(lib, 'lib', 'session.js'));
  const sources = walk(KIT_ROOT, []).concat(FROM ? [] : walk(path.join(REPO, 'dev'), [])).filter((f) => /\.js$/.test(f) && !/[\\/]lib[\\/]session(-[\w]+)?\.js$/.test(f) && !/test-no-leftovers\.js$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const idle = Object.keys(S).filter((n) => !new RegExp('\\b' + n + '\\b').test(sources));
  if (idle.length) console.log('没人用的导出：' + idle.join(' '));
  H.ok('没有没人用的导出', idle.length === 0, idle.length + ' 个，列在上面');
}

H.section('假用户目录真装一遍');
{
  const pkg = FROM ? (() => { const d = path.join(H.tempDir('nl-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; })() : H.makePackage('nl-pkg', '20261104.0100');
  const u = H.freshHome('nl-inst');
  // 旧版留下的依赖（新旧文件混在一起会坏）
  H.write(path.join(u.kit, 'page', 'node_modules', 'playwright', 'old-runner.js'), '// 旧版的\n');
  H.write(path.join(u.kit, 'page', 'node_modules', 'playwright-core', 'old-alpha.js'), '// 旧版的\n');
  const r = H.node(u, path.join(pkg, 'install.js'), ['--no-open'], { cwd: u.root, timeout: 240000 });
  H.ok('升级时旧的依赖文件清掉了', FROM ? true : !fs.existsSync(path.join(u.kit, 'page', 'node_modules', 'playwright', 'old-runner.js')) && !fs.existsSync(path.join(u.kit, 'page', 'node_modules', 'playwright-core', 'old-alpha.js')));
  H.ok('装好了', r.code === 0, r.out.slice(-300));
  const st = JSON.parse(H.read(path.join(u.cfg, 'settings.json')) || '{}');
  const hooks = Object.values(st.hooks || {}).flat().flatMap((g) => (g && g.hooks) || []);
  H.ok('没有 router、router-data', !fs.existsSync(path.join(u.kit, 'router')) && !fs.existsSync(path.join(u.kit, 'router-data')), fs.readdirSync(u.kit));
  H.ok('钩子全走命令，不登记 guard-push', hooks.length > 0 && hooks.every((x) => x.type === 'command') && !hooks.some((x) => /guard-push/.test(String(x.command))), hooks.filter((x) => x.type !== 'command'));
  H.ok('令牌保护的 deny 还在（只能收紧）', (st.permissions && st.permissions.deny || []).some((x) => /router-data/.test(x)) && (st.permissions.deny || []).some((x) => /secrets\.json/.test(x)), st.permissions);
  H.ok('环境变量里没有指向路由的地址', !/15730/.test(JSON.stringify(st.env || {})), st.env);
}

H.done('删干净了没有');
