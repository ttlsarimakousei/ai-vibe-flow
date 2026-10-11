'use strict';
/*
 * 令牌和模型的 key 不给模型看；发布脚本和 push 一样要用户确认；安装器加的"不许读"权限规则。
 * 用法：node dev/test-secrets.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('sec');
const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'scripts/publish.js': '// 项目自己的发布脚本\n' });
fs.writeFileSync(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlabToken: 'glpat-SECRET-MARKER-000001' }));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ providers: [{ name: 'x', api_key: 'sk-SECRET-MARKER' }] }));
const K = h.kit.replace(/\\/g, '/');
const KW = h.kit;
const run = (tool, command, cwd) => H.hook(h, 'guard-commit', { session_id: 's-sec', cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, transcript_path: path.join(h.root, 'none.jsonl') });
const blocked = (o) => !!o && (o.decision === 'block' || (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const asked = (o) => !!o && !!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'ask';
const secretBlock = (o) => blocked(o) && /令牌|key/.test(H.reasonOf(o));

H.section('用命令读令牌、读模型的 key：拦');
for (const [tool, cmd] of [
  ['Bash', 'cat ~/.claude/vibe-kit/secrets.json'],
  ['Bash', 'cat "$HOME/.claude/vibe-kit/secrets.json"'],
  ['Bash', 'cat "' + K + '/secrets.json"'],
  ['Bash', 'head -5 ' + K + '/router-data/config.json'],
  ['Bash', 'cat ' + K + '/*.json'],
  ['Bash', 'cat ' + K + '/s*'],
  ['Bash', 'cat ' + K + '/router-data/*'],
  ['Bash', 'grep -r token ' + K],
  ['Bash', 'grep -rn api_key ~/.claude'],
  ['Bash', 'rg glpat ' + K + '/'],
  ['Bash', 'find ' + K + ' -name "*.json" -exec cat {} +'],
  ['Bash', 'jq . ' + K + '/secrets.json'],
  ['Bash', 'base64 ' + K + '/secrets.json'],
  ['Bash', 'node -e "console.log(require(\'fs\').readFileSync(\'' + K + '/secrets.json\', \'utf8\'))"'],
  ['Bash', 'node -e "const p=require(\'path\');console.log(require(\'fs\').readFileSync(p.join(process.env.USERPROFILE,\'.claude\',\'vibe-kit\',\'secrets.json\'),\'utf8\'))"'],
  ['Bash', 'python -c "print(open(r\'' + K + '/router-data/config.json\').read())"'],
  ['Bash', 'echo ok && cat ' + K + '/secrets.json | head -1'],
  ['PowerShell', 'Get-Content "' + KW + '\\secrets.json"'],
  ['PowerShell', 'Get-Content $env:USERPROFILE\\.claude\\vibe-kit\\secrets.json'],
  ['PowerShell', 'gc "' + KW + '\\router-data\\config.json" | Select-Object -First 3'],
  ['PowerShell', 'Select-String -Path "' + KW + '\\*.json" -Pattern token'],
  ['PowerShell', '[System.IO.File]::ReadAllText("' + KW + '\\secrets.json")'],
  ['PowerShell', 'type "' + KW + '\\secrets.json"'],
]) {
  const o = run(tool, cmd);
  // 被'禁止改套件'先拦下的也算拦住了（那几条命令本来就不在只读命令的单子里）
  H.ok(tool + '：' + cmd.replace(K, '<套件>').replace(KW, '<套件>').slice(0, 70), blocked(o), H.reasonOf(o) || o);
}
{
  const o = run('Bash', 'cat secrets.json', h.kit);
  H.ok('人就站在套件目录里：cat secrets.json 也拦', secretBlock(o), H.reasonOf(o) || o);
  const o2 = run('Bash', 'cat router-data/config.json', h.kit);
  H.ok('人就站在套件目录里：cat router-data/config.json 也拦', secretBlock(o2), H.reasonOf(o2) || o2);
}

H.section('用 Grep 工具搜：范围里有令牌、要看内容的，拦');
{
  const grep = (input, cwd) => H.hook(h, 'guard-read', { session_id: 's-sec', cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: input, transcript_path: path.join(h.root, 'none.jsonl') });
  const root = path.parse(h.kit).root;
  for (const [name, input, cwd] of [
    ['对着套件目录搜内容', { pattern: 'token', path: h.kit, output_mode: 'content' }],
    ['对着 ~/.claude 搜内容', { pattern: 'glpat', path: h.cfg, output_mode: 'content', glob: '*.json' }],
    ['写成 ~/.claude', { pattern: 'glpat', path: '~/.claude', output_mode: 'content' }],
    ['对着用户目录搜内容', { pattern: 'api_key', path: h.home, output_mode: 'content' }],
    ['对着整个盘搜内容', { pattern: 'api_key', path: root, output_mode: 'content' }],
    ['路径用正斜杠、大小写不一样', { pattern: 'x', path: K.toUpperCase(), output_mode: 'content' }],
    ['没给路径，人就站在套件目录里', { pattern: 'x', output_mode: 'content' }, h.kit],
    ['没给路径，人站在 ~/.claude 里', { pattern: 'x', output_mode: 'content' }, h.cfg],
    ['直接对着 router-data 里面搜', { pattern: 'x', path: path.join(h.kit, 'router-data', 'backups'), output_mode: 'content' }],
    ['直接对着 secrets.json 搜', { pattern: 'x', path: path.join(h.kit, 'secrets.json'), output_mode: 'content' }],
  ]) {
    const o = grep(input, cwd);
    H.ok(name, blocked(o) && /令牌/.test(H.reasonOf(o)) && /files_with_matches/.test(H.reasonOf(o)), H.reasonOf(o) || o);
  }
  for (const [name, input, cwd] of [
    ['只看文件名（没写 output_mode）', { pattern: 'token', path: h.kit }],
    ['只看文件名', { pattern: 'token', path: h.cfg, output_mode: 'files_with_matches' }],
    ['只数个数', { pattern: 'token', path: h.kit, output_mode: 'count' }],
    ['搜套件的钩子目录', { pattern: 'kitLock', path: path.join(h.kit, 'hooks'), output_mode: 'content' }],
    ['搜套件的开关文件', { pattern: 'autoUpdate', path: path.join(h.kit, 'config.json'), output_mode: 'content' }],
    ['搜项目', { pattern: 'class', path: proj, output_mode: 'content' }],
    ['没给路径，人站在项目里', { pattern: 'class', output_mode: 'content' }],
    ['项目里也有个叫 router-data 的目录', { pattern: 'x', path: path.join(proj, 'router-data'), output_mode: 'content' }],
  ]) {
    const o = grep(input, cwd);
    H.ok('放行：' + name, o === null, H.reasonOf(o) || o);
  }
  const read = H.hook(h, 'guard-read', { session_id: 's-sec', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.kit, 'secrets.json') } });
  H.ok('别的工具不归它管（Read 由权限规则挡）', read === null, read);
  H.setConfig(h, { kitLock: false });
  H.ok('关掉了禁改：照样拦', blocked(grep({ pattern: 'token', path: h.kit, output_mode: 'content' })));
  H.setConfig(h, { kitLock: true });
  H.ok('套件目录里有 .ignore，让搜索工具跳过这两处', /^secrets\.json$/m.test(H.read(path.join(h.kit, '.ignore')) || '') && /^router-data\/$/m.test(H.read(path.join(h.kit, '.ignore')) || ''), H.read(path.join(h.kit, '.ignore')));
}

H.section('不该拦的照常放行');
for (const [tool, cmd, cwd] of [
  ['Bash', 'cat ~/.claude/vibe-kit/config.json'],
  ['Bash', 'cat ' + K + '/VERSION'],
  ['Bash', 'ls -la ' + K],
  ['Bash', 'ls ' + K + '/router-data'],
  ['Bash', 'ls -la ' + K + '/secrets.json'],
  ['Bash', 'grep -rn kick ' + K + '/hooks'],
  ['Bash', 'grep -n autoUpdate ' + K + '/config.json'],
  ['Bash', 'node "' + K + '/tools/feedback.js" list'],
  ['Bash', 'cat src/main/resources/secrets.json'],
  ['Bash', 'cat docs/router-data/readme.md'],
  ['Bash', 'grep -rn secrets.json src'],
  ['Bash', 'git status'],
  ['PowerShell', 'Get-Content "' + KW + '\\config.json"'],
  ['PowerShell', 'Get-ChildItem "' + KW + '\\router-data"'],
  ['PowerShell', 'Test-Path "' + KW + '\\secrets.json"'],
]) {
  const o = run(tool, cmd, cwd);
  H.ok(tool + '：' + cmd.replace(K, '<套件>').replace(KW, '<套件>').slice(0, 70), !blocked(o) && !asked(o), H.reasonOf(o) || o);
}

H.section('关掉了"禁止 Claude 自己改套件"：令牌照样不给读');
{
  H.setConfig(h, { kitLock: false });
  H.ok('cat secrets.json：拦', secretBlock(run('Bash', 'cat ' + K + '/secrets.json')));
  H.ok('cat *.json：拦', secretBlock(run('Bash', 'cat ' + K + '/*.json')));
  H.ok('PowerShell 读 router-data：拦', secretBlock(run('PowerShell', 'Get-Content "' + KW + '\\router-data\\config.json"')));
  H.ok('find -exec cat：拦', secretBlock(run('Bash', 'find ' + K + ' -name "*.json" -exec cat {} +')));
  H.ok('base64：拦', secretBlock(run('Bash', 'base64 ' + K + '/secrets.json')));
  H.ok('PowerShell 调 .NET 读：拦', secretBlock(run('PowerShell', '[System.IO.File]::ReadAllText("' + KW + '\\secrets.json")')));
  H.ok('node -e 读：拦', secretBlock(run('Bash', 'node -e "console.log(require(\'fs\').readFileSync(\'' + K + '/secrets.json\', \'utf8\'))"')));
  H.ok('读开关、列目录：放行', !blocked(run('Bash', 'cat ' + K + '/config.json')) && !blocked(run('Bash', 'ls ' + K)));
  H.ok('不相干的命令：放行', run('Bash', 'mvn -q test') === null);
  H.setConfig(h, { kitLock: true });
}

H.section('跑发布脚本：和 push 一样要用户确认');
{
  const pkg = H.makePackage('sec-pkg', '20260920.0900');
  const P = pkg.replace(/\\/g, '/');
  for (const [tool, cmd, cwd] of [
    ['Bash', 'node publish.js', pkg],
    ['Bash', 'node "' + P + '/publish.js" --no-install', proj],
    ['Bash', 'node ./publish.js --dry-run', pkg],
    ['PowerShell', 'node "' + pkg + '\\publish.js"', proj],
    ['PowerShell', 'Set-Location "' + pkg + '"; node publish.js', proj],
    ['PowerShell', '& "' + pkg + '\\发布到 GitLab（双击我）.bat"', proj],
    ['Bash', 'cmd //c "' + P + '/发布到 GitLab（双击我）.bat"', proj],
  ]) {
    const o = run(tool, cmd, cwd);
    H.ok(tool + '：' + cmd.replace(P, '<安装包>').replace(pkg, '<安装包>').slice(0, 70), asked(o) && /发布/.test(H.reasonOf(o)), H.reasonOf(o) || o);
  }
  // 先 cd 到安装包目录再发布：cd 和别的命令串在一条里会停在 Claude Code 的确认框上，先拦下让它把脚本路径写全；写全了的那一条照样要确认（上面第二条）
  {
    const o = run('Bash', 'cd "' + P + '" && node publish.js --rollback', proj);
    H.ok('cd 到安装包目录再发布：拦下，没有悄悄放过去', blocked(o) && !asked(o) && /cd 和别的命令串在一/.test(H.reasonOf(o)) && /publish\.js"/.test(H.reasonOf(o)), H.reasonOf(o) || o);
  }
  H.setConfig(h, { kitLock: false });
  H.ok('关掉了禁改：照样要确认', asked(run('Bash', 'node publish.js', pkg)));
  H.setConfig(h, { kitLock: true });
  H.ok('项目自己的 publish.js（旁边没有安装包）：不问', !asked(run('Bash', 'node scripts/publish.js', proj)) && !blocked(run('Bash', 'node scripts/publish.js', proj)));
  H.ok('提交信息里提到 publish.js：不问', !asked(run('Bash', 'git log --oneline --grep "publish.js"', proj)));
  H.ok('git push 先预览再由用户确认', blocked(run('Bash', 'git push origin main', proj)) && /推送预览/.test(H.reasonOf(run('Bash', 'git push origin main', proj))));
}

H.section('安装器：加"不许读"的权限规则');
{
  const pkg = H.makePackage('sec-inst', '20260921.0900');
  const u = H.freshHome('sec-u');
  const settings = (x) => JSON.parse(H.read(path.join(x.cfg, 'settings.json')) || '{}');
  const manifest = (x) => JSON.parse(H.read(path.join(x.kit, 'installed.json')) || '{}');
  fs.writeFileSync(path.join(u.cfg, 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }, null, 2));
  const r = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 180000 });
  const want = ['Read(~/.claude/vibe-kit/secrets.json)', 'Read(~/.claude/vibe-kit/router-data/**)'];
  H.ok('装上了，规则加进去了', r.code === 0 && want.every((w) => settings(u).permissions.deny.includes(w)), settings(u).permissions);
  H.ok('用户自己的规则还在', settings(u).permissions.deny.includes('Read(./.env)'));
  const pre = (settings(u).hooks || {}).PreToolUse || [];
  H.ok('登记了搜索保护的钩子（Grep）', pre.some((g) => g.matcher === 'Grep' && JSON.stringify(g.hooks).includes('guard-read')), pre);
  H.ok('装上了 .ignore', fs.existsSync(path.join(u.kit, '.ignore')));
  H.ok('记成自己加的', want.every((w) => manifest(u).deny.includes(w)) && !manifest(u).deny.includes('Read(./.env)'), manifest(u).deny);
  const s1 = settings(u);
  s1.permissions.deny = s1.permissions.deny.filter((x) => x !== want[1]);
  fs.writeFileSync(path.join(u.cfg, 'settings.json'), JSON.stringify(s1, null, 2));
  const r2 = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 180000 });
  H.ok('用户删掉的一条：再装不补回来', r2.code === 0 && !settings(u).permissions.deny.includes(want[1]) && settings(u).permissions.deny.includes(want[0]), settings(u).permissions.deny);
  const un = H.node(u, path.join(u.kit, 'install.js'), ['--uninstall'], { cwd: u.root, timeout: 180000 });
  H.ok('卸载：自己加的收回，用户的留着', un.code === 0 && JSON.stringify(settings(u).permissions.deny) === '["Read(./.env)"]', [un.out.slice(-400), settings(u).permissions]);
  H.ok('卸载时说了仓库地址和令牌留着', /gitlab\.json、secrets\.json/.test(un.out), un.out);
  H.ok('卸载：钩子摘掉了，.ignore 删了', !JSON.stringify(settings(u).hooks || {}).includes('guard-read') && !fs.existsSync(path.join(u.kit, '.ignore')), settings(u).hooks);
  // 用户目录指到了家目录外面
  const v = H.freshHome('sec-v');
  const out = path.join(v.root, 'elsewhere', '.claude');
  fs.mkdirSync(out, { recursive: true });
  const r3 = H.node(v, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: v.root, timeout: 180000, env: { CLAUDE_CONFIG_DIR: out } });
  const deny = (JSON.parse(H.read(path.join(out, 'settings.json')) || '{}').permissions || {}).deny || [];
  const abs = out.replace(/\\/g, '/');
  const expect = '//' + abs[0].toLowerCase() + abs.slice(2) + '/vibe-kit';
  H.ok('用户目录不在家目录下面：规则写成 //盘符/… 的绝对路径', r3.code === 0 && deny.includes('Read(' + expect + '/secrets.json)') && deny.includes('Read(' + expect + '/router-data/**)'), deny);
}
H.done('令牌保护、发布确认');
