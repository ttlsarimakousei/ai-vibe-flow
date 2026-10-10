'use strict';
/*
 * 回归：同一批输入分别喂给上一版和这一版的钩子，比输出。
 * 以前的回归测试不在这台机器上，所以用"新旧对比"来保证没改到的地方行为不变：
 *   - 没标 expect 的：两版输出必须一模一样
 *   - 标了 expect 的：有意改的地方，新版的输出要符合 expect。每一项记着是哪一版改的（since）：
 *       拿来比的上一版比它老 → 两版应该不一样；上一版已经带着这个改动 → 两版应该一样
 *       （某一版才带进来、这一版改回去的毛病，since 写成 { from: 那一版 }）
 * 用法：node dev/diff-hooks.js <上一版解压出来的 vibe-kit 目录>
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const OLD = process.argv[2];
if (!OLD || !fs.existsSync(path.join(OLD, 'kit', 'hooks'))) { console.log('用法：node dev/diff-hooks.js <上一版的 vibe-kit 目录>'); process.exit(2); }

const hints = [{ name: '表结构查真实库', prompt: '表结构、字段', files: '.sql', say: '表结构以真实数据库为准，用查库技能。' }];
const kits = { old: H.makeHome('diff-old', OLD, { hints }), new: H.makeHome('diff-new', null, { hints }) };

const FILES = {
  'pom.xml': '<project/>\n',
  '.gitignore': 'target/\n',
  'src/main/java/com/x/A.java': 'package com.x;\nclass A {}\n',
  'src/main/java/com/x/B.java': 'package com.x;\nclass B {}\n',
  'web/src/views/Order.vue': '<template><div/></template>\n',
  'db/init.sql': 'create table t (id int);\n',
  'docs/old.md': '# 旧文档\n',
  '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：mvn -q -o compile\n',
  'openspec/changes/add-export/proposal.md': '## Why\n\n要导出。\n\n## What Changes\n\n- 加导出接口\n',
  'openspec/changes/add-export/design.md': '## Context\n\n- 读过 src/main/java/com/x/A.java\n- 读过 pom.xml\n',
  'openspec/changes/add-export/tasks.md': '- [x] 1.1 改 src/main/java/com/x/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/main/java/com/x/B.java；验：`mvn -q -o compile`\n',
};
let n = 0;
/** 每个用例、每一版各一份一模一样的项目 */
function project(kit, extra) {
  const dir = path.join(kit.work, 'c' + (++n), 'proj');
  H.makeRepo(dir, Object.assign({}, FILES, extra || {}));
  return dir;
}
const norm = (s, kit, proj) => String(s)
  .split(proj).join('<项目>').split(proj.replace(/\\/g, '/')).join('<项目>').split(proj.replace(/\\/g, '\\\\')).join('<项目>')
  .split(kit.home).join('<用户目录>').split(kit.home.replace(/\\/g, '/')).join('<用户目录>').split(kit.home.replace(/\\/g, '\\\\')).join('<用户目录>')
  .replace(/拦截编号 [A-Z0-9]{4,6}/g, '拦截编号 ####')
  .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/g, '<时间>')
  .replace(/c\d+([\\/])proj/g, 'c#$1proj')
  // 技能、审查代理、经验规则文件改了名（加了 ttls- 前缀）：只是名字不同，不算行为变了
  .replace(/\/ttls-(cross-review|see-page|handover|onboard)\b/g, '/$1').replace(/ttls-reviewer/g, 'vibe-reviewer').replace(/ttls-lessons-/g, 'vibe-lessons-');

