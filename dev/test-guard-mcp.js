'use strict';
/*
 * MCP 工具的令牌保护（第 48 条，硬规矩第 6 条只能收紧）：不认工具名，任意 mcp__x__y 四层都查。
 * 用法：node dev/test-guard-mcp.js [旧版套件目录]（拿 2248 跑，原文那几项不过）
 */
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('./lib/harness');

const h = H.makeHome('guard-mcp', process.argv[2]);
const proj = H.makeRepo(path.join(h.work, 'p'), { 'a.js': 'let a = 1;\n' });
const secret = path.join(h.kit, 'secrets.json');
H.write(secret, '{"token":"x"}\n');
const call = (input, tool) => H.hook(h, 'guard-commit', { session_id: 's-mcp', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool || 'mcp__x__y', tool_input: input, tool_use_id: 'u1' });
const blocked = (r) => !!r && (r.decision === 'block' || (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny'));

H.section('读令牌：任意名字的工具都拦');
H.ok('路径字段', blocked(call({ path: secret })), call({ path: secret }));
H.ok('file_path', blocked(call({ file_path: secret })));
H.ok('列表字段', blocked(call({ paths: ['a.js', secret] })));
H.ok('写成 JSON 字符串的列表', blocked(call({ files: JSON.stringify([secret]) })));
H.ok('file: 网址', blocked(call({ uri: pathToFileURL(secret).href })));
H.ok('projectPath 指到套件目录', blocked(call({ projectPath: h.kit })));
H.ok('原文点到 secrets.json', blocked(call({ q: 'read secrets.json please' })));
H.ok('原文点到 router-data', blocked(call({ text: 'cat ~/.claude/vibe-kit/router-data/config.json' })));
H.ok('.claude.json', blocked(call({ path: path.join(h.home, '.claude.json') })));
H.ok('目录级 grep：不带文件名，也拦', blocked(call({ command: 'grep -r token "' + h.kit.replace(/\\/g, '/') + '"' })), call({ command: 'grep -r token "' + h.kit.replace(/\\/g, '/') + '"' }));
H.ok('用户目录整个搜：范围里有令牌，拦', blocked(call({ path: h.cfg })));

H.section('字段名不在名单里也查（复审 20261104 R3）');
H.ok('directoryToSearch 指到套件目录', blocked(call({ directoryToSearch: h.kit })));
H.ok('directoryPath 指到 ~/.claude', blocked(call({ directoryPath: h.cfg })));
H.ok('folder 指到套件目录', blocked(call({ folder: h.kit })));
H.ok('带 glob 的目录搜索', blocked(call({ globPattern: '**/secrets*', directoryToSearch: h.kit })));
H.ok('directoryToSearch 指到用户目录', blocked(call({ directoryToSearch: h.home })));
H.ok('相对路径按同一次调用的 projectPath 算', blocked(call({ projectPath: proj, subDirectoryRelativePath: path.relative(proj, h.kit) })), path.relative(proj, h.kit));
H.ok('相对路径按 projectPath 算，别的目录放行', call({ projectPath: proj, subDirectoryRelativePath: 'src/main' }) === null);
H.ok('字段里只是一段话，没路径：放行', call({ query: 'find all orders' }) === null);
H.ok('字段里是网址：放行', call({ link: 'http://example.com/a/b' }) === null);

H.section('写套件目录：放行（2026-11-04 起套件可以改），令牌照拦');
H.ok('改套件的钩子：放行', call({ file_path: path.join(h.kit, 'hooks', 'verify-gate.js'), new_string: 'x' }, 'mcp__ide__edit') === null);
H.ok('读套件的令牌：拦', blocked(call({ file_path: path.join(h.kit, 'secrets.json') }, 'mcp__ide__read')));

H.section('别的放行');
H.ok('普通参数', call({ q: 'hello' }) === null);
H.ok('项目里的路径', call({ path: path.join(proj, 'a.js') }) === null, call({ path: path.join(proj, 'a.js') }));
H.ok('普通命令', call({ command: 'git status' }) === null);
H.ok('网址', call({ url: 'https://example.com/a' }) === null);
H.ok('push 不按 Bash 的规矩查（用户定的）', call({ command: 'git push origin main' }, 'mcp__jetbrains__execute_terminal_command') === null, call({ command: 'git push origin main' }, 'mcp__jetbrains__execute_terminal_command'));

H.done('MCP 工具的令牌保护');
