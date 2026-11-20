'use strict';
/*
 * 问题表第 92—94 条（2026-11-20，docs/feedback-20261120.md）：
 *   第 94 条：询问没人回等多久按阶段分（写需求、实施、不走 OpenSpec 10 分钟；需求探索 60 分钟，askTimeoutExploreMin）；
 *            到点替用户定的每一件记进 .vibe/auto-decisions.json，提问框它定了什么用 tools/decided.js 登记；
 *            大任务全部做完（不在大任务里的变更做完、不走 OpenSpec 的停下来）时收工钩子一次列出来，列过不再列；
 *            全自动报告以前漏列的"开工那一问到点开工"（decision 这一类）列进"它自己定的事"
 *   第 93 条：任务全部做完后第一次审代码多一个"复用和简化"角度，报的一律 P3、kind 清理，不挡通过，改了要复审
 *   第 92 条：写大任务第一个提案前，探索记录先过一轮多角度讨论（review.js run --mode explore），问题去重后写进"还没定的"
 * 不起真的 Claude Code：claude -p 用假的（VIBE_KIT_CLAUDE_EXE），审查的回复直接交给 R.submit。
 * 用法：node dev/test-feedback1120.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCDIR = FROM || H.SRC;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off', reviewSmallChars: 40000 };
const PLAN_HEAD = '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n';
const need = (f) => { try { return require(f); } catch (e) { return null; } };

/** 假的 claude：按提示里的角度回固定的结果，记下每次调用 */
function fakeClaude(h) {
  const bin = path.join(h.root, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const js = path.join(bin, 'fake-claude.js');
  const log = path.join(h.root, 'claude-calls.jsonl');
  const A = '```json\n' + JSON.stringify({ items: [{ kind: 'ask', question: '导出要不要带停用的商品？', why: '探索记录只说全部商品，影响查询条件' }], summary: '看了' }) + '\n```';
  const B = '```json\n' + JSON.stringify({ items: [{ kind: 'ask', question: '导出要不要带停用的商品', why: '重复的一条' }, { kind: 'unclear', question: '范围说只改导出，定了的又说改列表，到底改不改列表？', why: '两处打架' }] }) + '\n```';
  fs.writeFileSync(js, [
    "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{",
    'fs.appendFileSync(' + JSON.stringify(log) + ',JSON.stringify({lens:(s.match(/这次的角度：(\\S+)/)||[])[1]||"",tools:process.argv.includes("--tools")})+"\\n");',
    'let r=' + JSON.stringify('{"issues":[]}') + ';',
    'if(/这次的角度：用户和业务/.test(s))r=' + JSON.stringify(A) + ';',
    'else if(/这次的角度：现有代码/.test(s))r=' + JSON.stringify(B) + ';',
    'else if(/这次的角度：反方/.test(s))r=' + JSON.stringify('{"items":[]}') + ';',
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:r,usage:{input_tokens:10,output_tokens:5}})+'\\n');process.exit(0)});",
  ].join('\n'));
  const cmd = path.join(bin, 'claude.cmd');
  fs.writeFileSync(cmd, '@"' + process.execPath + '" "' + js + '" %*\r\n');
  return { cmd, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } } };
}

