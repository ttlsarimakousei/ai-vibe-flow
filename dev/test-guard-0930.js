'use strict';
/*
 * 拦截类钩子：0930 全仓审查之后改的那一批（cd 跟丢目录、读令牌的几种绕法、结束进程的写法、heredoc 里的命令、误拦正常写法）。
 * 用法：node dev/test-guard-0930.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

// 1008 起不走 OpenSpec 的提交要用户点头：这套测的是别的检查，提交选"直接提交"（2026-10-17 起是提交方式"自动"，旧开关 plainCommit 留着给旧版跑）；点头那一道在 test-1008.js 里测
const h = H.makeHome('guard0930', null, { plainCommit: 'auto', commitMode: 'auto' });
const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'frontend/package.json': '{"name":"f"}\n', 'src/A.java': 'class A {}\n' });
fs.writeFileSync(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlabToken: 'glpat-SECRET-MARKER-000001' }));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ providers: [{ name: 'x', api_key: 'sk-SECRET-MARKER' }] }));
fs.writeFileSync(path.join(h.kit, 'router-data', 'router.pid'), JSON.stringify({ pid: 424242 }));
fs.mkdirSync(path.join(h.kit, 'router'), { recursive: true });
// 结束进程的检查只在装了路由时管：测试的假用户目录里没装路由，放一个空的 router.js 让它认为装了
if (!fs.existsSync(path.join(h.kit, 'router', 'router.js'))) fs.writeFileSync(path.join(h.kit, 'router', 'router.js'), '// 假的路由\n');
const K = h.kit.replace(/\\/g, '/');
const KW = h.kit;
const CFG = h.cfg.replace(/\\/g, '/');
H.transcript(path.join(h.root, 'none.jsonl'), [H.tr.user('编译并测试')]);
const run = (tool, command, cwd) => H.hook(h, 'guard-commit', { session_id: 's-g', cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, transcript_path: path.join(h.root, 'none.jsonl') });
const blocked = (o) => !!o && (o.decision === 'block' || (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const asked = (o) => !!o && !!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'ask';
const why = (o) => H.reasonOf(o) || JSON.stringify(o);
const secret = (o) => blocked(o) && /令牌|key/.test(H.reasonOf(o));
const kit = (o) => blocked(o) && /vibe-kit 套件/.test(H.reasonOf(o));
// cd 和别的命令串在一条里被拦下（只是这一条，不是"要动套件""读令牌"那几道）
const cdHit = (o) => blocked(o) && /cd 和别的命令串在一/.test(H.reasonOf(o));
const cdOnly = (o) => blocked(o) && /^\[vibe-kit\] 这条命令(先 cd 到|里 cd 和别的命令串在一起| cd 到的就是)/.test(H.reasonOf(o));

H.section('cd 进套件目录之后，后面的相对路径照样查（$HOME 写法以前跟丢）');
for (const [tool, cmd, test, label] of [
  ['Bash', 'cd "$HOME/.claude/vibe-kit/router-data" && cat config.json', secret, '读 key'],
  ['Bash', 'cd $HOME/.claude/vibe-kit/hooks && sed -i "s/a/b/" guard-commit.js', kit, '改钩子'],
  ['Bash', 'cd ~/.claude/vibe-kit && cat secrets.json', secret, '读令牌'],
  ['PowerShell', 'Set-Location $HOME\\.claude\\vibe-kit\\router-data; Get-Content config.json', secret, '读 key'],
  ['PowerShell', 'Set-Location $env:USERPROFILE\\.claude\\vibe-kit; Set-Content -Path config.json -Value "{}"', kit, '改配置'],
  ['Bash', 'cd "$CLAUDE_CONFIG_DIR/vibe-kit/hooks" && rm pre-edit.js', kit, '删钩子'],
]) { const o = run(tool, cmd); H.ok(label + '：' + cmd.slice(0, 70), test(o), why(o)); }
{
  const o = run('Bash', 'cd "$CFGROOT/.claude/vibe-kit/hooks" && rm pre-edit.js');
  H.ok('目录用别的变量拼、又像是往套件里去：这条 cd 不放，说了怎么写', blocked(o) && /算不出来/.test(why(o)), why(o));
  const o2 = run('Bash', 'cd "$PROJ/src" && ls');
  H.ok('普通的变量目录：不当成要动套件，只说别把 cd 串在一条里', cdOnly(o2) && !/算不出来/.test(why(o2)), why(o2));
}

H.section('读令牌的几种绕法：PowerShell 的 Join-Path、子表达式、管道传文件；通配符落在套件那一级；搜整个用户目录');
for (const [tool, cmd] of [
  ['PowerShell', "Get-Content (Join-Path $HOME '.claude\\vibe-kit\\router-data\\config.json')"],
  ['PowerShell', 'Get-ChildItem $HOME\\.claude\\vibe-kit\\router-data | Get-Content'],
  ['PowerShell', 'Get-ChildItem -Recurse ~\\.claude -Filter *.json | Select-String key'],
  ['Bash', 'cat $(ls ~/.claude/vibe-kit/secrets.json)'],
  ['Bash', 'cat ~/.claude/*/secrets.json'],
  ['Bash', 'cat "' + CFG + '/vibe-k*/router-data/config.json"'],
  ['PowerShell', 'Get-Content ~\\.claude\\vibe-k*\\router-data\\config.json'],
  ['Bash', 'grep -rn glpat ~'],
  ['Bash', 'grep -r api_key "' + h.home.replace(/\\/g, '/') + '"'],
  ['PowerShell', 'findstr /s /i token "$env:USERPROFILE\\*.json"'],
  ['Bash', 'rg glpat ' + CFG],
  ['Bash', 'powershell -Command "Get-Content (Join-Path $HOME \'.claude\\vibe-kit\\secrets.json\')"'],
]) { const o = run(tool, cmd); H.ok('拦：' + cmd.replace(K, '<套件>').replace(KW, '<套件>').replace(CFG, '<.claude>').slice(0, 80), secret(o), why(o)); }
// 这两条先被"不许改套件"拦下（xargs、ForEach-Object 在管道里接着套件的路径），也算拦住了
for (const [tool, cmd] of [['PowerShell', 'gci "' + KW + '" | % { gc $_.FullName }'], ['Bash', 'ls ' + K + '/router-data | xargs cat']]) { const o = run(tool, cmd); H.ok('拦：' + cmd.replace(K, '<套件>').replace(KW, '<套件>').slice(0, 70), blocked(o), why(o)); }
H.section('只是列一列、算路径：放行');
for (const [tool, cmd] of [
  ['Bash', 'ls ~/.claude/vibe-kit/router-data'],
  ['PowerShell', 'Get-ChildItem $HOME\\.claude\\vibe-kit\\router-data'],
  ['Bash', 'ls -la ' + K],
  ['PowerShell', 'Test-Path "' + KW + '\\secrets.json"'],
  ['Bash', 'grep -n port ' + K + '/config.json'],
  ['Bash', 'cat ' + K + '/config.json'],
  ['Bash', 'grep -rn "todo" src/'],
  ['PowerShell', 'Get-ChildItem -Recurse src -Filter *.java | Select-String TODO'],
  ['Bash', 'cat ~/.claude/skills/ttls-redis/SKILL.md'],
]) { const o = run(tool, cmd); H.ok('放行：' + cmd.replace(K, '<套件>').replace(KW, '<套件>').slice(0, 70), o === null, why(o)); }

