'use strict';
/*
 * 2026-10-17 这一批（用户看了配置页之后定的）里，别的测试没覆盖到的几件：
 *   任务清单只写实现      tasks.md 不要求"验："；[代码审查][测试][用户验收] 这种不写进任务清单，新加的拦下
 *   验收用例写进设计      新写的 design.md 要有"## 验收用例"一节、写预期；老变更的设计不追究
 *   需求文档一份一份来    人工模式：上一份写完、用户说过话才写下一份
 *   自带的 OpenSpec      openspec 命令改成调用套件自带的那份；项目没有 openspec/ 先建；Node 不够（自带的用不了）照原命令跑
 *                        命令不支持时按在用的那份提示；安装器装成用户级 /opsx:* 命令和 openspec-* 技能，卸载收回
 *   提交方式             旧的提交档位、"不走 OpenSpec 的改动"升级后一律按"询问"
 * 用法：node dev/test-1017.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRC = FROM || H.SRC;
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const ago = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); };
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false };
const DESIGN_OK = ['## Context', '', '- 读过 src/A.java：现在只有查询', '- 读过 pom.xml：Spring Boot 2.7', '', '## Decisions', '', '- 导出放在 A.java 里，不新开类：只有一个接口', '',
  '## 验收用例', '', '| 编号 | 对应场景 | 前置数据和环境 | 步骤 | 预期 | 谁来测 | 对应任务 |', '|---|---|---|---|---|---|---|',
  '| AC-1 | 正常导出 | 测试库里有 3 条订单 | 调 GET /export | 返回 3 行，状态码 200 | Claude：curl http://localhost:8080/export | 1 |', ''].join('\n');

(async () => {
  const watch = await H.watchWindows('t1017-win');

  // ---------------------------------------------------------------------------------------------
  H.section('任务清单只写实现；验收用例写进设计；需求文档一份一份来（人工模式）');
  {
    const h = H.makeHome('t1017-spec', FROM, QUIET);
    const proj = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
      'openspec/changes/add-x/proposal.md': '## Why\n\n要导出订单。\n\n## What Changes\n\n- 加导出接口\n',
      'openspec/changes/add-x/specs/export/spec.md': '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 能导出订单。\n\n#### Scenario: 正常导出\n\n- **WHEN** 有 3 条订单时调导出\n- **THEN** 返回 3 行\n',
      'openspec/changes/old-y/proposal.md': '## Why\n\n老变更。\n',
      'openspec/changes/old-y/design.md': '## Context\n\n- 读过 src/A.java\n- 读过 pom.xml\n' });
    const chg = path.join(proj, 'openspec', 'changes', 'add-x');
    const tf = path.join(h.root, 't.jsonl');
    const write = (rel, content, entries) => H.hook(h, 'pre-edit', { session_id: 's-spec', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, rel), content }, transcript_path: H.transcript(tf, entries || [H.tr.user('接着写')]) });
    const editIn = (rel, oldS, newS) => H.hook(h, 'pre-edit', { session_id: 's-spec', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, rel), old_string: oldS, new_string: newS }, transcript_path: H.transcript(tf, [H.tr.user('接着写')]) });
    // 用户在 proposal、specs 写完之后说过话（会话记录里的时间是一小时之内，文件拨到两小时前）
    for (const f of ['proposal.md', 'specs/export/spec.md']) ago(path.join(chg, f), 2 * 3600000);

    const noCase = write('openspec/changes/add-x/design.md', '## Context\n\n- 读过 src/A.java：现在只有查询\n- 读过 pom.xml\n\n## Decisions\n\n- 导出放在 A.java 里\n');
    H.ok('新写的设计没有"## 验收用例"：拦下，说清每条写什么', blocked(noCase) && /缺"## 验收用例"一节/.test(H.reasonOf(noCase)) && /谁来测/.test(H.reasonOf(noCase)), H.reasonOf(noCase));
    const noExpect = write('openspec/changes/add-x/design.md', DESIGN_OK.replace(/预期/g, '结果'));
    H.ok('验收用例没写预期：拦下', blocked(noExpect) && /没写预期/.test(H.reasonOf(noExpect)), H.reasonOf(noExpect));
    const okDesign = write('openspec/changes/add-x/design.md', DESIGN_OK);
    H.ok('设计写了验收用例（一条一行、有预期）：放行', !blocked(okDesign), H.reasonOf(okDesign));
    H.ok('老变更的设计改别的地方：不追究验收用例', !blocked(editIn('openspec/changes/old-y/design.md', '- 读过 pom.xml', '- 读过 pom.xml：Spring Boot 2.7')));

    H.write(path.join(chg, 'design.md'), DESIGN_OK);
    // 设计刚写完、用户还没说话：一份一份来，先停下给用户看
    const early = write('openspec/changes/add-x/tasks.md', '- [ ] 1.1 改 src/A.java：加导出接口\n');
    H.ok('人工模式：design 写完用户还没看就写 tasks，拦下让它停下问"审一下 / 直接写下一份 / 我要改"', blocked(early) && /design 写完还没给我看过/.test(H.reasonOf(early)) && /审一下/.test(H.reasonOf(early)) && /openspec instructions tasks --change "add-x"/.test(H.reasonOf(early)), H.reasonOf(early));
    ago(path.join(chg, 'design.md'), 2 * 3600000);
    const plain = write('openspec/changes/add-x/tasks.md', '- [ ] 1.1 改 src/A.java：加导出接口\n- [ ] 1.2 新建 src/ATest.java：写导出的单元测试\n');
    H.ok('用户看过 design 之后写 tasks；任务不写"验："、交付的测试代码也能列：放行', !blocked(plain), H.reasonOf(plain));
    H.write(path.join(chg, 'tasks.md'), '- [ ] 1.1 改 src/A.java：加导出接口\n');
    for (const [tag, line] of [['代码审查', '- [ ] 1.2 [代码审查] 审查 src/A.java'], ['测试', '- [ ] 1.2 [测试] 跑一遍导出'], ['用户验收', '- [ ] 1.2 [用户验收] 用户验收导出']]) {
      const r = editIn('openspec/changes/add-x/tasks.md', '- [ ] 1.1 改 src/A.java：加导出接口', '- [ ] 1.1 改 src/A.java：加导出接口\n' + line);
      H.ok('任务清单里加 [' + tag + ']：拦下，说写进 design.md 的验收用例', blocked(r) && /是测试、审查或验收，不写进任务清单/.test(H.reasonOf(r)) && /design\.md 的"验收用例"一节/.test(H.reasonOf(r)), H.reasonOf(r));
    }
  }

  // ---------------------------------------------------------------------------------------------
  H.section('自带的 OpenSpec：openspec 命令改成调用自带的那份，项目没初始化先建');
  {
    const O = (() => { try { return require(path.join(SRC, 'kit', 'lib', 'openspec.js')); } catch (e) { return null; } })();
    H.ok('有 lib/openspec.js', !!O);
    if (O) {
      H.ok('Node 版本比较：20.18 不够、20.19 够、22 够', !O.nodeOk('>=20.19.0', '20.18.1') && O.nodeOk('>=20.19.0', '20.19.0') && O.nodeOk('>=20.19.0', '22.1.0'));
      const bin = O.BIN.replace(/\\/g, '/');
      const rw = (c, ps) => O.rewrite(c, ps);
      H.ok('openspec list → node "<自带的>" list', rw('openspec list') === 'node "' + bin + '" list', rw('openspec list'));
      H.ok('&& 后面的、npx 写法的也换', rw('git status && openspec status --change a') === 'git status && node "' + bin + '" status --change a' && rw('npx -y @fission-ai/openspec list') === 'node "' + bin + '" list', [rw('git status && openspec status --change a'), rw('npx -y @fission-ai/openspec list')]);
      H.ok('PowerShell 用反斜杠路径', rw('openspec list', true) === 'node "' + O.BIN + '" list', rw('openspec list', true));
      H.ok('不在段首的 openspec（参数、提交信息）、heredoc 正文：不动', rw('echo openspec') === null && rw('git commit -m "docs: openspec 提案"') === null && rw("cat <<'EOF'\nopenspec list\nEOF") === null);
    }
    const h = H.makeHome('t1017-os', FROM, QUIET, { openspec: true });
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    const sub = path.join(proj, 'src');
    const tf = H.transcript(path.join(h.root, 'o.jsonl'), [H.tr.user('列一下变更')]);
    const bash = (cmd, cwd) => H.hook(h, 'guard-commit', { session_id: 's-os', cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd, description: '列变更' }, transcript_path: tf });
    const r1 = bash('openspec list', sub);
    const upd = r1 && r1.hookSpecificOutput && r1.hookSpecificOutput.updatedInput;
    H.ok('openspec list：改成调用自带的那份（updatedInput），别的参数原样留着', !!upd && /openspec[\\/]node_modules[\\/]@fission-ai[\\/]openspec[\\/]bin[\\/]openspec\.js" list$/.test(upd.command) && upd.description === '列变更' && !r1.hookSpecificOutput.permissionDecision, r1);
    H.ok('项目没有 openspec/：在仓库根（不是当前目录）建好了', fs.existsSync(path.join(proj, 'openspec')) && !fs.existsSync(path.join(sub, 'openspec')), fs.readdirSync(proj));
    H.ok('建的时候不往项目里写命令文件', !fs.existsSync(path.join(proj, '.claude')));
    if (upd) {
      const run = H.run(h, process.execPath, [upd.command.match(/^node "([^"]+)"/)[1], 'list'], { cwd: proj, timeout: 60000 });
      H.ok('改写后的命令真的跑得起来', run.code === 0, run.out + run.err);
    }
    H.ok('不是 openspec 的命令：不改', bash('git status') === null);
    // 自带的那份用不了（Node 不够；这里把它要求的版本改成 99 来装作 Node 不够）：照原命令跑，用同事自己装的
    const pkg = path.join(h.kit, 'openspec', 'node_modules', '@fission-ai', 'openspec', 'package.json');
    const real = H.read(pkg);
    H.write(pkg, real.replace(/"node":\s*"[^"]+"/, '"node": ">=99.0.0"'));
    H.ok('Node 不够用自带的：不改写，照原命令跑（用自己装的）', bash('openspec list') === null);
    const hint = H.hook(h, 'after-tool', { session_id: 's-os', cwd: proj, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'openspec instructions proposal --change a' }, error: 'error: unknown command instructions' });
    H.ok('Node 不够、指令不支持：说清用的是自己装的、升 Node 就用自带的', /项目自己装的 OpenSpec/.test(H.reasonOf(hint)) && /要 Node >=99\.0\.0/.test(H.reasonOf(hint)) && /升级项目里的 OpenSpec/.test(H.reasonOf(hint)), H.reasonOf(hint) || hint);
    H.write(pkg, real);
    const hint2 = H.hook(h, 'after-tool', { session_id: 's-os', cwd: proj, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'openspec frobnicate' }, error: 'error: unknown command frobnicate' });
    H.ok('自带的那份不支持：照 help 改写，不说"自行升级"', /套件自带的 \d+\.\d+\.\d+）不支持这条指令/.test(H.reasonOf(hint2)) && !/自行升级|不内置/.test(H.reasonOf(hint2)), H.reasonOf(hint2) || hint2);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('安装器：自带的 OpenSpec 装成用户级命令和技能，你自己的同名命令先备份，卸载收回');
  {
    // 安装包：拿旧版跑时从旧版拷（依赖放占位，安装器才肯装）；都换上真的 OpenSpec
    const fromPkg = (name) => { if (!FROM) return H.makePackage(name, null); const d = path.join(H.tempDir(name), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; };
    const src = fromPkg('t1017-pkg');
    H.copyDir(path.join(H.SRC, 'kit', 'openspec', 'node_modules'), path.join(src, 'kit', 'openspec', 'node_modules'));
    const u = H.freshHome('t1017-inst');
    H.write(path.join(u.cfg, 'commands', 'opsx', 'propose.md'), '# 我自己写的 propose\n');
    const inst = H.node(u, path.join(src, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
    const man = (() => { try { return JSON.parse(H.read(path.join(u.kit, 'installed.json'))) || {}; } catch (e) { return {}; } })();
    const files = Array.isArray(man.openspec) ? man.openspec : [];
    H.ok('装上了 /opsx:* 命令和 openspec-* 技能（用户级），installed.json 记着', inst.code === 0 && ['apply', 'archive', 'continue', 'explore', 'new', 'propose', 'verify'].every((w) => files.includes('commands/opsx/' + w + '.md') && fs.existsSync(path.join(u.cfg, 'commands', 'opsx', w + '.md'))) && files.some((f) => /^skills\/openspec-propose\/SKILL\.md$/.test(f)), [inst.out.slice(-1500), files]);
    H.ok('一口气生成全部的 ff 不装（和一份一份来冲突）', !fs.existsSync(path.join(u.cfg, 'commands', 'opsx', 'ff.md')));
    H.ok('安装输出写了装的是自带的哪一版', /OpenSpec \d+\.\d+\.\d+（套件自带）/.test(inst.out), inst.out.slice(-1500));
    H.ok('你自己的同名 propose.md 先备份了', /已有同名的 commands\/opsx\/propose\.md（你自己的）/.test(inst.out) && !/我自己写的/.test(H.read(path.join(u.cfg, 'commands', 'opsx', 'propose.md')) || ''), inst.out.slice(-1500));
    const un = H.node(u, path.join(u.kit, 'install.js'), ['--uninstall'], { cwd: u.root, timeout: 120000 });
    H.ok('卸载：装的命令和技能收回了', un.code === 0 && !fs.existsSync(path.join(u.cfg, 'commands', 'opsx', 'apply.md')) && !fs.existsSync(path.join(u.cfg, 'skills', 'openspec-propose', 'SKILL.md')) && !fs.existsSync(path.join(u.kit, 'openspec')), un.out.slice(-800));
    // 自带的那份用不了（Node 不够）：不装，上次装的收回，提示用自己装的
    const low = fromPkg('t1017-pkg-low');
    const v = H.freshHome('t1017-low');
    const i2 = H.node(v, path.join(low, 'install.js'), ['--no-router', '--no-open'], { cwd: v.root, timeout: 240000 });
    H.ok('自带的那份用不了：照样装套件，不装 /opsx 命令，说清用你自己装的', i2.code === 0 && !fs.existsSync(path.join(v.cfg, 'commands', 'opsx', 'apply.md')) && /没装套件自带的 OpenSpec：.*用你自己装的 OpenSpec/.test(i2.out), i2.out.slice(-1500));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('提交方式：旧的提交档位、"不走 OpenSpec 的改动"升级后按"询问"');
  {
    const h = H.makeHome('t1017-commit', FROM, Object.assign({}, QUIET, { autoCommit: 'task', plainCommit: 'auto' }));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const cfg = JSON.parse(H.read(path.join(h.kit, 'config.json')));
    H.ok('旧配置 autoCommit=task、plainCommit=auto：提交方式按"询问"', typeof S.commitModeOf === 'function' && S.commitModeOf(cfg) === 'ask');
    const proj = H.makeRepo(path.join(h.work, 'tool'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
    const r = H.hook(h, 'guard-commit', { session_id: 's-c', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add src/A.java && git commit -m "fix: 空指针"' }, transcript_path: H.transcript(path.join(h.root, 'c.jsonl'), [H.tr.user('修一下 A 的空指针'), H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok'), H.tr.say('修好了')]) });
    H.ok('没说提交就提交：按"询问"拦下，让它用提问框问', blocked(r) && /提交方式是"询问"/.test(H.reasonOf(r)), H.reasonOf(r));
    const gen = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    H.ok('约定里写的是"询问"', gen.code === 0 && /提交方式是"询问"/.test(H.read(path.join(h.cfg, 'CLAUDE.md')) || ''));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('2026-10-17 第二批');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