const cases = [];
const OLD_VERSION = (H.read(path.join(OLD, 'kit', 'VERSION')) || '').trim() || '00000000.0000';
const V0928 = '20260928.1700';
const V0928B = '20260928.2054'; // 自动更新、问题上报那一版：令牌和模型的 key 不给读，跑发布脚本要确认
const V0929 = '20260929.2205'; // 内网反馈 0929 那一版：全自动模式不等人、注释不算命令、规格增量的标题
const V0930 = '20260930.1200'; // 六件事加全仓审查那一版：自动收审查问题、读令牌的提示点明是哪个文件、新名字的规则文件
const V1505 = '20260930.1505'; // 串着 cd 的命令拦下、壳子和起服务的提示里写不用 cd 的办法
const V2248 = '20260930.2248'; // 提示规则去掉了；过程文件的提示里写明变更的留到归档；整仓 add 的提示里说了新仓库第一次入仓不拦
const V1005 = '20261005.0302'; // 闲话、"让它停"不再只看开头几个字：开头碰巧是"不用""好"的需求照需求提醒
const V1007 = '20261007.1217'; // 起服务的提示：端口改成 --port auto --avoid <配置里的端口>
const V1008 = '20261007.1622'; // 不走 OpenSpec 的提交要用户点头；归档要用户说了才做；全自动只管 apply（开工时告诉用户开没开）；报问题的提醒改了说法
const V1010 = '20261010.1057'; // 1007 导出议题：包装命令、否定归因、当场推送授权和发布确认
const V1010B = '20261010.1617'; // 1010 反馈、提案材料、提交和多版本驱动
const V1010C = '20261010.2210'; // IDEA MCP 的自动接入和工具保护
const NEXT = '99999999.0000'; // 这一版（还没打包，没有版本号）改的。1001、1005 两批改的开工前拉代码（只在仓库有远端时才出字，1005 起"本来就是最新"不出字）这里比不出来：这里的项目没有远端，在 test-1001.js、test-1005.js 里测
// config：跑这一个输入之前先改的开关（两版都改），跑完改回去
// since 还可以写成 { from: 版本, to: 版本 }：这个毛病是 from 那一版才带进来的，to 那一版改回去了（to 不写就是这一版）——
// 旧版在 from 之前（还没有这个毛病）、在 to 或者之后（已经改过）的应该一样，在两者之间的应该不一样
const add = (name, hook, build, expect, since, config) => cases.push({ name, hook, build, expect, since: expect ? (since || V0928) : '', config: config || null });
const changedSince = (c) => (c.since && typeof c.since === 'object' ? OLD_VERSION >= c.since.from && OLD_VERSION < (c.since.to || NEXT) : OLD_VERSION < c.since);
const base = (proj, kit, extra) => Object.assign({ session_id: 'sess-diff', cwd: proj, transcript_path: H.transcript(path.join(path.dirname(proj), 't.jsonl'), [H.tr.user('做点事')]) }, extra);
const edit = (rel, tool, input, files, entries) => (kit) => {
  const proj = project(kit, files);
  const f = path.isAbsolute(rel) ? rel : path.join(rel.startsWith('~') ? kit.cfg : proj, rel.replace(/^~[\\/]/, ''));
  const j = base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: Object.assign({ file_path: f }, input) });
  if (entries) j.transcript_path = H.transcript(path.join(path.dirname(proj), 't.jsonl'), entries(proj));
  return { proj, j };
};
const cmd = (command, tool, files) => (kit) => { const proj = project(kit, files); return { proj, j: base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: tool || 'Bash', tool_input: { command: command.split('<项目>').join(proj.replace(/\\/g, '/')) } }) }; };
const stop = (entries, extra, files) => (kit) => { const proj = project(kit, files); const es = entries(proj); const j = base(proj, kit, Object.assign({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '做完了' }, extra)); j.transcript_path = H.transcript(path.join(path.dirname(proj), 't.jsonl'), es); return { proj, j }; };
const prompt = (text, files, entries) => (kit) => { const proj = project(kit, files); const j = base(proj, kit, { hook_event_name: 'UserPromptSubmit', prompt: text }); j.transcript_path = H.transcript(path.join(path.dirname(proj), 't.jsonl'), entries ? entries(proj) : [H.tr.user(text)]); return { proj, j }; };

// IDEA 工具直接调用和路由调用都要经过原有保护；普通源码查询仍放行。
const idea = (name, input) => kit => {
  const proj = project(kit);
  return { proj, j: base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: 'mcp__vibe-idea-64342__' + name, tool_input: { projectPath: proj, ...input(kit, proj) } }) };
};
add('IDEA MCP 直接读令牌', 'guard-commit', idea('read_file', kit => ({ file_path: path.join(kit.kit, 'secrets.json') })), /令牌|key/, V1010C);
add('IDEA MCP 路由读模型配置', 'guard-commit', idea('execute_tool', kit => ({ command: 'read_file --file_path ' + JSON.stringify(path.join(kit.kit, 'router-data/config.json').replace(/\\/g, '/')) })), /令牌|key/, V1010C);
add('IDEA MCP 数据库入口保留查库流程', 'guard-commit', idea('execute_sql_query', () => ({ query: 'select 1' })), /数据库操作继续用/, V1010C);
add('IDEA MCP 批量补丁不跳文件检查', 'guard-commit', idea('apply_patch', () => ({ input: '*** Begin Patch' })), /尚未适配套件检查/, V1010C);
add('IDEA MCP 冲突路径不盖过令牌路径', 'guard-commit', idea('get_file_text_by_path', kit => ({ file_path: 'src/main/java/com/x/A.java', pathInProject: path.join(kit.kit, 'secrets.json') })), /文件路径参数不一致/, V1010C);
add('IDEA MCP 普通符号查询', 'guard-commit', idea('search_symbol', () => ({ q: 'A' })));