(async () => {
  const watch = await H.watchWindows('f1120-win');
  const h = H.makeHome('f1120', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
  const Rp = require(path.join(h.kit, 'lib', 'report.js'));
  const AD = need(path.join(h.kit, 'lib', 'auto-decisions.js'));
  const EP = need(path.join(h.kit, 'lib', 'explore-panel.js'));
  const fake = fakeClaude(h);
  let seq = 0;
  const tp = (entries) => H.transcript(path.join(h.root, 'tr-' + (++seq) + '.jsonl'), entries);
  const hookFile = path.join(h.kit, 'hooks', 'ask-timeout.js');
  /** 起 ask-timeout 钩子进程，等它退出 */
  const runAsk = (cwd, sid, input, env) => new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [hookFile], { cwd, env: H.envFor(h, Object.assign({ VIBE_KIT_ASK_TIMEOUT_MS: '800', VIBE_KIT_ASK_POLL_MS: '150' }, env || {})), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (x) => { out += x; });
    const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 已经退了 */ } }, 60000);
    c.on('close', () => { clearTimeout(timer); let o = null; try { o = out.trim() ? JSON.parse(out) : null; } catch (e) { o = { raw: out }; } resolve({ out: o, ms: Date.now() - t0 }); });
    c.stdin.end(JSON.stringify(Object.assign({ session_id: sid, cwd, hook_event_name: 'PermissionRequest', permission_mode: 'default' }, input)));
  });
  const decision = (r) => (r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.decision) || {};
  const Q = { questions: [{ question: '导出按钮放在哪', header: '位置', multiSelect: false, options: [{ label: '工具栏', description: '' }, { label: '表格上方', description: '' }] }] };
  const itemsOf = (file) => (AD ? AD.read(file).items : []);

  H.section('第 94 条：等多久按阶段分');
  const F = require(path.join(h.kit, 'lib', 'config-fields.js'));
  const f1 = F.FIELDS.find((x) => x.name === 'askTimeoutMin');
  const f2 = F.FIELDS.find((x) => x.name === 'askTimeoutExploreMin');
  H.ok('askTimeoutMin 默认照旧 10 分钟', !!f1 && f1.def === 10, f1);
  H.ok('新开关 askTimeoutExploreMin：默认 60，0 到 120，在套件开关页', !!f2 && f2.def === 60 && f2.zero === true && f2.max === 120 && f2.page === 'kit', f2);
  const ui = H.read(path.join(SRCDIR, 'kit', 'ui', 'ui.html')) || '';
  H.ok('配置页有探索阶段这一项（控件、读写）', /id="k_askTimeoutExploreMin"/.test(ui) && /fNum\('askTimeoutExploreMin'/.test(ui), '');
  const K = require(hookFile);
  const saved = process.env.VIBE_KIT_ASK_TIMEOUT_MS; delete process.env.VIBE_KIT_ASK_TIMEOUT_MS;
  const cfgW = { askTimeoutMin: 10, askTimeoutExploreMin: 60 };
  H.ok('waitOf：不在探索 10 分钟，在探索 60 分钟，探索那项填 0 是一直等', K.waitOf(cfgW, false) === 600000 && K.waitOf(cfgW, true) === 3600000 && K.waitOf({ askTimeoutMin: 10, askTimeoutExploreMin: 0 }, true) === 0, [K.waitOf(cfgW, false), K.waitOf(cfgW, true)]);
  if (saved !== undefined) process.env.VIBE_KIT_ASK_TIMEOUT_MS = saved;

  // 在做任务的项目（c1 不在哪个大任务里）
  const p = H.makeRepo(path.join(h.work, 'p'), {
    'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
    'openspec/changes/c1/proposal.md': '## Why\n\n要导出。\n',
    'openspec/changes/c1/tasks.md': '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n- [ ] 1.2 改 src/A.java：加校验\n',
  });
  const d1 = path.join(p, 'openspec', 'changes', 'c1');
  const sid = 's-1120'; const j = { session_id: sid, cwd: p };
  H.inFlow(h, sid, [d1], true, 'apply');
  // 在探索的项目（大任务订单，"还没定的"有内容，一个 change 都没开始）
  const pe = H.makeRepo(path.join(h.work, 'pe'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n', 'openspec/explore/订单.md': '# 探索\n\n## 还没定的\n\n导出要不要分页\n\n## 范围\n\n只改导出\n' });
  const sidE = 's-1120e';
  H.inFlow(h, sidE, [], true, 'plan');
  const cmd0 = { command: 'mvn -q -o test', description: '跑测试' };
  const slow = { VIBE_KIT_ASK_TIMEOUT_MS: '600', VIBE_KIT_ASK_EXPLORE_TIMEOUT_MS: '3000' };
  const rE = await runAsk(pe, sidE, { tool_name: 'Bash', tool_input: cmd0, transcript_path: tp([H.tr.user('探索导出'), H.tr.call('Bash', cmd0, 'toolu_e0')]) }, slow);
  const rA = await runAsk(p, sid, { tool_name: 'Bash', tool_input: cmd0, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', cmd0, 'toolu_a0')]) }, slow);
  H.ok('探索阶段按探索那一项等（3 秒才收）', decision(rE).behavior === 'allow' && rE.ms >= 3000, [rE.ms, rE.out]);
  H.ok('做任务时照旧按原来那一项等（不到 3 秒就收）', decision(rA).behavior === 'allow' && rA.ms < 2800, [rA.ms, rA.out]);

  H.section('第 94 条：到点替用户定的记进 .vibe/auto-decisions.json');
  const recFile = path.join(p, '.vibe', 'auto-decisions.json');
  try { fs.unlinkSync(recFile); } catch (e) { /* 上面那一次也记了 */ }
  const r1 = await runAsk(p, sid, { tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, 'toolu_q1')]) });
  const msg1 = String(decision(r1).message || '');
  const fileInMsg = (msg1.match(/--file "([^"]+)"/) || [])[1] || '';
  H.ok('提问框到点：交代里给了登记命令（decided.js、编号、记录文件）', decision(r1).behavior === 'deny' && /decided\.js/.test(msg1) && /--id 1\b/.test(msg1) && !!fileInMsg && S.normKey(fileInMsg) === S.normKey(recFile), msg1);
  const it1 = itemsOf(recFile)[0] || {};
  H.ok('记了这一问：提问框、问题、选项、算在变更 c1 上', it1.kind === 'ask' && /导出按钮放在哪/.test(it1.title) && /工具栏 \/ 表格上方/.test(it1.options) && it1.group === 'change' && (it1.dirs || []).some((x) => S.normKey(x) === S.normKey(d1)), it1);
  const ok2 = await runAsk(p, sid, { tool_name: 'Bash', tool_input: cmd0, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', cmd0, 'toolu_b1')]) });
  const push = { command: 'git push origin main', description: '推送' };
  const no3 = await runAsk(p, sid, { tool_name: 'Bash', tool_input: push, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', push, 'toolu_b2')]) });
  const items = itemsOf(recFile);
  H.ok('确认框到点放行的记成 allow', decision(ok2).behavior === 'allow' && items.some((x) => x.kind === 'allow' && /mvn -q -o test/.test(x.title) && /替你点了允许/.test(x.outcome)), items);
  H.ok('确认框到点没放行的记成 deny，写明为什么', decision(no3).behavior === 'deny' && items.some((x) => x.kind === 'deny' && /git push/.test(x.title) && /推送/.test(x.outcome)), items);
  const dt = H.node(h, path.join(h.kit, 'tools', 'decided.js'), ['--file', recFile, '--id', '1', '--text', '放工具栏', '--why', '改动最小'], { cwd: p });
  H.ok('decided.js 登记它定了什么', dt.code === 0 && (itemsOf(recFile).find((x) => x.id === 1) || {}).chose === '放工具栏', [dt.code, dt.out, dt.err]);
  const bad = H.node(h, path.join(h.kit, 'tools', 'decided.js'), ['--file', recFile, '--id', '99', '--text', 'x'], { cwd: p });
  H.ok('编号不对：退出码 1，说清楚', bad.code === 1 && /没有编号 99/.test(bad.out + bad.err), [bad.code, bad.out, bad.err]);

  H.section('第 94 条：什么时候列给用户');
  H.ok('变更 c1 还没做完：不列', !!AD && AD.takeDue(j) === null, '');
  H.write(path.join(d1, 'tasks.md'), '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n- [x] 1.2 改 src/A.java：加校验\n');
  const due = AD ? AD.takeDue(j) : null;
  const text = due ? due.lines.join('\n') : '';
  H.ok('做完了：一次列出全部三件（它定的、放行的、没放行的）', !!due && due.count === 3 && /它定的：放工具栏。理由：改动最小/.test(text) && /替你点了允许/.test(text) && /推送/.test(text), due);
  H.ok('清单写进 .vibe/reports/替你定的事-*.md', !!due && !!due.file && /替你定的事-/.test(due.file) && /放工具栏/.test(H.read(due.file) || ''), due && due.file);
  H.ok('列过的不再列', !!AD && AD.takeDue(j) === null, '');

  // 大任务：表里的变更都做完才列
  const pt = H.makeRepo(path.join(h.work, 'pt'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n| | c2 | | |\n', 'openspec/explore/订单.md': '# 探索\n\n## 还没定的\n\n## 范围\n\n只改导出\n\n## change: c1\n\n导出\n\n## change: c2\n\n校验\n',
    'openspec/changes/c1/tasks.md': '- [x] 1.1 导出\n', 'openspec/changes/c2/proposal.md': '## Why\n\nx\n', 'openspec/changes/c2/tasks.md': '- [x] 1.1 校验\n- [ ] 1.2 提示\n' });
  const sidT = 's-1120t'; const jT = { session_id: sidT, cwd: pt };
  H.inFlow(h, sidT, [path.join(pt, 'openspec', 'changes', 'c2')], true, 'apply');
  let recT = null; try { recT = AD.record(jT, { kind: 'allow', title: 'Bash：npm test', outcome: '替你点了允许' }); } catch (e) { recT = { err: e.message }; }
  const itT = recT && recT.file ? itemsOf(recT.file)[0] : {};
  H.ok('记的时候认出大任务订单', !!itT && itT.group === 'task' && itT.task === '订单', [recT, itT]);
  H.ok('c2 还有没做的：中间停下不列', !!AD && AD.takeDue(jT) === null, '');
  H.write(path.join(pt, 'openspec', 'changes', 'c2', 'tasks.md'), '- [x] 1.1 校验\n- [x] 1.2 提示\n');
  const dueT = AD ? AD.takeDue(jT) : null;
  H.ok('表里的变更都做完了：列出来，标着大任务订单', !!dueT && dueT.count === 1 && dueT.heads.includes('大任务 订单'), dueT);

  // 收工钩子：不走 OpenSpec 的停下来就列，接在交代里
  const pp = H.makeRepo(path.join(h.work, 'pp'), { 'a.txt': 'x\n', '.gitignore': '.vibe/\n' });
  const sidP = 's-1120p'; const jP = { session_id: sidP, cwd: pp };
  try { AD.record(jP, { kind: 'allow', title: 'Bash：dir', outcome: '替你点了允许' }); } catch (e) { /* 下面看得出来 */ }
  const stopIn = () => ({ session_id: sidP, cwd: pp, hook_event_name: 'Stop', transcript_path: tp([H.tr.user('看看目录'), H.tr.say('看完了')]), stop_hook_active: false, last_assistant_message: '看完了' });
  const st1 = H.hook(h, 'verify-gate', stopIn());
  const why1 = H.reasonOf(st1);
  H.ok('收工钩子把替你定的事交给它照抄进交代', /替你定的事/.test(why1) && /Bash：dir/.test(why1) && /原样放进最后的交代/.test(why1), st1);
  const st2 = H.hook(h, 'verify-gate', stopIn());
  H.ok('下一次收工不再交', !/替你定的事/.test(H.reasonOf(st2)), st2);

  // 全自动报告以前漏了 decision 这一类
  const jx = { session_id: 's-1120x', cwd: p };
  Rp.begin(jx);
  Rp.note(jx, { kind: 'decision', title: '开工那一问没人答，到点替你开工了：c9', detail: '等了 10 分钟' });
  const rep = Rp.build(jx, S.readConfig(jx), []);
  H.ok('全自动报告"它自己定的事"列出到点开工的那一件', /它自己定的事[\s\S]*开工那一问没人答，到点替你开工了：c9/.test(rep.text) && rep.counts.decisions >= 1, rep.text.slice(0, 1600));

  H.section('第 93 条：第一次审代码多一个"复用和简化"角度');
  const pr = H.makeRepo(path.join(h.work, 'pr'), { 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/duty/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const dr = path.join(pr, 'openspec', 'changes', 'c1');
  H.write(path.join(dr, 'proposal.md'), '# 值班\n\n## Why\n\n要调整值班。\n');
  H.write(path.join(dr, 'design.md'), '# 设计\n\n- 改值班的服务\n\n## 验收用例\n\n- AC-01 调整：人工\n');
  H.write(path.join(dr, 'tasks.md'), '## 1. x\n\n- [x] 1.1 做完：src/duty/A.java\n- [x] 1.2 做完：src/duty/A.java\n');
  H.write(path.join(dr, 'specs', 'duty', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 调整值班\n\nThe system SHALL adjust duty.\n\n#### Scenario: 调整\n\n- **WHEN** 点调整\n- **THEN** 值班表更新\n');
  const jr = { session_id: 's-1120r', cwd: pr, transcript_path: tp([H.tr.user('接着做')]) };
  S.setFlow(jr, true, '测试', 'apply'); S.flowTouch(jr, dr);
  try { require(path.join(h.kit, 'lib', 'apply-scope.js')).grant(jr, '开工 c1', '', {}); } catch (e) { /* 开工不了下面看得出来 */ }
  const fileA = path.join(pr, 'src', 'duty', 'A.java');
  const edit = (text) => { H.write(fileA, text); H.hook(h, 'after-tool', Object.assign({}, jr, { tool_name: 'Write', tool_input: { file_path: fileA, content: text }, tool_response: { filePath: fileA }, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_w' + (++seq) })); };
  edit('class A { int x; int y; }\n');
  let pc = null; try { pc = R.prepare({ cwd: pr, change: 'c1', mode: 'code', point: 'change' }); } catch (e) { pc = { status: 'threw', reason: e.message }; }
  const lensNames = (pc && pc.lenses) || [];
  H.ok('任务都做完、第一次审代码：多了"复用和简化"', pc && pc.status === 'prepared' && lensNames.includes('复用和简化'), pc);
  const cleanScope = pc && pc.pending ? (pc.pending.find((x) => x.lens === '复用和简化') || {}).scope : '';
  H.ok('这个角度的要求写了四件事、例外、一律 P3', /复用/.test(H.read(cleanScope) || '') && /抽象层次/.test(H.read(cleanScope) || '') && /一律写 P3/.test(H.read(cleanScope) || ''), cleanScope);
  const answer = (issues) => '```json\n' + JSON.stringify({ issues, need: [], summary: '看了' }) + '\n```';
  let res = null;
  if (pc && pc.pending) for (const a of pc.pending) res = R.submit(pc.id, a.lens, a.lens === '复用和简化' ? answer([{ severity: 'P2', file: 'src/duty/A.java', line: 1, problem: 'y 写了没用上', evidence: 'A.java 第 1 行的 y 没有地方读', fix: '删掉 y', kind: '其他', scope: 'in' }]) : answer([]));
  const cleanIssue = res && res.issues ? res.issues.find((x) => /y 写了没用上/.test(x.problem)) : null;
  H.ok('清理建议被改成 P3、kind 清理，不挡通过', !!cleanIssue && cleanIssue.severity === 'P3' && cleanIssue.kind === '清理' && res.status === 'completed' && !res.blocking, res);
  H.ok('下一步说清：改不改它定，改了要先登记再复审', /复用和简化/.test(String((res && res.next) || '')) && /复审/.test(String((res && res.next) || '')), res && res.next);
  // 改了清理建议：要复审
  edit('class A { int x; }\n');
  try { require(path.join(h.kit, 'lib', 'evidence.js')).recordTool({ tool_name: 'Bash', cwd: pr, session_id: jr.session_id, tool_use_id: 'toolu_t1', tool_input: { command: 'mvn -q -o test' }, tool_response: { stdout: 'BUILD SUCCESS' } }, true); } catch (e) { /* 记不了，下面 resolve 会报 */ }
  const decFile = path.join(h.root, 'dec-clean.json');
  H.write(decFile, JSON.stringify({ findings: [{ id: cleanIssue ? cleanIssue.id : 'r1', action: 'fixed', reason: '删掉了没用的 y，测试通过' }] }));
  let rv = null; try { rv = R.resolve({ cwd: pr, change: 'c1', mode: 'code', point: 'change', decisions: decFile }); } catch (e) { rv = { status: 'threw', reason: e.message }; }
  H.ok('清理建议登记修了：要复审（平常 P3 修了不复审）', rv && rv.status === 'needs_review', rv);
  let pc2 = null; try { pc2 = R.prepare({ cwd: pr, change: 'c1', mode: 'code', point: 'change' }); } catch (e) { pc2 = { status: 'threw', reason: e.message }; }
  H.ok('复审那一轮不再加"复用和简化"', pc2 && !((pc2.lenses || []).includes('复用和简化')), pc2);
  // 不走 OpenSpec 的改动不加
  const pn = H.makeRepo(path.join(h.work, 'pn'), { 'pom.xml': '<project/>\n', 'src/B.java': 'class B {}\n', '.gitignore': '.vibe/\n' });
  const baseN = H.git(pn, ['rev-parse', 'HEAD']).out.trim();
  H.write(path.join(pn, 'src', 'B.java'), 'class B { int z; }\n');
  let pc3 = null; try { pc3 = R.prepare({ cwd: pn, mode: 'code', base: baseN }); } catch (e) { pc3 = { status: 'threw', reason: e.message }; }
  H.ok('不走 OpenSpec 的代码审查不加这个角度', pc3 && pc3.status === 'prepared' && !(pc3.lenses || []).includes('复用和简化'), pc3);

  H.section('第 92 条：写第一个提案前，探索记录先过一轮多角度讨论');
  const px = H.makeRepo(path.join(h.work, 'px'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n', 'src/Goods.java': 'class Goods { boolean disabled; }\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n', 'openspec/explore/订单.md': '# 探索\n\n## 还没定的\n\n无\n\n## 定了的\n\n- 导出商品\n\n## 范围\n\n只改导出，用到 Goods\n\n## change: c1\n\n导出接口\n' });
  const ex = path.join(px, 'openspec', 'explore', '订单.md');
  const task = B.tasks(px).find((t) => t.name === '订单');
  const gate = EP ? EP.gateIssue(task, { name: 'c1' }) : '';
  H.ok('还没讨论过：新建 c1 的提案拦下，给了命令', /多角度讨论/.test(gate) && /run --mode explore --task 订单/.test(gate), gate);
  const sidX = 's-1120px'; H.inFlow(h, sidX, [], true, 'plan');
  const pro = path.join(px, 'openspec', 'changes', 'c1', 'proposal.md');
  const pe1 = H.hook(h, 'pre-edit', { session_id: sidX, cwd: px, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: pro, content: '## Why\n\n要导出。\n\n## What Changes\n\n- 导出\n' } });
  H.ok('写提案的钩子拦下，说要先讨论', /多角度讨论/.test(H.reasonOf(pe1)), pe1);
  const runX = () => H.node(h, path.join(h.kit, 'tools', 'review.js'), ['run', '--mode', 'explore', '--task', '订单', '--project', px], { cwd: px, timeout: 180000, env: { VIBE_KIT_CLAUDE_EXE: fake.cmd } });
  const jsonOf = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { return { status: 'bad', raw: r.out + r.err }; } };
  const x1 = jsonOf(runX());
  const calls = fake.calls();
  H.ok('三个角度各一个 claude -p（不带工具）', ['用户和业务', '现有代码', '反方'].every((l) => calls.some((c) => c.lens === l && c.tools)), calls);
  const after = H.read(ex) || '';
  const open = (B.exploreSections(ex) || {})['还没定的'] || '';
  H.ok('讨论完：重复的去掉，2 条写进"还没定的"，标着角度；原来的"无"换掉', x1.status === 'completed' && x1.added === 2 && (open.match(/多角度讨论：/g) || []).length === 2 && /停用的商品/.test(open) && /改不改列表/.test(open) && !/^无$/m.test(open), [x1, open]);
  H.ok('别的几节没动', /## 定了的\n\n- 导出商品/.test(after) && /## change: c1\n\n导出接口/.test(after), after);
  H.ok('记成讨论过（大任务的 panel）', !!(B.taskState(task).panel || {}).at, B.taskState(task));
  H.ok('"还没定的"有内容：照旧先挡（问用户）', B.exploreOpen(task) && B.exploreIssues(task, 'c1').some((s) => /还没定的/.test(s)), B.exploreIssues(task, 'c1'));
  // 问在探索阶段：等探索那一项
  const rX = await runAsk(px, sidX, { tool_name: 'Bash', tool_input: cmd0, transcript_path: tp([H.tr.user('探索'), H.tr.call('Bash', cmd0, 'toolu_x0')]) }, slow);
  H.ok('讨论出问题、回到探索：按探索那一项等', rX.ms >= 3000, rX.ms);
  H.write(ex, after.replace(/## 还没定的[\s\S]*?(?=## 定了的)/, '## 还没定的\n\n无\n\n'));
  H.ok('问完清空了：不再拦（讨论过一轮就够）', EP && EP.gateIssue(B.tasks(px).find((t) => t.name === '订单'), { name: 'c1' }) === '', '');
  const x2 = jsonOf(runX());
  H.ok('再跑一次：说讨论过了，不再调模型', x2.status === 'completed' && x2.already === true && fake.calls().length === calls.length, [x2, fake.calls().length]);
  // 解析
  let parsed = null; try { parsed = EP.parse('想了想\n```json\n{"items":[{"question":"要不要分页？","why":"数据多"}],"summary":"看了"}\n```'); } catch (e) { parsed = { err: e.message }; }
  H.ok('解析回复：取最后的 JSON，kind 缺省按 ask', parsed && parsed.items && parsed.items[0].kind === 'ask' && parsed.items[0].question === '要不要分页？', parsed);
  let threw = ''; try { EP.parse('只想没答'); } catch (e) { threw = e.message; }
  H.ok('回复里没有 JSON：报错（后台会重试一次）', /JSON/.test(threw), threw);
  // 升级前就在做的大任务：别的 change 已经写了提案，不半路补
  const pu = H.makeRepo(path.join(h.work, 'pu'), { '.gitignore': '.vibe/\n', 'openspec/plan.md': '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | c1 | | |\n| | c2 | | |\n', 'openspec/explore/订单.md': '# 探索\n\n## 还没定的\n\n## 范围\n\nx\n\n## change: c1\n\na\n\n## change: c2\n\nb\n', 'openspec/changes/c1/proposal.md': '## Why\n\nx\n', 'openspec/changes/c1/tasks.md': '- [x] 1.1 a\n' });
  H.ok('别的 change 已经写了提案：不拦', EP && EP.gateIssue(B.tasks(pu).find((t) => t.name === '订单'), { name: 'c2' }) === '', '');

  const wins = await watch.stop();
  H.ok('桌面上没有冒出窗口', !wins.length, wins);
  H.done('问题表第 92—94 条');
})().catch((e) => { H.ok('出错', false, e.stack); H.done('问题表第 92—94 条'); });
