'use strict';
/* IDEA MCP 的直接工具和 execute_tool 都走真实 guard-commit 入口。
 * 全是假用户目录、假项目，只判断钩子，不执行 IDE 工具、终端和 push。
 * 可给旧版 vibe-kit 目录，旧版必须测出缺少 MCP 保护。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('./lib/harness');
const from = process.argv[2] ? path.resolve(process.argv[2]) : H.SRC;
const h = H.makeHome('idea-tools', from, { autoUpdate: 'off', issueUpload: 'off', usageReport: 'off', autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', commitMode: 'off', outputGate: false, vibeTidy: false, specGate: false });
const repo = H.makeRepo(path.join(h.work, '中文项目'), { 'a.js': 'const a=1;\n', 'openspec/changes/c/tasks.md': '- [ ] 1.1 改代码；验：人工看\n' });
const transcript = path.join(h.root, 't.jsonl');
H.transcript(transcript, [H.tr.user('改代码')]);
const data = (name, input, server) => ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__' + (server || 'vibe-idea-64342') + '__' + name, tool_input: { projectPath: repo, ...input }, cwd: repo, session_id: 'ide-tools', transcript_path: transcript });
const call = (name, input, server) => H.hook(h, 'guard-commit', data(name, input, server));
const denied = r => !!r && (r.decision === 'block' || r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny');
const ask = r => !!r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'ask';
const quote = v => JSON.stringify(String(v).replace(/\\/g, '/'));
const secret = path.join(h.kit, 'secrets.json');
const model = path.join(h.kit, 'router-data/config.json');
H.write(secret, '{"gitlabToken":"TEST_IDEA_SECRET_ONLY"}');
H.write(model, '{"api_key":"TEST_IDEA_MODEL_ONLY"}');

for (const [name, input] of [
  ['search_symbol', { q: 'a' }], ['read_file', { file_path: 'a.js' }],
  ['execute_tool', { command: 'read_file --file_path "a.js"' }],
  ['execute_tool', { command: 'execute_terminal_command --command "git status"' }],
  ['replace_text_in_file', { pathInProject: 'a.js', oldText: '1', newText: '2' }],
  ['rename_refactoring', { pathInProject: 'a.js', symbolName: 'a', newName: 'b' }],
  ['reformat_file', { path: 'a.js' }], ['get_run_configurations', { filePath: 'a.js' }],
  ['xdebug_set_breakpoint', { filePath: 'a.js', line: 1 }], ['xdebug_get_stack', { sessionId: 'test' }],
]) H.ok('普通操作通过：' + name, call(name, input) === null);
// 编译、文件检查、lint 是快检，人工模式直接跑（2026-10-16 用户定的）；execute_tool 转发也一样。
for (const [name, input] of [['build_project', { filesToRebuild: ['a.js'] }], ['lint_files', { files: ['a.js'] }], ['get_file_problems', { filePath: 'a.js' }], ['execute_tool', { command: 'build_project' }]]) H.ok('快检人工模式直接跑：' + name + (input.command ? ' ' + input.command : ''), call(name, input) === null);
// 运行配置会起程序或跑测试，算自测：人工模式先 Ask（2026-10-14 用户定的），用户明确要求后照常通过；execute_tool 转发也一样。
const selfTests = [['execute_run_configuration', { configurationName: 'app' }], ['execute_tool', { command: 'execute_run_configuration --configurationName "app"' }]];
for (const [name, input] of selfTests) H.ok('人工模式自测先 Ask：' + name + (input.command ? ' ' + input.command : ''), denied(call(name, input)) && /人工模式/.test(H.reasonOf(call(name, input))));
H.transcript(transcript, [H.tr.user('运行测试')]);
for (const [name, input] of selfTests) H.ok('明确要求自测后通过：' + name + (input.command ? ' ' + input.command : ''), call(name, input) === null);
H.transcript(transcript, [H.tr.user('改代码')]);

for (const [label, name, input] of [
  ['直接读令牌', 'read_file', { file_path: secret }],
  ['读模型配置', 'get_file_text_by_path', { pathInProject: model }],
  ['读自定义目录用户配置', 'read_file', { file_path: path.join(h.cfg, '.claude.json') }],
  ['读默认用户配置', 'read_file', { file_path: path.join(h.home, '.claude.json') }],
  ['路由读令牌', 'execute_tool', { command: 'read_file --file_path ' + quote(secret) }],
  ['文件 URI 读令牌', 'read_file', { file_path: pathToFileURL(secret).href }],
  ['大小写不同仍拦', 'read_file', { file_path: secret.toUpperCase() }],
  ['从父目录搜索内容', 'search_symbol', { q: 'a', projectPath: h.home }],
  ['指定模型配置做检查', 'get_file_problems', { filePath: model }],
  ['检查数组中的令牌', 'lint_files', { files: [secret] }],
  ['编译数组中的令牌', 'build_project', { filesToRebuild: [secret] }],
  ['路由中的文件数组', 'execute_tool', { command: 'lint_files --files ' + JSON.stringify(JSON.stringify([secret])) }],
  ['IDE 终端读令牌', 'execute_terminal_command', { command: 'type ' + quote(secret) }],
  ['IDE PowerShell 读令牌', 'execute_terminal_command', { command: 'Get-Content ' + quote(secret) }],
  ['修改套件', 'replace_text_in_file', { pathInProject: path.join(h.kit, 'lib/session.js'), oldText: 'a', newText: 'b' }],
  ['读取路径别名不能盖过令牌路径', 'get_file_text_by_path', { file_path: 'a.js', pathInProject: secret }],
  ['编辑路径别名不能盖过套件路径', 'replace_text_in_file', { file_path: 'a.js', pathInProject: path.join(h.kit, 'lib/session.js'), oldText: 'a', newText: 'b' }],
  ['路径别名不能盖过任务文件', 'replace_text_in_file', { file_path: 'a.js', pathInProject: 'openspec/changes/c/tasks.md', oldText: '- [ ]', newText: '- [x]' }],
  ['未确认提交', 'execute_terminal_command', { command: 'git add a.js && git commit -m "fix: 改代码"' }],
  ['数据库操作', 'execute_tool', { command: 'execute_sql_query --query "select 1"' }],
  ['全量运行配置可能带口令', 'get_run_configurations', {}],
  ['运行参数覆盖', 'execute_run_configuration', { configurationName: 'app', programArguments: '-e echo' }],
  ['调试环境变量覆盖', 'xdebug_start_debugger_session', { configurationName: 'app', envs: { TOKEN: 'TEST_ONLY' } }],
  ['格式化任务不能绕检查', 'reformat_file', { path: 'openspec/changes/c/tasks.md' }],
  ['带表达式的断点', 'xdebug_set_breakpoint', { filePath: 'a.js', condition: 'f()' }],
  ['批量补丁', 'apply_patch', { input: '*** Begin Patch' }],
  ['执行检查脚本', 'run_inspection_kts', { script: 'print(1)' }],
  ['执行调试表达式', 'xdebug_evaluate_expression', { expression: 'f()' }],
  ['修改调试变量', 'xdebug_set_variable', { newValue: 'f()' }],
  ['未知工具', 'new_unadapted_tool', {}],
  ['缺项目路径', 'read_file', { file_path: 'a.js', projectPath: undefined }],
  ['相对项目路径', 'read_file', { file_path: 'a.js', projectPath: '.' }],
  ['路由项目冲突', 'execute_tool', { command: 'read_file --file_path "a.js" --projectPath ' + quote(h.work) }],
  ['坏路由引号', 'execute_tool', { command: 'read_file --file_path "unfinished' }],
  ['路由重复参数', 'execute_tool', { command: 'read_file --file_path "a.js" --file_path "b.js"' }],
]) { const r = call(name, input); H.ok(label + '被拦', denied(r), H.reasonOf(r)); }
H.ok('IDEA 终端的 push 也先检查预览', denied(call('execute_terminal_command', { command: 'git push' })));
H.transcript(transcript, [H.tr.user('推送')]);
H.ok('当场说 push 不能跳过 IDEA 终端的预览检查', denied(call('execute_tool', { command: 'execute_terminal_command --command "git push"' })));
H.transcript(transcript, [H.tr.user('改代码')]);
H.inFlow(h, 'ide-tools', [], 'apply'); H.setConfig(h, { autoMode: true });
H.ok('全自动时读令牌仍拦', denied(call('read_file', { file_path: secret })));
H.ok('全自动也不能直接操作数据库', denied(call('execute_sql_query', { query: 'select 1' })));
H.ok('全自动 push 未授权仍拦下', denied(call('execute_terminal_command', { command: 'git push' })));
H.setConfig(h, { autoMode: false });
const gbk = path.join(repo, 'gbk.js');
fs.writeFileSync(gbk, Buffer.concat([Buffer.from('// '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\nconst x=1;\n')]));
H.ok('IDE 编辑也检查非 UTF-8 文件', denied(call('replace_text_in_file', { pathInProject: 'gbk.js', oldText: '1', newText: '2' })));
H.setConfig(h, { outputGate: true });
H.ok('IDE 新建文档也要求确认产出位置', denied(call('create_new_file', { pathInProject: 'docs/记录.md', text: '# 记录\n' })));
H.setConfig(h, { outputGate: false, specGate: true });
H.inFlow(h, 'ide-tools', [path.join(repo, 'openspec/changes/c')], true, 'plan');
H.ok('提案阶段不能借 IDE 编辑打任务勾', denied(call('replace_text_in_file', { pathInProject: 'openspec/changes/c/tasks.md', oldText: '- [ ]', newText: '- [x]' })));
H.setConfig(h, { specGate: false });
H.ok('惯用 jetbrains 名字有保护', denied(call('read_file', { file_path: secret }, 'jetbrains')));
H.ok('服务器名连字符转下划线有保护', denied(call('read_file', { file_path: secret }, 'vibe_idea_64342')));
H.write(path.join(h.kit, 'state/idea-mcp.json'), JSON.stringify({ connections: [{ name: 'my-idea' }] }));
H.ok('已有的自定义登记名有保护', denied(call('read_file', { file_path: secret }, 'my_idea')));
H.ok('其它 MCP 的同名工具不被接管', call('execute_tool', { command: 'execute_sql_query --query "select 1"' }, 'other') === null);

const ir = H.node(h, path.join(from, 'install.js'), ['--no-router', '--no-open']);
const settings = JSON.parse(H.read(path.join(h.cfg, 'settings.json')) || '{}');
const matched = (settings.hooks && settings.hooks.PreToolUse || []).some(r => r.matcher && new RegExp('^(?:' + r.matcher + ')$').test('mcp__vibe-idea-64342__execute_tool') && r.hooks.some(x => /guard-commit/.test(x.command || x.url || '')));
H.ok('安装器登记了 MCP 的保护入口', ir.code === 0 && matched);
const log = H.read(path.join(h.kit, 'state/hooks.log')) || '';
const feedbackDir = path.join(h.kit, 'feedback');
const feedbackText = fs.existsSync(feedbackDir) ? fs.readdirSync(feedbackDir).filter(n => n.endsWith('.json')).map(n => H.read(path.join(feedbackDir, n))).join('') : '';
H.ok('检查和反馈不带出假令牌内容', !log.includes('TEST_IDEA_SECRET_ONLY') && !feedbackText.includes('TEST_IDEA_SECRET_ONLY') && !feedbackText.includes('TEST_IDEA_MODEL_ONLY'));
H.done('IDEA MCP 保护入口');
