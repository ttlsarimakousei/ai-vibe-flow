'use strict';
/* 提案材料可交付、提交标题不代替许可、合并事件边界。所有写入只在假用户目录。 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const denied = r => !!r && (r.decision === 'block' || r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny');
(async () => {
  const h = H.makeHome('proposal-files', process.argv[2] || null, { autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', commitMode: 'ask', lessons: 'off', vibeTidy: false, specGate: true });
  const repo = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'notes.md': '原说明\n', 'src/a.js': 'const a=1;\n', 'openspec/changes/a/proposal.md': '## Why\n修复业务状态。\n', 'openspec/changes/a/tasks.md': '- [ ] 1.1 改 src/a.js；验：node --check src/a.js\n' });
  const dir = path.join(repo, 'openspec/changes/a');
  const transcript = entries => H.transcript(path.join(h.root, 't.jsonl'), entries);
  const commit = cmd => H.hook(h, 'guard-commit', { session_id: 'commit', cwd: repo, tool_name: 'Bash', tool_input: { command: cmd }, transcript_path: transcript([H.tr.user('整理说明')]) });
  H.write(path.join(repo, 'notes.md'), '改说明\n');
  H.ok('普通说明不能借修订标题跳过确认', denied(commit('git add notes.md && git commit -m "docs: 修订使用说明"')));
  H.ok('普通说明不能借归档标题跳过确认', denied(commit('git add notes.md && git commit -m "docs: 归档说明"')));
  H.git(repo, ['add', 'notes.md']);
  H.ok('已暂存普通文件不能搭产物一起免问', denied(commit('git add openspec/changes/a/tasks.md && git commit -m "docs: 修订任务"')));
  H.git(repo, ['reset', '-q', 'HEAD', '--', 'notes.md']);
  H.ok('只有实际产物的修订照旧允许', commit('git add openspec/changes/a/tasks.md && git commit -m "docs: 修订任务"') === null);
  const art = { dir, root: repo, name: 'a' };
  const moduleFile = path.join(h.kit, 'lib/proposal-files.js');
  const has = fs.existsSync(moduleFile);
  H.ok('安装包含提案材料检查模块', has);
  const P = has ? require(moduleFile) : { issuesIn: () => [], changeIssues: () => [] };
  for (const content of ['参考 .vibe/tmp/a/input.json', '验：node .vibe/tmp/check.js', '读 C:\\work\\p\\.vibe\\tmp\\data.txt', '参考 [样例](.vibe/out/example.json)']) H.ok('临时依赖在各类写法下均拒绝', P.issuesIn(content, art).length > 0, content);
  H.ok('只检查新增行，旧历史说明不阻止其他编辑', P.issuesIn('参考 .vibe/tmp/check.js\n改真实业务状态', art, i => i === 1).length === 0);
  H.ok('运行时临时输出不是实施输入', P.issuesIn('运行时输出：.vibe/tmp/results.json', art).length === 0);
  H.ok('project.md 本机说明仍可作为探索入口', P.issuesIn('项目说明 .vibe/project.md', art).length === 0);
  H.ok('项目源码的 assets 不误认成提案材料', P.issuesIn('实现 src/assets/logo.svg', art).length === 0);
  H.ok('团队共享来源的 assets 不误认成本机材料', P.issuesIn('参考 https://example.test/v1/assets/input.json', art).length === 0);
  H.write(path.join(dir, 'assets/check.js'), 'console.log("检查");\n');
  H.ok('真实可提交材料可以引用', P.issuesIn('验：node openspec/changes/a/assets/check.js', art).length === 0);
  H.ok('变更内相对路径可引用', P.issuesIn('参考 [检查脚本](assets/check.js)', art).length === 0);
  H.ok('缺材料必须先搬入', P.issuesIn('参考 assets/missing.json', art).length > 0);
  H.ok('任务声明新建材料可先写', P.issuesIn('新建 assets/new.js', art).length === 0);
  H.write(path.join(repo, '.gitignore'), '.vibe/\nopenspec/changes/a/assets/check.js\n');
  H.ok('被 git 忽略的材料不能假装可交付', P.issuesIn('参考 assets/check.js', art).length > 0);
  H.write(path.join(repo, '.gitignore'), '.vibe/\n');
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/b/spec.md']) {
    const file = path.join(dir, name);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    H.write(file, old + '\n参考 .vibe/tmp/missing.json\n');
    H.ok('完整扫描检查 ' + name, P.changeIssues(art).some(x => x.includes(name.replace(/\\/g, '/'))));
    H.write(file, old);
  }
  const write = (name, text) => H.hook(h, 'guard-spec', { session_id: 'write', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(dir, name), old_string: '## Why', new_string: '## Why\n' + text } });
  H.ok('写提案时钩子指出临时依赖和迁移位置', /assets/.test(H.reasonOf(write('proposal.md', '参考 .vibe/tmp/check.js'))));
  const assetDesign = H.hook(h, 'guard-spec', { session_id: 'design', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'design.md'), content: '## Context\n真实文件 src/a.js\n## Decisions\n检查脚本 assets/check.js\n' } });
  H.ok('设计里的变更内路径不会被误判不存在', !denied(assetDesign), H.reasonOf(assetDesign));
  H.write(path.join(dir, 'proposal.md'), '## Why\n参考 .vibe/tmp/check.js\n');
  H.ok('通过命令写的临时依赖在提交前也查', /材料不能交付/.test(H.reasonOf(commit('git add openspec/changes/a/proposal.md && git commit -m "docs: 修订提案"'))));
  H.ok('同条命令 add 整个变更目录也检查临时依赖', /材料不能交付/.test(H.reasonOf(commit('git add openspec/changes/a && git commit -m "docs: 修订产物"'))));
  H.git(repo, ['add', 'openspec/changes/a/proposal.md']);
  H.write(path.join(dir, 'proposal.md'), '## Why\n参考 assets/check.js\n');
  H.ok('工作区修正但暂存区仍引用临时文件不能提交', /材料不能交付/.test(H.reasonOf(commit('git commit -m "docs: 修订产物"'))));
  H.git(repo, ['reset', '-q', 'HEAD', '--', 'openspec/changes/a/proposal.md']);
  H.write(path.join(dir, 'proposal.md'), '## Why\n参考 .vibe/tmp/check.js\n');
  const stop = H.hook(h, 'verify-gate', { session_id: 'stop', cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '写完了', transcript_path: transcript([H.tr.user('修改提案'), H.tr.ran('Write', { file_path: path.join(dir, 'proposal.md'), content: '参考 .vibe/tmp/check.js' }, 'ok')]) });
  H.ok('收工扫描四产物补充检查', /材料不能交付/.test(H.reasonOf(stop)), H.reasonOf(stop));
  const merge = path.join(h.kit, 'lib/merge-push.js');
  if (fs.existsSync(merge)) {
    const M = require(merge);
    const c = (id, title, files) => ({ id, title, files: files || [id + '.js'] });
    // 2026-10-14 起按具体任务归组：中文变更名带任务号认成任务，独立修复的"事件："认成事件。
    H.ok('中文事件标记能识别', M.eventOf(c('a', 'fix: 修复查询（源自 查询改造 1.1）')) === 'task:查询改造:1.1' && M.eventOf(c('b', 'fix: 修复 事件: 查询改造')) === 'event:查询改造');
    const groups = M.groupsOf([c('a', 'feat: 实现（源自 add-a 1.1）'), c('b', 'docs: 归档 add-a', ['openspec/changes/archive/2026-10-10-add-a/tasks.md']), c('c', 'fix: 后续修复（源自 add-a 1.1）')]);
    H.ok('归档是边界，后续修复不会被搬到归档前', JSON.stringify(groups.map(g => g.ids)) === '[["a"],["b"],["c"]]', groups);
  }
  H.done('提案材料和相似入口');
})().catch(e => { console.error(e); H.ok('执行没有异常', false); H.done('提案材料和相似入口'); });
