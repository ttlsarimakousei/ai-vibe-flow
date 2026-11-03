'use strict';
/*
 * J4 后半（2026-11-01，docs/feedback-20261101.md）：OpenSpec 规范改成进流程时由钩子送，压缩后重送。
 *   安装器  标着"钩子送"的规范不进全局约定，填好占位符写成 hook-rules.md；--sync 也写；remove.txt 去掉的句子也去掉；卸载删掉
 *   全局约定留一句指路的
 *   开口    敲 /opsx:explore、/opsx:propose、开工第一次送规范和这一段的规矩；同一个会话不重复；不进流程的不送
 *   工具    模型没经过这些入口，自己跑 openspec、改 openspec/ 下的文件：工具跑完送一次规范
 *   压缩    还在流程里的马上重送当前这一段；不在流程里的不送，下次进流程再送；/clear 之后记录清掉
 * 用法：node dev/test-stage-rules.js [旧版的 vibe-kit 目录]（给了就拿旧版的安装包跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? path.resolve(process.argv[2]) : null;
const SPEC = 'OpenSpec 管需求、设计和任务';
const V = '20261101.0900';
function pkgOf(name, version) {
  if (!FROM) return H.makePackage(name, version);
  const dir = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(FROM, dir, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(dir);
  fs.writeFileSync(path.join(dir, 'kit', 'VERSION'), version + '\n');
  return dir;
}
const pkg = pkgOf('sr-pkg', V);
const CHANGE = { 'openspec/changes/feat-019/proposal.md': '# 提案\n', 'openspec/changes/feat-019/tasks.md': '## 1. 第一组\n- [ ] 1.1 改 src/A.java\n' };
function machine(name) {
  const h = H.freshHome(name);
  const r = H.node(h, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  H.ok('（' + name + ' 装上了）', r.code === 0, r.out + r.err);
  // 第一次使用的说明不掺进这里的比较
  H.write(path.join(h.kit, 'state', 'welcome.json'), JSON.stringify({ pending: false }));
  h.p = H.makeRepo(path.join(h.root, 'work', 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE));
  let n = 0;
  h.say = (sid, prompt) => { n++; const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: h.p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'tr-' + n + '.jsonl'), [H.tr.user(prompt)]) }, { spawn: true }); return typeof o === 'string' ? o : JSON.stringify(o || ''); };
  h.start = (sid, source) => JSON.stringify(H.hook(h, 'session-start', { session_id: sid, cwd: h.p, hook_event_name: 'SessionStart', source, transcript_path: '' }, { spawn: true }) || '');
  h.tool = (sid, tool, input) => JSON.stringify(H.hook(h, 'after-tool', { session_id: sid, cwd: h.p, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {}, transcript_path: '' }, { spawn: true }) || '');
  return h;
}
const globalMd = (h) => H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
const hookFile = (h) => path.join(h.kit, 'hook-rules.md');

H.section('安装器：规范不进全局约定，写成 hook-rules.md');
{
  const h = machine('sr-inst');
  const g = globalMd(h);
  H.ok('全局约定里没有 OpenSpec 规范', !g.includes(SPEC) && !g.includes('逐个生成 proposal') && !g.includes('修订与需求回归'), g.length);
  H.ok('全局约定没有标记', !g.includes('vibe-kit:钩子送'));
  H.ok('全局约定留了一句指路的', /`\/opsx:explore`/.test(g));
  H.ok('提交规范照旧在全局约定里', /git/i.test(g) && fs.existsSync(path.join(h.kit, 'rules', '20-git-commit.md')) && g.includes((H.read(path.join(h.kit, 'rules', '20-git-commit.md')) || '').split('\n')[0].trim()), g.slice(-400));
  const t = H.read(hookFile(h)) || '';
  H.ok('hook-rules.md 有规范，占位符填好了，不带标记', t.includes(SPEC) && t.includes('修订与需求回归') && !/\{\{[A-Z_]+\}\}/.test(t) && !t.includes('vibe-kit:钩子送'), t.slice(0, 300));
  fs.unlinkSync(hookFile(h));
  const s = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 120000 });
  H.ok('--sync 也写', s.code === 0 && (H.read(hookFile(h)) || '').includes(SPEC), s.out + s.err);
  const line = t.split('\n').find((l) => l.startsWith('- 多个变更的顺序'));
  H.write(path.join(h.kit, 'user', 'remove.txt'), line + '\n');
  H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 120000 });
  H.ok('user/remove.txt 去掉的句子：hook-rules.md 里也没了', !!line && !(H.read(hookFile(h)) || '').includes('多个变更的顺序'), line);
  const u = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root, timeout: 120000 });
  H.ok('卸载：hook-rules.md 删了', u.code === 0 && !fs.existsSync(hookFile(h)), u.out + u.err);
}

H.section('开口：进流程第一次送规范和这一段的规矩，不重复；不进流程的不送');
{
  const h = machine('sr-say');
  const q = h.say('s-none', '这个 A 类是干什么的？');
  H.ok('问个问题：不送', !q.includes(SPEC), q.slice(0, 300));
  const a = h.say('s-need', '/opsx:explore 做一个订单导出的功能，导出成 xlsx');
  H.ok('敲 /opsx:explore：送规范和写需求这一段的规矩', a.includes(SPEC) && /写需求这一段的规矩/.test(a), a.slice(0, 400));
  const b = h.say('s-need', '再加一个按日期筛选的需求');
  H.ok('同一个会话第二次：都不重复', !b.includes(SPEC) && !/写需求这一段的规矩/.test(b), b.slice(0, 300));
  const c = h.say('s-need', '开工 feat-019');
  H.ok('开工：送做任务这一段的，规范不再送', /做任务这一段的规矩/.test(c) && !c.includes(SPEC), c.slice(0, 400));
  const d = h.say('s-opsx', '/opsx:propose 加一个导出接口');
  H.ok('敲 /opsx:propose：送规范', d.includes(SPEC) && /写需求这一段的规矩/.test(d), d.slice(0, 400));
  const e = h.say('s-go', '/vk-go feat-019');
  H.ok('直接开工的会话：规范和做任务这一段一起送', e.includes(SPEC) && /做任务这一段的规矩/.test(e), e.slice(0, 400));
  const later = h.say('s-go', '接着做');
  H.ok('在流程里接着说：不重复', !later.includes(SPEC), later.slice(0, 300));
  fs.unlinkSync(hookFile(h));
  const f = h.say('s-nofile', '/opsx:explore 做一个订单导入的功能，从 xlsx 导入');
  H.ok('hook-rules.md 不在（老版本、生成失败）：照样送这一段的规矩，不出错', /写需求这一段的规矩/.test(f), f.slice(0, 300));
}

H.section('工具：模型没经过这些入口就开始走 OpenSpec，工具跑完送一次规范');
{
  const h = machine('sr-tool');
  H.ok('普通命令：不送', !h.tool('s-t', 'Bash', { command: 'git status' }).includes(SPEC));
  H.ok('普通文件：不送', !h.tool('s-t', 'Edit', { file_path: path.join(h.p, 'src', 'A.java') }).includes(SPEC));
  H.ok('只看版本：不送', !h.tool('s-t', 'Bash', { command: 'openspec --version' }).includes(SPEC));
  H.ok('openspec new：送', h.tool('s-t', 'Bash', { command: 'openspec new change add-x' }).includes(SPEC));
  H.ok('再跑一次：不重复', !h.tool('s-t', 'Bash', { command: 'openspec status --change add-x' }).includes(SPEC));
  H.ok('改了 openspec/ 下的文件：送', h.tool('s-t2', 'Write', { file_path: path.join(h.p, 'openspec', 'changes', 'add-x', 'proposal.md') }).includes(SPEC));
  const later = h.say('s-t2', '/opsx:continue');
  H.ok('工具这边送过了：开口只送这一段的规矩', !later.includes(SPEC) && /写需求这一段的规矩/.test(later), later.slice(0, 300));
}

H.section('压缩：还在流程里的马上重送；不在流程里的下次进流程再送；/clear 之后记录清掉');
{
  const h = machine('sr-compact');
  h.say('s-c', '/vk-go feat-019');
  const c = h.start('s-c', 'compact');
  H.ok('做任务时压缩：重送规范和做任务这一段', c.includes(SPEC) && /做任务这一段的规矩/.test(c), c.slice(0, 400));
  const next = h.say('s-c', '接着做');
  H.ok('压缩后下一句：不重复', !next.includes(SPEC), next.slice(0, 300));
  h.say('s-p', '/opsx:propose 加一个导出接口');
  H.write(path.join(h.kit, 'state', 's-p-ckpt-hint.json'), JSON.stringify({ keys: ['apply'] }));
  const p = h.start('s-p', 'compact');
  H.ok('压缩后：开工前存检查点的提醒也能再送', !/apply/.test(H.read(path.join(h.kit, 'state', 's-p-ckpt-hint.json')) || ''));
  H.ok('写需求时压缩：重送规范和写需求这一段', p.includes(SPEC) && /写需求这一段的规矩/.test(p), p.slice(0, 400));
  const none = h.start('s-n', 'compact');
  H.ok('不在流程里的压缩：不送', !none.includes(SPEC), none.slice(0, 300));
  const r = h.start('s-p', 'resume');
  H.ok('恢复会话：上下文还在，不重送', !r.includes(SPEC), r.slice(0, 300));
  h.start('s-p', 'clear');
  const st = H.read(path.join(h.kit, 'state', 's-p-stage-rules.json')) || '{}';
  H.ok('/clear：送过的记录清掉', !/openspec|plan/.test(st), st);
}

H.done('规范进流程时送、压缩后重送' + (FROM ? '，拿 ' + FROM + ' 跑' : ''));
