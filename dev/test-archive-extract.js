'use strict';
/* 归档临时查看不能解到项目根或源码目录。只调用真实钩子，不执行待测解压命令。
 * 覆盖 Bash、PowerShell、包装命令、IDEA 终端、相对路径、联接和全自动。
 * 可传旧套件目录，确认旧版确实漏掉这些入口；全部使用支架的假用户和假项目。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const from = process.argv[2] ? path.resolve(process.argv[2]) : H.SRC;
const h = H.makeHome('archive-extract', from, { autoUpdate: 'off', issueUpload: 'off', usageReport: 'off', autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', specGate: false });
const repo = H.makeRepo(path.join(h.work, '中文 项目'), { 'src/a.js': 'const a = 1;\n' });
const tmp = path.join(repo, '.vibe/tmp/1011-查包');
fs.mkdirSync(tmp, { recursive: true });
const transcript = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('检查依赖包的内容')]);
const slash = p => p.replace(/\\/g, '/');
const q = p => '"' + slash(p) + '"';
const data = (command, tool, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: tool || 'Bash', tool_input: { command }, cwd: cwd || repo, session_id: 'archive-extract', transcript_path: transcript });
const call = (command, tool, cwd) => H.hook(h, 'guard-commit', data(command, tool, cwd));
const denied = r => !!r && (r.decision === 'block' || r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny');
const bad = (label, command, tool, cwd) => { const r = call(command, tool, cwd); H.ok(label, denied(r) && /归档解包/.test(H.reasonOf(r)) && /\.vibe\/tmp\//.test(H.reasonOf(r)), H.reasonOf(r)); };
const good = (label, command, tool, cwd) => { const r = call(command, tool, cwd); H.ok(label, r === null, H.reasonOf(r)); };

for (const [label, command, tool] of [
  ['JAR 旧语法落在根目录', 'jar xf dependency.jar'],
  ['JAR 带横线的短选项', 'jar -xvf dependency.jar'],
  ['JAR 长选项等号', 'jar --extract --file=dependency.jar'],
  ['JAR 分开的短选项', 'jar -x -f dependency.jar'],
  ['WAR 指定条目仍会落盘', 'jar xf app.war WEB-INF/classes'],
  ['JAR --dir 写入源码', 'jar --extract --file dependency.jar --dir src'],
  ['JAR -C 不能保证旧 JDK 改解压目录', 'jar xf dependency.jar -C .vibe/tmp/1011-查包'],
  ['ZIP 未指定目录', 'unzip dependency.jar'],
  ['ZIP 写入源码', 'unzip -o app.zip -d src'],
  ['ZIP 紧跟目录参数', 'unzip app.zip -dsrc'],
  ['TAR 短选项', 'tar -xzf app.tgz'],
  ['TAR 旧语法', 'tar xvf app.tar'],
  ['TAR 长选项写入源码', 'tar --extract --file app.tar --directory=src'],
  ['TAR 两次换目录不能越出事由', 'tar xf app.tar -C .vibe/tmp/1011-查包 -C ../../..'],
  ['BSD TAR 解 JAR', 'bsdtar -xf dependency.jar -C src'],
  ['GNU TAR 别名', 'gtar -xf app.tar'],
  ['7z 还原目录', '7z x app.jar'],
  ['7za 平铺条目', '7za e app.zip -osrc'],
  ['7zr 明确根目录', '7zr x app.7z -o.'],
  ['PowerShell 默认子目录也污染项目', 'Expand-Archive app.zip', 'PowerShell'],
  ['PowerShell 命名目标', 'Expand-Archive -LiteralPath app.zip -DestinationPath src -Force', 'PowerShell'],
  ['PowerShell 位置参数', 'Expand-Archive app.zip src', 'PowerShell'],
  ['PowerShell 冒号参数', 'Expand-Archive -Path:app.zip -DestinationPath:src', 'PowerShell'],
  ['直接放 tmp 根也不合适', 'unzip app.zip -d .vibe/tmp'],
  ['直接放 .vibe 也不合适', 'tar xf app.tar -C .vibe'],
  ['字面相似的目录不能蒙混', 'unzip app.zip -d .vibe/tmp-other/查包'],
  ['普通已存在的源码目录照样检查', 'unzip app.zip -d src'],
  ['路径中的上级退到项目根', 'unzip app.zip -d .vibe/tmp/1011-查包/../../..'],
  ['Bash 包装命令', 'bash -c "jar xf app.jar"'],
  ['cmd 包装命令', 'cmd /c "jar xf app.jar"'],
  ['PowerShell 包装命令', 'pwsh -NoProfile -Command "Expand-Archive app.zip src"'],
  ['env 工作目录落在源码', 'env -C src jar xf "../app.jar"'],
  ['环境变量前缀', 'LANG=C jar xf app.jar'],
  ['限时包装命令', 'timeout 20 jar xf app.jar'],
  ['管道输入的 TAR', 'cat app.tar | tar xf -'],
  ['TAR 文件名里有 t 仍是解包', 'tar -xftest.tar'],
  ['Python ZIP 命令行也要安全目标', 'python -m zipfile -e app.jar src'],
  ['Python TAR 默认目录', 'python3 -m tarfile --extract app.tar'],
  ['条目重定向是落盘操作', 'unzip -p app.jar entry.txt > inspect.txt'],
  ['目录列表写到项目也算过程文件', 'jar tf app.jar > listing.txt'],
  ['管道 tee 结果也要事由目录', 'jar tf app.jar | tee inspect.txt'],
  ['管道 Out-File 结果也要事由目录', 'jar tf app.jar | Out-File -FilePath inspect.txt', 'PowerShell'],
  ['Start-Process 明确源码工作目录', 'Start-Process -FilePath jar -ArgumentList "xf app.jar" -WorkingDirectory src -WindowStyle Hidden', 'PowerShell'],
  ['cmd start 指定源码工作目录', 'cmd /c start "" /d src jar xf app.jar'],
  ['PowerShell WhatIf 为 false 仍落盘', 'Expand-Archive app.zip src -WhatIf:$false', 'PowerShell'],
]) bad(label, command, tool);

for (const [label, command, tool, cwd] of [
  ['JAR 只列目录', 'jar tf dependency.jar'],
  ['JAR 长选项只列目录', 'jar --list --file=dependency.jar'],
  ['JAR 创建归档不算临时解包', 'jar cf app.jar src'],
  ['JAR 更新归档不算临时解包', 'jar uf app.jar src'],
  ['TAR 只列目录', 'tar -tzf app.tgz'],
  ['TAR 只输出条目', 'tar xOf app.tar entry.txt'],
  ['ZIP 只列目录', 'unzip -l app.jar'],
  ['ZIP 只输出条目', 'unzip -p app.jar META-INF/MANIFEST.MF'],
  ['ZIP 只检验完整性', 'unzip -t app.zip'],
  ['ZIP Info 模式', 'unzip -Z1 app.jar'],
  ['7z 只列目录', '7z l app.jar'],
  ['7z 只输出条目', '7z x app.jar -so META-INF/MANIFEST.MF'],
  ['PowerShell WhatIf 不落盘', 'Expand-Archive app.zip src -WhatIf', 'PowerShell'],
  ['ZIP 事由目录', 'unzip app.jar -d .vibe/tmp/1011-查包'],
  ['ZIP 带空格的绝对目标', 'unzip app.jar -d ' + q(path.join(tmp, '解包 文件'))],
  ['TAR 事由目录', 'tar xf app.tar -C .vibe/tmp/1011-查包'],
  ['TAR 相对当前目录解析', 'tar xf ../../app.tar -C ../.vibe/tmp/1011-查包', 'Bash', path.join(repo, 'src')],
  ['PowerShell 事由目录', 'Expand-Archive -LiteralPath app.zip -DestinationPath .vibe/tmp/1011-查包', 'PowerShell'],
  ['PowerShell 模块限定名', 'Microsoft.PowerShell.Archive\\Expand-Archive app.zip .vibe/tmp/1011-查包', 'PowerShell'],
  ['7z 事由目录', '7z x app.jar -o.vibe/tmp/1011-查包'],
  ['JAR 在事由目录中解包', 'jar xf ' + q(path.join(repo, 'app.jar')), 'Bash', tmp],
  ['旧 JDK -C 仍有安全的当前目录', 'jar xf app.jar -C .', 'Bash', tmp],
  ['现代 JDK --dir 明确目标', 'jar --extract --file app.jar --dir .vibe/tmp/1011-查包'],
  ['env 临时切换工作目录', 'env -C .vibe/tmp/1011-查包 jar xf ' + q(path.join(repo, 'app.jar'))],
  ['PowerShell Push-Location 安全目录', 'Push-Location ' + q(tmp) + '; jar xf ' + q(path.join(repo, 'app.jar')) + '; Pop-Location', 'PowerShell'],
  ['输出里的解包字符串是数据', 'echo "jar xf app.jar"'],
  ['注释里的解包不执行', 'git status # jar xf app.jar'],
  ['变量目录算不出时放行', 'unzip app.jar -d "$dest"'],
  ['命令替换目标算不出时放行', 'unzip app.jar -d "$(choose_dir)"'],
  ['普通构建不当作解包', 'mvn dependency:unpack'],
  ['Python ZIP 安全目标', 'python -m zipfile -e app.jar .vibe/tmp/1011-查包'],
  ['Python ZIP 只列目录', 'python -m zipfile -l app.jar'],
  ['Python 普通模块不干预', 'python -m unittest'],
  ['条目输出到事由目录', 'unzip -p app.jar entry.txt > .vibe/tmp/1011-查包/inspect.txt'],
  ['目录列表 tee 到事由目录', 'jar tf app.jar | tee .vibe/tmp/1011-查包/listing.txt'],
  ['无落盘的空输出设备', 'jar tf app.jar > /dev/null'],
  ['TAR 压缩程序参数不是待提取条目', 'tar -I gzip -xf app.tar -C .vibe/tmp/1011-查包'],
  ['TAR 裁剪路径参数不是待提取条目', 'tar --strip-components 1 -xf app.tar -C .vibe/tmp/1011-查包'],
  ['Start-Process 事由工作目录', 'Start-Process -FilePath jar -ArgumentList "xf app.jar" -WorkingDirectory ' + q(tmp) + ' -WindowStyle Hidden', 'PowerShell'],
  ['cmd start 事由工作目录', 'cmd /c start "" /d ' + q(tmp) + ' jar xf app.jar'],
  ['未知工作目录不按旧目录误拦', 'Set-Location $dest; jar xf app.jar', 'PowerShell'],
  ['未知目录之后恢复绝对工作目录', 'Set-Location $dest; Set-Location ' + q(tmp) + '; jar xf app.jar', 'PowerShell'],
  ['项目外的正式解包安装不接管', 'unzip sdk.zip -d ' + q(path.join(h.root, 'programs/sdk'))],
]) good(label, command, tool, cwd);

const link = path.join(tmp, 'linked-src');
try {
  fs.symlinkSync(path.join(repo, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
  bad('临时目录联接到源码不能放行', 'unzip app.jar -d ' + q(link));
  bad('检查结果经目录联接写入源码也拦', 'jar tf app.jar > ' + q(path.join(link, 'inspection.txt')));
} catch (e) { H.ok('测试可创建目录联接', false, e.message); }
const sub = H.makeRepo(path.join(repo, '子项目'), { 'src/b.js': 'const b = 2;\n' });
bad('壳子里子项目也检查实际目标', 'unzip app.jar -d ' + q(path.join(sub, 'src')));
good('子项目自己的事由目录可用', 'unzip app.jar -d ' + q(path.join(sub, '.vibe/tmp/查包')));
bad('相同坏目标重复执行仍拦', 'jar xf dependency.jar');
bad('PowerShell Pop-Location 恢复后继续检查根目录', 'Push-Location ' + q(tmp) + '; jar xf ' + q(path.join(repo, 'app.jar')) + '; Pop-Location; jar xf app.jar', 'PowerShell');
bad('未知目录恢复到根目录后继续检查', 'Set-Location $dest; Set-Location ' + q(repo) + '; jar xf app.jar', 'PowerShell');

H.write(path.join(repo, '.vibe/tmp/1011-查包/inspect.sh'), 'jar xf app.jar\n');
bad('读取已存在脚本里的直接解包', 'bash .vibe/tmp/1011-查包/inspect.sh');
bad('关闭套件文件保护不跳过整理检查', 'jar xf app.jar');
H.setConfig(h, { kitLock: false });
bad('kitLock 关闭后的快速返回不能漏 JAR', 'jar xf app.jar');
bad('kitLock 关闭后的快速返回不能漏 ZIP', 'unzip app.zip');
H.setConfig(h, { kitLock: true });

const ide = (command, routed) => H.hook(h, 'guard-commit', { ...data(command), tool_name: 'mcp__jetbrains__' + (routed ? 'execute_tool' : 'execute_terminal_command'), tool_input: { projectPath: repo, command: routed ? 'execute_terminal_command --command ' + JSON.stringify(command) : command } });
H.ok('IDEA 终端检查解包目标', denied(ide('jar xf app.jar')));
H.ok('IDEA 工具路由也检查解包目标', denied(ide('unzip app.zip -d src', true)));
H.ok('IDEA 安全解包放行', ide('unzip app.zip -d .vibe/tmp/1011-查包') === null);

H.setConfig(h, { autoMode: true });
H.inFlow(h, 'archive-extract', [], 'apply');
bad('全自动仍改用安全目录', 'jar xf app.jar');
good('全自动事由目录继续工作', 'unzip app.zip -d .vibe/tmp/1011-查包');
H.setConfig(h, { vibeTidy: false });
good('整理开关关闭时保持既有约定', 'jar xf app.jar');
H.ok('检查过程没有真的解包到项目', !fs.existsSync(path.join(repo, 'META-INF')));
H.ok('全局约定明确解包样本位置', /过程文件和解包样本一律放/.test(H.read(path.join(h.kit, 'CLAUDE.md')) || ''));
H.ok('审查代理只读查看归档', /不解包、不重定向写文件/.test(H.read(path.join(h.cfg, 'agents/ttls-reviewer.md')) || ''));
H.ok('审查技能要求主会话准备安全归档材料', /归档内部实现不能靠解包到项目根/.test(H.read(path.join(h.cfg, 'skills/ttls-cross-review/SKILL.md')) || ''));
H.done('归档解包的临时目录');