// ---------- 改文件 ----------
add('反馈1007：env -C 跑套件场景脚本', 'guard-commit', cmd('env -C "<项目>" node "$HOME/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/check.json --base http://127.0.0.1:34907'), /放行，没有输出/, V1010);
add('反馈1007：否定套件问题不报反馈', 'verify-gate', stop(() => [H.tr.user('查一下'), H.tr.say('不是 vibe-kit 套件的问题。')], { last_assistant_message: '不是 vibe-kit 套件的问题。' }), /放行，没有输出/, V1010, { autoVerify: false, autoCrossReview: false, autoCommit: 'off', vibeTidy: false, lessons: 'off' });
add('反馈1007：全自动时用户当场要求 push', 'guard-commit', (kit) => {
  const r = cmd('git push origin main')(kit);
  r.j.session_id = 'feedback1007-push';
  r.j.transcript_path = H.transcript(path.join(path.dirname(r.proj), 'push.jsonl'), [H.tr.user('3.推送远端')]);
  H.inFlow(kit, r.j.session_id, [path.join(r.proj, 'openspec/changes/add-export')]);
  return r;
}, /放行，没有输出/, V1010, { autoMode: true });
add('反馈1007：env -C 下的相对发布脚本仍确认', 'guard-commit', (kit) => {
  const r = cmd('env -C "<项目>/pkg" node publish.js')(kit);
  H.write(path.join(r.proj, 'pkg/install.js'), '// 测试占位\n');
  H.write(path.join(r.proj, 'pkg/publish.js'), '// 只检查，不运行发布\n');
  H.write(path.join(r.proj, 'pkg/kit/VERSION'), '20261007.1653\n');
  return r;
}, /发布要你确认/, V1010);
add('改普通代码', 'pre-edit', edit('src/main/java/com/x/A.java', 'Edit', { old_string: 'class A {}', new_string: 'class A { int x; }' }));
add('往 .vibe 根下新建脚本', 'pre-edit', edit('.vibe/Tq.java', 'Write', { content: 'class Tq {}' }), /事由是变更名的留着别删，变更归档之后套件自己清；别的事由，那件事做完就把整个目录删掉，七天没动的也会自动清掉/, V2248);
add('往 .vibe/tmp 根下新建', 'pre-edit', edit('.vibe/tmp/commitmsg.txt', 'Write', { content: 'x' }), /事由是变更名的留着别删，变更归档之后套件自己清；别的事由，那件事做完就把整个目录删掉，七天没动的也会自动清掉/, V2248);
add('往 .vibe/tmp/<事由>/ 新建', 'pre-edit', edit('.vibe/tmp/0928-排查/q.js', 'Write', { content: 'console.log(1)' }));
add('新建备份文件', 'pre-edit', edit('src/main/java/com/x/A.java.bak', 'Write', { content: 'x' }), /一件事一个目录；事由是变更名的留到变更归档，别的做完就删/, V2248);
add('新建报告（产出位置没定）', 'pre-edit', edit('报告/分析.md', 'Write', { content: '# 分析\n' }));
add('改套件的配置', 'pre-edit', edit('~/vibe-kit/config.json', 'Edit', { old_string: 'a', new_string: 'b' }));
add('改全局约定', 'pre-edit', edit('~/CLAUDE.md', 'Write', { content: 'x' }));
add('项目设置里写 disableAllHooks', 'pre-edit', edit('.claude/settings.local.json', 'Write', { content: '{"disableAllHooks": true}' }));
add('项目设置里写别的', 'pre-edit', edit('.claude/settings.local.json', 'Write', { content: '{"env": {}}' }));
add('改 GBK 文件', 'pre-edit', (kit) => {
  const proj = project(kit);
  const f = path.join(proj, 'src', 'main', 'java', 'com', 'x', 'G.java');
  fs.writeFileSync(f, Buffer.concat([Buffer.from('package com.x;\n// '), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xD7, 0xA2, 0xCA, 0xCD]), Buffer.from('\nclass G {}\n')]));
  return { proj, j: base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f, old_string: 'class G {}', new_string: 'class G { int x; }' } }) };
});
add('没探索就写提案', 'pre-edit', edit('openspec/changes/new-one/proposal.md', 'Write', { content: '## Why\n\n要做。\n\n## What Changes\n\n- 加功能\n' }));
add('提案里有"待定"', 'pre-edit', edit('openspec/changes/add-export/proposal.md', 'Edit', { old_string: '- 加导出接口', new_string: '- 加导出接口\n- 权限怎么控制待定' }));
add('任务太笼统、没写验法', 'pre-edit', edit('openspec/changes/add-export/tasks.md', 'Edit', { old_string: '- [ ] 1.2', new_string: '- [ ] 1.3 完善\n- [ ] 1.4 改 src/main/java/com/x/B.java\n- [ ] 1.2' }));
add('规格缺场景', 'pre-edit', edit('openspec/changes/add-export/specs/export/spec.md', 'Write', { content: '## ADDED Requirements\n\n### Requirement: 导出\n\n系统应当能导出。\n' }));
add('规格写得对', 'pre-edit', edit('openspec/changes/add-export/specs/export/spec.md', 'Write', { content: '## ADDED Requirements\n\n### Requirement: 导出\n\n系统应当能导出。\n\n#### Scenario: 正常导出\n\n- WHEN 选中 3 条点导出\n- THEN 下载的文件里有 3 行\n' }));
add('设计里提到存在的文件', 'pre-edit', edit('openspec/changes/add-export/design.md', 'Edit', { old_string: '- 读过 pom.xml', new_string: '- 读过 pom.xml\n- 读过 src/main/java/com/x/B.java' }));
add('打勾：跑过写明的命令', 'pre-edit', edit('openspec/changes/add-export/tasks.md', 'Edit', { old_string: '- [ ] 1.2', new_string: '- [x] 1.2' }, null,
  (proj) => [H.tr.user('继续'), H.tr.ran('Edit', { file_path: path.join(proj, 'openspec/changes/add-export/tasks.md'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS')]));
// 这次有意改的
add('任务里提到不存在的文件', 'pre-edit', edit('openspec/changes/add-export/tasks.md', 'Edit', { old_string: '- [ ] 1.2', new_string: '- [ ] 1.3 改 src/main/java/com/x/Nope.java；验：`mvn -q -o compile`\n- [ ] 1.2' }), /第 2 行提到的 src\/main\/java\/com\/x\/Nope\.java 在项目里找不到。是这次要新建的/);
add('设计里提到不存在的文件', 'pre-edit', edit('openspec/changes/add-export/design.md', 'Edit', { old_string: '- 读过 pom.xml', new_string: '- 读过 pom.xml\n- 现有逻辑在 src/main/java/com/x/Nope.java 里' }), /Nope\.java 在项目里找不到。是这次要新建的/);
add('打勾：没跑过验法', 'pre-edit', edit('openspec/changes/add-export/tasks.md', 'Edit', { old_string: '- [ ] 1.2', new_string: '- [x] 1.2' }, null,
  (proj) => [H.tr.user('继续'), H.tr.ran('Edit', { file_path: path.join(proj, 'openspec/changes/add-export/tasks.md'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'git status' }, 'clean')]), /这段会话记录里还没看到它成功跑过。要看到的是：跑过 `mvn -q -o compile`/, V0929);
add('直接改经验规则文件', 'pre-edit', edit('.claude/rules/vibe-lessons-java.md', 'Write', { content: '- x\n' }), /这是经验规则的文件，不要直接改/);

// ---------- 跑命令 ----------
// 这一版有意改的：归档的提示里写清审查提示第二行怎么写；注释不是命令；规格增量要放在认得的标题下面
add('命令：归档没做完的变更', 'guard-commit', cmd('openspec archive add-export -y'), /第二行写\\?"变更：add-export\\?"/, V0929);
add('命令：注释里提到套件的路径', 'guard-commit', cmd('# 先用 node "$HOME/.claude/vibe-kit/tools/trace.js" 溯源过了\ngit checkout -- src/main/java/com/x/A.java'), /放行，没有输出/, V0929);
add('命令：注释里写了 git push', 'guard-commit', cmd('git status # 之后再 git push'), /放行，没有输出/, V0929);
add('规格的需求没放在增量标题下面', 'pre-edit', edit('openspec/changes/add-export/specs/export/spec.md', 'Write', { content: '## 需求\n\n### Requirement: 导出\n\n系统应当能导出。\n\n#### Scenario: 正常导出\n\n- WHEN 选中 3 条点导出\n- THEN 下载的文件里有 3 行\n' }), /没放在增量标题下面/, V0929);
// 1008 有意改的：不走 OpenSpec 的提交（这个会话没动过变更）要用户点头
for (const c of ['git commit -m "feat: 新增导出"', 'git commit -m "fix: 导出漏了表头（源自 add-export 2.3）"', 'git add src/main/java/com/x/A.java && git commit -m "feat: 新增导出"']) add('命令：' + c, 'guard-commit', cmd(c), /不走 OpenSpec 的改动，提交之前要我点头/, V1008);
add('命令：用户说了提交再提交', 'guard-commit', (kit) => { const proj = project(kit); const j = base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add src/main/java/com/x/A.java && git commit -m "feat: 新增导出"' } }); j.transcript_path = H.transcript(path.join(path.dirname(proj), 't.jsonl'), [H.tr.user('改好了，提交')]); return { proj, j }; });
for (const c of ['ls -la', 'git status', 'mvn -q -o compile', 'git commit -m "改了点东西"', 'git commit -am "feat: x"',
  'git push', 'git -C "<项目>" push origin main', 'rm -rf ~/.claude/vibe-kit/hooks', 'cat ~/.claude/vibe-kit/config.json', 'echo x > ~/.claude/settings.json', 'node ~/.claude/vibe-kit/install.js --uninstall',
  'node "$HOME/.claude/vibe-kit/tools/feedback.js" list', 'taskkill //F //IM node.exe', 'pkill node', 'node "$HOME/.claude/vibe-kit/tools/devserver.js" start --name a --port 8080 -- mvn spring-boot:run',
  'curl -s http://127.0.0.1:15730/api/kit -H "x-vibe-router: 1"', 'curl -s http://127.0.0.1:8080/api/orders',
  'git add src/main/java/com/x/A.java.bak', 'grep -rn disableAllHooks .', 'echo \'{"disableAllHooks":true}\' > .claude/settings.local.json']) add('命令：' + c, 'guard-commit', cmd(c));
add('PowerShell：git commit -m "feat: 新增导出"; if ($?) { git push }', 'guard-commit', cmd('git commit -m "feat: 新增导出"; if ($?) { git push }', 'PowerShell'), /不走 OpenSpec 的改动，提交之前要我点头/, V1008);
for (const c of ['Remove-Item -Recurse $env:USERPROFILE\\.claude\\vibe-kit', 'Get-Content $env:USERPROFILE\\.claude\\vibe-kit\\config.json', 'Stop-Process -Name node -Force'])
  add('PowerShell：' + c, 'guard-commit', cmd(c, 'PowerShell'));
// 1008 有意改的：敲 /opsx:apply 开工时告诉用户全自动开没开（systemMessage），给模型的提醒里也有一句
add('开口：敲 /opsx:apply（开工时说全自动开没开）', 'task-anchor', prompt('/opsx:apply add-export'), /开始 apply：全自动模式关着/, V1008);
add('开口：说"开工"（点名变更）', 'task-anchor', (kit) => { const r = prompt('提案看过了，开工 add-export', null, () => [H.tr.user('做一个导出功能'), H.tr.say('提案写好了')])(kit); r.j.session_id = 'sess-diff-start'; return r; }, /开始 apply：全自动模式关着/, V1008);
// 这一版有意改的：整仓 add 的提示里说了新建的仓库第一次入仓不拦；过程文件的提示里写明事由是变更名的留到变更归档；
// 变更没归档之前不让删它的过程文件；目录写在变量里的 git 命令说清是算不出是哪个仓库
for (const c of ['git add -A', 'git add .']) add('命令：' + c, 'guard-commit', cmd(c), /新建的仓库第一次入仓（还没有任何提交）不拦，可以整仓 add/, V2248);
for (const c of ['cp src/main/java/com/x/A.java src/main/java/com/x/A.java.bak', 'mvn -q compile > build.log 2>&1']) add('命令：' + c, 'guard-commit', cmd(c), /一件事一个目录；事由是变更名的留到变更归档，别的做完就删/, V2248);
add('PowerShell：' + 'Copy-Item src\\main\\java\\com\\x\\A.java src\\main\\java\\com\\x\\A_bak.java', 'guard-commit', cmd('Copy-Item src\\main\\java\\com\\x\\A.java src\\main\\java\\com\\x\\A_bak.java', 'PowerShell'), /一件事一个目录；事由是变更名的留到变更归档，别的做完就删/, V2248);
add('命令：删没归档的变更的过程文件', 'guard-commit', cmd('rm -rf .vibe/tmp/add-export', 'Bash', { '.vibe/tmp/add-export/probe.js': '// x\n' }), /是变更 add-export 的过程文件，变更还没归档，先留着/, V2248);
add('命令：删别的事由的过程文件', 'guard-commit', cmd('rm -rf .vibe/tmp/0930-排查', 'Bash', { '.vibe/tmp/0930-排查/probe.js': '// x\n' }));
add('命令：目录写在变量里的整仓 add', 'guard-commit', cmd('git -C "$r" add -A .'), /目录写在变量里（[^）]*\$r[^）]*），算不出是哪个仓库/, V2248);
add('命令：循环里对老仓库整仓 add', 'guard-commit', cmd('for r in . ; do git -C "$r" add -A .; done'), /会把你工作区里原来就有的改动/, V2248);
// 20260930.1505 有意改的：cd 和别的命令串在一条里，Claude Code 会停下来要人确认（跳过权限模式也问），拦下并给出不用 cd 的写法；起服务的提示里写了 --dir
add('命令：cd src && git push', 'guard-commit', cmd('cd src && git push'), /这条命令先 cd 到 src，再跑 git[\s\S]*git -C \\"src\\" push/, V1505);
add('命令：cd 到子目录再编译', 'guard-commit', cmd('cd src && mvn -q -o compile'), /mvn -f \\"src\/pom\.xml\\" -q -o compile/, V1505);
// 1007：端口改成 --port auto --avoid <配置里的端口>，提示里的命令和说法跟着改
add('命令：mvn spring-boot:run', 'guard-commit', cmd('mvn spring-boot:run'), /起服务自测用 devserver\.js[\s\S]*--port auto --avoid[\s\S]*start 后面加 --cwd <子目录>，不要先 cd/, V1007);
add('命令：npm run dev', 'guard-commit', cmd('npm run dev'), /起服务自测用 devserver\.js[\s\S]*--port auto --avoid[\s\S]*start 后面加 --cwd <子目录>，不要先 cd/, V1007);
add('命令：删经验规则文件', 'guard-commit', cmd('rm .claude/rules/vibe-lessons-java.md'), /会改到经验规则的文件/);
add('命令：提交经验规则文件', 'guard-commit', cmd('git add .claude/rules/vibe-lessons-java.md && git commit -m "docs: 更新经验规则"'));

// 20260928.2054 有意改的：令牌和模型的 key 不给读；跑发布脚本要用户确认。
// 读令牌的这几条 0930 审查之后又改了提示：点明是哪个文件放着令牌、key（还是一样拦），记成这一版改的
add('命令：读令牌', 'guard-commit', cmd('cat ~/.claude/vibe-kit/secrets.json'), /令牌或者模型的 key（~\/\.claude\/vibe-kit\/secrets\.json 就是放令牌、放模型 key 的文件）[\s\S]*"permissionDecision": "deny"/, V0930);
add('命令：读模型的 key', 'guard-commit', cmd('head -20 "$HOME/.claude/vibe-kit/router-data/config.json"'), /令牌或者模型的 key（\$HOME\/\.claude\/vibe-kit\/router-data\/config\.json 就是放令牌、放模型 key 的文件）[\s\S]*"permissionDecision": "deny"/, V0930);
add('命令：把用户目录整个搜一遍', 'guard-commit', cmd('grep -rn api_key ~/.claude'), /令牌或者模型的 key（搜 ~\/\.claude 会搜到套件放令牌、放模型 key 的文件）[\s\S]*"permissionDecision": "deny"/, V0930);
add('PowerShell：读令牌', 'guard-commit', cmd('Get-Content $env:USERPROFILE\\.claude\\vibe-kit\\secrets.json', 'PowerShell'), /secrets\.json 就是放令牌、放模型 key 的文件）[\s\S]*"permissionDecision": "deny"/, V0930);
add('命令：跑发布脚本', 'guard-commit', (kit) => {
  const r = cmd('node pkg/publish.js --no-install')(kit);
  H.write(path.join(r.proj, 'pkg', 'install.js'), '// 安装包\n');
  H.write(path.join(r.proj, 'pkg', 'publish.js'), '// 发布\n');
  H.write(path.join(r.proj, 'pkg', 'kit', 'VERSION'), '20260101.0000\n');
  return r;
}, /发布到团队的 GitLab 仓库（里面有 git push，同事的电脑会跟着更新），发布要你确认/, V0929);
add('命令：项目自己的 publish.js', 'guard-commit', (kit) => { const r = cmd('node scripts/publish.js')(kit); H.write(path.join(r.proj, 'scripts', 'publish.js'), '// 项目自己的\n'); return r; });
add('命令：列套件目录', 'guard-commit', cmd('ls -la ~/.claude/vibe-kit'));
// 这一版有意改的：整条命令只是列目录、按名字找、过滤名单的不拦（以前当成"列了再读""搜套件目录"）；列完接着读的照样拦
add('命令：列套件目录看前几行', 'guard-commit', cmd('ls -la "$HOME/.claude/vibe-kit/" 2>&1 | head -30'), /放行，没有输出/, { from: V0930, to: V2248 });
add('命令：在 ~/.claude 里按名字找', 'guard-commit', cmd('find "$HOME/.claude" -maxdepth 1 -iname "*.md" 2>/dev/null'), /放行，没有输出/, V2248);
add('命令：列套件目录再交给 xargs 读', 'guard-commit', cmd('ls ~/.claude/vibe-kit | xargs cat'));
add('命令：在套件目录里找到就读', 'guard-commit', cmd('find ~/.claude/vibe-kit -name "*.json" -exec cat {} +'));
const grepIn = (input) => (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: Object.assign({}, input, input.path === '<套件>' ? { path: kit.kit } : input.path === '<项目>' ? { path: proj } : {}) }) }; };
add('Grep：对着套件目录搜内容', 'guard-read', grepIn({ pattern: 'token', path: '<套件>', output_mode: 'content' }), /里有放令牌、放模型 key 的文件/, V0928B);
add('Grep：对着套件目录只看文件名', 'guard-read', grepIn({ pattern: 'token', path: '<套件>', output_mode: 'files_with_matches' }));
add('Grep：搜项目的内容', 'guard-read', grepIn({ pattern: 'class', path: '<项目>', output_mode: 'content' }));
add('命令：在套件的钩子里搜', 'guard-commit', cmd('grep -rn kitLock ~/.claude/vibe-kit/hooks'));

// ---------- 收工 ----------
const A = (proj) => path.join(proj, 'src/main/java/com/x/A.java');
add('收工：只回答了问题', 'verify-gate', stop(() => [H.tr.user('这里为什么这么写'), H.tr.say('因为……')]));
add('收工：改了代码没验证', 'verify-gate', stop((p) => [H.tr.user('改一下'), H.tr.ran('Edit', { file_path: A(p), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.say('做完了')]));
add('收工：改了、验了、没提交', 'verify-gate', (kit) => {
  const r = stop((p) => [H.tr.user('改一下'), H.tr.ran('Edit', { file_path: A(p), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS'), H.tr.say('做完了')])(kit);
  fs.appendFileSync(A(r.proj), '// 改过\n');
  return r;
});
add('收工：改了页面没看', 'verify-gate', stop((p) => [H.tr.user('改页面'), H.tr.ran('Edit', { file_path: path.join(p, 'web/src/views/Order.vue'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.say('做完了')]));
add('收工：说了没验证', 'verify-gate', stop((p) => [H.tr.user('改一下'), H.tr.ran('Edit', { file_path: A(p), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.say('改好了，没验证：本机没有 JDK')], { last_assistant_message: '改好了，没验证：本机没有 JDK' }));
add('收工：最后一项打了勾、没审', 'verify-gate', (kit) => {
  const r = stop((p) => [H.tr.user('做完 1.2'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS'), H.tr.ran('Edit', { file_path: path.join(p, 'openspec/changes/add-export/tasks.md'), old_string: '- [ ] 1.2', new_string: '- [x] 1.2' }, 'ok'), H.tr.say('做完了')])(kit);
  const t = path.join(r.proj, 'openspec/changes/add-export/tasks.md');
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('- [ ] 1.2', '- [x] 1.2'));
  return r;
});
add('收工：改了产物没记修订', 'verify-gate', stop((p) => [H.tr.user('改设计'), H.tr.ran('Edit', { file_path: path.join(p, 'openspec/changes/add-export/design.md'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.say('做完了')]));
const review = (issues, mode) => H.tr.ran('Agent', { subagent_type: 'vibe-reviewer', prompt: '模式：' + (mode || '代码') + '\n变更：openspec/changes/add-export/', run_in_background: false }, '审过了。\n\n结论：问题 ' + issues + ' 条（会出错 ' + issues + '，有隐患 0，建议 0）');
add('收工：审查报 0 条', 'verify-gate', stop(() => [H.tr.user('审一下'), review(0), H.tr.say('审查没问题')]));
add('收工：审查报了问题、还没处理', 'verify-gate', stop(() => [H.tr.user('审一下'), review(2), H.tr.say('报了 2 条，我看看')]));
add('收工：审查报了问题、改了、验了', 'verify-gate', stop((p) => [H.tr.user('审一下'), review(2), H.tr.ran('Edit', { file_path: A(p), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS'), H.tr.say('都改完了')]), /各记一条经验/, V0928, { lessonAuto: false });
// 这一版起审查报的问题由脚本自动收（开关 lessonAuto，默认开）：开着的时候不再催它自己记
add('收工：审查报了问题、改了、验了（自动收开着）', 'verify-gate', stop((p) => [H.tr.user('审一下'), review(2), H.tr.ran('Edit', { file_path: A(p), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS'), H.tr.say('都改完了')]), /^(?![\s\S]*各记一条经验)/, V0930);

// ---------- 用户开口 ----------
add('开口：提需求', 'task-anchor', prompt('加一个导出订单的功能'));
add('开口：问问题', 'task-anchor', prompt('这里为什么这么写？'));
add('开口：提到表结构（提示规则去掉了）', 'task-anchor', prompt('看一下订单表的表结构'), /放行，没有输出/, V2248);
add('开口：说测试发现问题', 'task-anchor', prompt('测试发现导出报错了'), /这像是在做完的功能上发现的问题（变更还没归档）：先查清原因，改动小（三个文件以内、不改接口和表结构、不改需求）就直接改/, V1008);
add('开口：继续', 'task-anchor', prompt('继续'));
// 1005：闲话、"让它停"只看开头几个字的毛病改了——开头碰巧是"不用""好"的需求，照需求提醒
add('开口：开头是"不用"的需求', 'task-anchor', prompt('不用写提案，直接在 OrderService 加导出接口'), /这像一条需求/, V1005);
add('开口：开头是"好"字的需求', 'task-anchor', prompt('好友列表页面加一个搜索功能'), /这像一条需求/, V1005);
add('开口：应一声', 'task-anchor', prompt('好的，谢谢'));
add('开口：让它停', 'task-anchor', prompt('等等，先别提交'));
add('提交：提案要单独确认', 'guard-commit', cmd('git commit -m "docs: 提案 add-export"'), /提案提交要单独确认/, V1010B);
add('开口：合并push提示确定性工具', 'task-anchor', prompt('合并push'), /merge-push\.js[\s\S]*只处理未推送的本地提交|merge-push\.js/, V1010B);
add('提交：普通文档修订标题不能免确认', 'guard-commit', cmd('git add README.md && git commit -m "docs: 修订使用说明"'), /不走 OpenSpec 的改动，提交之前要我点头/, V1010B);
add('提案：不能引用本机临时输入', 'pre-edit', edit('openspec/changes/add-export/proposal.md', 'Write', { content: '## Why\n参考 .vibe/tmp/reference.json\n' }, { 'openspec/changes/add-export/proposal.md': '## Why\n业务现状\n', '.vibe/tmp/reference.json': '{}' }), /另一台电脑拿不到[\s\S]*assets/, V1010B);
add('提交：整目录不能遗漏临时输入', 'guard-commit', cmd('git add openspec/changes/add-export && git commit -m "docs: 修订产物"', null, { 'openspec/changes/add-export/proposal.md': '## Why\n参考 .vibe/tmp/reference.json\n', 'openspec/changes/add-export/tasks.md': '- [ ] 1.1 改 src/main/java/A.java；验：mvn -q compile\n' }), /材料不能交付/, V1010B);

// ---------- 会话开始、读文件提醒、提问框 ----------
// 项目说明不一定是 /onboard 查的了（后台自动探索也会写）：带给模型的那句话里不再说是谁查的
add('会话开始：普通项目', 'session-start', (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { hook_event_name: 'SessionStart', source: 'startup' }) }; }, /Bash 里不要把 cd 和别的命令串在一条里[\s\S]*项目说明（[^）]*project\.md；和实际对不上时以实际为准/, V1505);
// 压缩之后按会话的启动目录算（这一版起）：这一项用自己的会话编号，免得拿上一项记下的启动目录当成它的
add('会话开始：压缩之后', 'session-start', (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { session_id: 'sess-diff-compact', hook_event_name: 'SessionStart', source: 'compact' }) }; }, /Bash 里不要把 cd 和别的命令串在一条里[\s\S]*项目说明（[^）]*project\.md；和实际对不上时以实际为准/, V1505);
// 新名字的审查代理、新名字的规则文件：这一版认，上一版不认
add('改经验规则文件（新名字）', 'pre-edit', edit('.claude/rules/ttls-lessons-java.md', 'Write', { content: '- x\n' }), /这是经验规则的文件，不要直接改/, V0930);
add('会话开始：壳子', 'session-start', (kit) => {
  const shell = path.join(kit.work, 'c' + (++n), 'proj');
  H.makeRepo(shell, { 'openspec/project.md': '# x\n', 'CLAUDE.md': '# 壳子\n' });
  H.makeRepo(path.join(shell, 'svc-a'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  H.makeRepo(path.join(shell, 'svc-b'), { 'package.json': '{}\n' });
  return { proj: shell, j: base(shell, kit, { hook_event_name: 'SessionStart', source: 'startup' }) };
}, /在这一层对子项目跑命令不要 cd[\s\S]*git -C <子项目目录>[\s\S]*mvn -f <子项目目录>\/pom\.xml[\s\S]*npm --prefix <子项目目录>/, V1505);
add('读到 sql 文件（提示规则去掉了）', 'source-hint', (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(proj, 'db/init.sql') }, tool_response: {} }) }; }, /放行，没有输出/, V2248);
add('读到 java 文件', 'source-hint', (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: A(proj) }, tool_response: {} }) }; });
add('提问框', 'guard-ask', (kit) => { const proj = project(kit); return { proj, j: base(proj, kit, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }) }; });

let same = 0;
let changed = 0;
for (const c of cases) {
  const out = {};
  const start = n;
  for (const k of ['old', 'new']) {
    n = start;   // 两版的项目目录编号一样，输出里的路径才对得上
    let built;
    try { built = c.build(kits[k]); } catch (e) { H.ok(c.name + '（' + k + ' 版准备输入时出错）', false, String(e && e.stack)); continue; }
    if (c.config) H.setConfig(kits[k], c.config);
    const r = H.hook(kits[k], c.hook, built.j);
    if (c.config) H.setConfig(kits[k], Object.fromEntries(Object.keys(c.config).map((x) => [x, undefined])));
    out[k] = norm(r === null ? '(放行，没有输出)' : JSON.stringify(r, null, 1), kits[k], built.proj);
  }
  if (out.old === undefined || out.new === undefined) continue;
  // DIFF_SHOW=1：把每个输入在新版上的结果列出来（确认这批输入真的打到了各道检查，不是都放行）
  if (process.env.DIFF_SHOW === '1') console.log('    ' + c.name.padEnd(30) + ' → ' + out.new.replace(/\s+/g, ' ').slice(0, 110));
  if (c.expect) {
    changed++;
    H.ok('有意改的 · ' + c.name + '：新版符合预期', c.expect.test(out.new), '新版：' + out.new);
    if (changedSince(c)) H.ok('有意改的 · ' + c.name + '：和旧版确实不同', out.old !== out.new, '两版一样：' + out.new);
    else H.ok('上一版（' + OLD_VERSION + '）' + (typeof c.since === 'object' && OLD_VERSION < c.since.from ? '还没有这个毛病' : '已经改过') + '的 · ' + c.name + '：两版一样', out.old === out.new, '旧版：' + out.old + '\n      新版：' + out.new);
  } else {
    same++;
    H.ok('不该变的 · ' + c.name, out.old === out.new, '旧版：' + out.old + '\n      新版：' + out.new);
  }
}
console.log('上一版是 ' + OLD_VERSION + '。比了 ' + cases.length + ' 个输入：' + same + ' 个要求两版一样，' + changed + ' 个是有意改过的（其中 ' + cases.filter((c) => c.expect && changedSince(c)).length + ' 个是上一版之后改的）');
H.done('新旧钩子对比');