H.section('先按名字挑出进程再结束：路由会被一起杀掉');
for (const [tool, cmd] of [
  ['PowerShell', "Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process -Force"],
  ['PowerShell', 'Get-Process node | ForEach-Object { Stop-Process -Id $_.Id -Force }'],
  ['PowerShell', "Get-Process | ? { $_.ProcessName -like 'node*' } | % { $_.Kill() }"],
  ['PowerShell', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Invoke-CimMethod -MethodName Terminate"],
  ['Bash', 'ps -ef | grep node | grep -v grep | awk \'{print $2}\' | xargs kill -9'],
  ['PowerShell', 'Get-Process | Where-Object { $_.Id -eq 424242 } | Stop-Process'],
]) { const o = run(tool, cmd); H.ok('拦：' + cmd.slice(0, 80), blocked(o) && /路由/.test(why(o)), why(o)); }
for (const [tool, cmd] of [
  ['PowerShell', 'Get-Process | Where-Object { $_.Id -eq 5555 } | Stop-Process'],
  ['PowerShell', 'Stop-Process -Id 5555'],
  ['Bash', 'ps -ef | grep java'],
]) { const o = run(tool, cmd); H.ok('放行：' + cmd.slice(0, 80), o === null, why(o)); }

H.section('heredoc、eval 里的命令也是命令');
{
  const o1 = run('Bash', "bash <<'EOF'\ngit push origin main\nEOF");
  H.ok('bash <<EOF 里的 push：也先预览', blocked(o1) && /推送预览/.test(why(o1)), why(o1));
  const o2 = run('Bash', 'eval "git push origin main"');
  H.ok('eval 里的 push：也先预览', blocked(o2) && /推送预览/.test(why(o2)), why(o2));
  const o3 = run('Bash', "python - <<'EOF'\nimport os\nprint(open(os.path.expanduser('~/.claude/vibe-kit/secrets.json')).read())\nEOF");
  H.ok('python - <<EOF 里读令牌：拦', blocked(o3), why(o3));
  const o4 = run('Bash', "node - <<'EOF'\nrequire('fs').writeFileSync(process.env.HOME + '/.claude/vibe-kit/hooks/pre-edit.js', '')\nEOF");
  H.ok('node - <<EOF 里改钩子：拦', kit(o4), why(o4));
  const o5 = run('PowerShell', "powershell -Command @'\nGet-Content \"$HOME\\.claude\\vibe-kit\\secrets.json\"\n'@");
  H.ok('powershell -Command 后面跟 here-string：拦', blocked(o5), why(o5));
  const o6 = run('Bash', "cat <<'EOF' > notes.txt\n记一下：git push 要用户确认\nEOF");
  H.ok('cat <<EOF 写文件：正文是数据，不当命令（里面提到 git push 不问）', o6 === null, why(o6));
  const o7 = run('Bash', "git commit -m \"$(cat <<'EOF'\nfeat: 加导出\n\n里面有 git push 三个字\nEOF\n)\"");
  H.ok('提交信息用 heredoc：照样认格式，不当 push', o7 === null, why(o7));
}

H.section('内联代码的几种写法：-pe、-Bc、-c"…"、--eval=');
for (const [tool, cmd] of [
  ['Bash', 'node -pe "require(\'fs\').writeFileSync(require(\'os\').homedir()+\'/.claude/vibe-kit/config.json\',\'{}\')"'],
  ['Bash', 'python -Bc "open(\'' + K + '/config.json\',\'w\').write(\'x\')"'],
  ['Bash', 'python -c"open(\'' + K + '/config.json\',\'w\').write(\'x\')"'],
  ['Bash', 'node --eval="require(\'fs\').rmSync(\'' + K + '/hooks\',{recursive:true})"'],
  ['Bash', 'node --eval="require(\'fs\').writeFileSync(\'' + K + '/hooks/pre-edit.js\',\'\')" "$HOME/.claude/skills/ttls-redis/scripts/redis.js"'],
  ['Bash', 'python -c"open(\'' + K + '/config.json\',\'w\')" "$HOME/.claude/skills/ttls-db-crud/scripts/db.py"'],
]) { const o = run(tool, cmd); H.ok('拦：' + cmd.replace(K, '<套件>').slice(0, 80), kit(o), why(o)); }
H.ok('-pe 里不提套件的照常', run('Bash', 'node -pe "1+1"') === null);

H.section('跑技能脚本、套件工具的正常写法：放行');
// cd 进技能、套件的目录再跑脚本：不当成"要改套件"（审查 3-11），但 cd 串在一条里这件事照样拦，给出写全路径的办法
for (const [cmd, want] of [
  ['cd ~/.claude/skills/ttls-db-crud && python scripts/db.py find 订单', /skills\/ttls-db-crud\/scripts\/db\.py"/],
  ['cd ~/.claude/vibe-kit && node tools/lesson.js list', /vibe-kit\/tools\/lesson\.js"/],
]) { const o = run('Bash', cmd); H.ok('只拦 cd，建议里是脚本的完整路径：' + cmd.slice(0, 60), cdOnly(o) && want.test(why(o)), why(o)); }
for (const [tool, cmd, cwd] of [
  ['Bash', 'timeout 120 python "$HOME/.claude/skills/ttls-db-crud/scripts/db.py" query --sql "select 1"'],
  ['Bash', 'timeout -s KILL 30 node "$HOME/.claude/vibe-kit/tools/drivers.js" list'],
  ['Bash', 'cmd //c python "' + CFG + '/skills/ttls-db-crud/scripts/db.py" doctor'],
  ['Bash', 'winpty python "$HOME/.claude/skills/ttls-db-crud/scripts/db.py" doctor'],
  ['Bash', 'python scripts/db.py --conn dev peek --table t_user', path.join(h.cfg, 'skills', 'ttls-db-crud')],
  ['Bash', 'grep -n "install" ~/.claude/skills/ttls-onboard/SKILL.md'],
  ['PowerShell', 'Select-String -Pattern "copy" -Path ~\\.claude\\skills\\ttls-see-page\\SKILL.md'],
  ['Bash', 'grep -n mkdir ' + K + '/README.md'],
  ['Bash', 'grep -n disableAllHooks ~/.claude/settings.json'],
  ['Bash', 'node "$HOME/.claude/vibe-kit/tools/feedback.js" add --kind 出错 --title "配置页 http://127.0.0.1:15730/ui 打不开" --what "点了没反应"'],
]) { const o = run(tool, cmd, cwd); H.ok('放行：' + cmd.replace(K, '<套件>').replace(CFG, '<.claude>').slice(0, 80), o === null, why(o)); }
for (const [tool, cmd, cwd] of [
  ['Bash', 'cd ~/.claude/skills/ttls-db-crud && cp scripts/db.py scripts/db.py.bak'],
  ['Bash', 'cd ~/.claude/vibe-kit && echo x > hooks/new.js'],
  ['Bash', 'python scripts/db.py --config ../../vibe-kit/config.json doctor', path.join(h.cfg, 'skills', 'ttls-db-crud')],
  ['Bash', 'echo disableAllHooks > ~/.claude/settings.json'],
  ['Bash', 'curl -X POST http://127.0.0.1:15730/api/config -d "{}"'],
  ['Bash', 'grep -rl x ~/.claude/vibe-kit/hooks | xargs rm'],
]) { const o = run(tool, cmd, cwd); H.ok('照拦：' + cmd.slice(0, 80), blocked(o), why(o)); }

H.section('子 shell 里的 cd、popd、cd - 不带出括号');
{
  H.write(path.join(proj, 'frontend', 'src', 'New.vue'), '<template/>\n');
  const tf = H.transcript(path.join(h.root, 'w.jsonl'), [H.tr.user('编译并测试')].concat(H.tr.ran('Write', { file_path: path.join(proj, 'frontend', 'src', 'New.vue'), content: 'x' }, 'ok')));
  const withTf = (tool, command) => H.hook(h, 'guard-commit', { session_id: 's-cd', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, transcript_path: tf });
  // Bash 里串着 cd 的现在一律拦（见最后一节），这里看的是拦的理由：不能是"新文件没 add"（那说明目录算错了）
  const notAdd = (o) => cdOnly(o) && !/没有 git add|还没 git add|没 add/.test(why(o));
  const o1 = withTf('Bash', '(cd frontend && npm run build) && git add frontend/src/New.vue && git commit -m "feat: x"');
  H.ok('括号里的 cd 出了括号就不算：git add 的路径按项目根算，不会误报"新文件没 add"', notAdd(o1), why(o1));
  const o2 = withTf('PowerShell', 'Push-Location frontend; npm run build; Pop-Location; git add frontend/src/New.vue; git commit -m "feat: x"');
  H.ok('Push-Location / Pop-Location 按栈来', o2 === null, why(o2));
  const o3 = withTf('Bash', 'cd frontend && cd - && git add frontend/src/New.vue && git commit -m "feat: x"');
  H.ok('cd -：不知道回到哪，当前目录不动（按原来的算）', notAdd(o3), why(o3));
}

H.section('编码检查');
{
  const edit = (file, content, tool) => H.hook(h, 'pre-edit', { session_id: 's-enc', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool || 'Write', tool_input: { file_path: file, content }, transcript_path: path.join(h.root, 'none.jsonl') });
  // 老工程：pom 开头有 <?xml … encoding="UTF-8"?>，却没写源码的编码（按平台编码 GBK 编译）；周围没有别的带中文的 .java
  const old = H.makeRepo(path.join(h.work, 'oldproj'), { 'pom.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<project><modelVersion>4.0.0</modelVersion></project>\n' });
  const gbkFile = path.join(old, 'src', 'main', 'java', 'A.java');
  fs.mkdirSync(path.dirname(gbkFile), { recursive: true });
  fs.writeFileSync(gbkFile, Buffer.concat([Buffer.from('class A { String s = "'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('"; }\n')]));
  const e1 = H.hook(h, 'pre-edit', { session_id: 's-enc', cwd: old, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: gbkFile, old_string: 'class A', new_string: 'class A ' }, transcript_path: path.join(h.root, 'none.jsonl') });
  H.ok('pom 开头的 XML 声明不算源码的编码：按 GBK 为主处理，不建议转码', blocked(e1) && /整体按 GBK 编译/.test(why(e1)) && !/可以先转成 UTF-8/.test(why(e1)), why(e1));
  fs.writeFileSync(path.join(old, 'pom.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<project><properties><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>\n');
  const e2 = H.hook(h, 'pre-edit', { session_id: 's-enc', cwd: old, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: gbkFile, old_string: 'class A', new_string: 'class A ' }, transcript_path: path.join(h.root, 'none.jsonl') });
  H.ok('pom 里写了 sourceEncoding=UTF-8：照旧给转码的办法', blocked(e2) && /可以先转成 UTF-8/.test(why(e2)), why(e2));
  // 新建的 .ps1 带中文
  const ps1 = path.join(proj, '.vibe', 'tmp', 'probe', 'probe.ps1');
  const p1 = edit(ps1, 'Write-Output "检查通过"\n');
  H.ok('新建的 .ps1 里有中文：拦一次，说了怎么办', blocked(p1) && /PowerShell 5\.1/.test(why(p1)) && /\.js/.test(why(p1)), why(p1));
  H.ok('原样再写一次：放行（跑它的可能是 PowerShell 7）', edit(ps1, 'Write-Output "检查通过"\n') === null);
  H.ok('纯英文的 .ps1：不拦', edit(path.join(proj, '.vibe', 'tmp', 'probe', 'b.ps1'), 'Write-Output "ok"\n') === null);
  H.ok('开头带 BOM 的：不拦', edit(path.join(proj, '.vibe', 'tmp', 'probe', 'c.ps1'), '\uFEFFWrite-Output "检查通过"\n') === null);
}

H.section('cd 和别的命令串在一条里：拦下，给出不用 cd 的写法（内网 0930：跳过权限模式下也弹确认框；项目里写了"不要用 cd"之后没再弹）');
{
  const P = proj.replace(/\\/g, '/');
  for (const [cmd, want, label] of [
    ['cd frontend && npm run build', /npm --prefix "frontend" run build/, 'npm：用 --prefix'],
    ['cd frontend && mvn -q compile 2>&1 | tail -20', /mvn -f "frontend\/pom\.xml" -q compile/, 'Maven：用 -f'],
    ['cd frontend && git log --oneline -- src/main.js', /git -C "frontend" log --oneline -- src\/main\.js/, 'git：用 -C'],
    ['cd frontend && pnpm install', /pnpm -C "frontend" install/, 'pnpm：用 -C'],
    ['cd frontend && yarn build', /yarn --cwd "frontend" build/, 'yarn：用 --cwd'],
    ['cd frontend && ./gradlew build', /gradlew" -p "frontend" build/, 'Gradle：用 -p'],
    ['cd "' + P + '/frontend" && grep -rn "EC_TYPE" src/views/', /path 写 "frontend\/src\/views\/"/, '反馈原样的写法：cd 子项目再 grep，建议里是相对会话目录的路径'],
    ['cd "D:/x/jssslt-oa" && grep -rn "enum\\|QIQ\\|=\\s*\\"" backend/src/com/skytech/ | head -25 && echo "== 字典"', /"D:\/x\/jssslt-oa\/backend\/src\/com\/skytech\/"/, '截图里的整条命令：cd 到会话目录以外，建议里是完整路径'],
    ['cd frontend && cat package.json', /读文件用 Read/, 'cat：用 Read'],
    ["cd frontend && sed -n '1,20p' src/main.js", /"frontend\/src\/main\.js"/, 'sed：第一个参数是脚本，后面的才是路径'],
    ['cd frontend && rm -rf dist', /rm … "frontend\/dist"/, '删东西：路径写全'],
    ['cd frontend && grep -n ERROR', /path 写 "frontend"/, 'grep 没给路径：path 写那个目录'],
    ['cd frontend && node scripts/gen.js --x', /"frontend\/scripts\/gen\.js"/, '跑脚本：脚本写完整路径'],
    ['cd frontend && node "$HOME/.claude/vibe-kit/tools/devserver.js" start --name web --port 5173 --hot -- npm run dev', /start 后面加 --cwd "frontend"/, '起服务的工具：start 用 --cwd'],
    ['cd frontend && node "$HOME/.claude/vibe-kit/tools/devserver.js" stop --all', /stop、status 后面加 --dir "frontend"/, '起服务的工具：stop 用 --dir（以前 cd 进去起的，记录在那个目录里）'],
    ['cd "' + P + '" && cat pom.xml', /cd 到的就是现在所在的目录[\s\S]*去掉 cd/, 'cd 到的就是会话目录：去掉 cd'],
    ['(cd frontend && npm test) && cat pom.xml', /npm --prefix "frontend" test/, '括号里的 cd 也算'],
    ['cd frontend && npx eslint src/a.vue', /cd "frontend" 单独跑一条/, '没有指目录的参数的命令：cd 单独跑一条'],
    ['cd "$(git rev-parse --show-toplevel)" && cat pom.xml', /git 用 git -C <目录>/, 'cd 到哪算不出来：说通用的办法'],
  ]) { const o = run('Bash', cmd); H.ok('拦：' + label, cdOnly(o) && want.test(why(o)), why(o)); }
  for (const [tool, cmd, label] of [
    ['Bash', 'cd frontend', '单独一条 cd'],
    ['Bash', 'grep -rn EC_TYPE frontend/src', '没 cd'],
    ['Bash', 'mvn -f frontend/pom.xml -q compile 2>&1 | tail -20', '照建议改过的 Maven'],
    ['Bash', 'npm --prefix frontend run build', '照建议改过的 npm'],
    ['Bash', 'git -C frontend status', '照建议改过的 git'],
    ['Bash', 'echo "cd frontend && npm run build"', '引号里的字'],
    ['PowerShell', 'Set-Location frontend; Get-Content package.json', 'PowerShell 不管'],
  ]) { const o = run(tool, cmd); H.ok('不拦：' + label, o === null, why(o)); }
  // 别的检查先拦下的：末尾顺带提一句 cd，免得改完一处、再跑又被拦一次
  const both = run('Bash', 'cd frontend && git add -A');
  H.ok('整仓 add 串着 cd：先说 add，末尾带一句 cd', blocked(both) && /git add -A/.test(why(both)) && /另外，这条命令里 cd 和别的命令串在一起/.test(why(both)), why(both));
  const srv = run('Bash', 'cd frontend && npm run dev');
  H.ok('直接起服务串着 cd：说用 devserver.js，并且说了 --cwd', blocked(srv) && /devserver\.js/.test(why(srv)) && /start 后面加 --cwd <子目录>/.test(why(srv)), why(srv));
  // 关了"禁止改套件"也照样拦：这一条和套件的开关无关
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const before = fs.readFileSync(path.join(h.kit, 'config.json'), 'utf8');
  H.setConfig(h, { kitLock: false });
  S.sealConfig(h.kit, JSON.parse(fs.readFileSync(path.join(h.kit, 'config.json'), 'utf8')));
  const o = run('Bash', 'cd frontend && cat package.json');
  H.ok('关了禁止改套件：照样拦', cdOnly(o), why(o));
  fs.writeFileSync(path.join(h.kit, 'config.json'), before);
  S.sealConfig(h.kit, JSON.parse(before));
}


H.section('全局的状态文件坏了：留一份，从空的重新记（以前一坏就再也写不进去）');
{
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const f = path.join(h.kit, 'state', 'reviewed.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"c:/x/openspec/changes/a": {"done": tr');
  const now = Date.now() / 1000;
  fs.utimesSync(f, now - 60, now - 60);
  const r = S.updateState('reviewed', (o) => { o['c:/x/openspec/changes/b'] = { done: true, at: Date.now() }; return o; });
  H.ok('写进去了', !!r && JSON.parse(fs.readFileSync(f, 'utf8'))['c:/x/openspec/changes/b'].done === true, fs.readFileSync(f, 'utf8'));
  H.ok('坏掉的那一份改名留着', fs.existsSync(f + '.bad') && /"done": tr/.test(fs.readFileSync(f + '.bad', 'utf8')));
  fs.writeFileSync(f, '{"half');
  H.ok('刚写的、读不懂的（别人可能正在写）：这次不写，不去冲掉', S.updateState('reviewed', (o) => o) === null && fs.readFileSync(f, 'utf8') === '{"half');
}

H.done('拦截类钩子（0930 审查之后）');
