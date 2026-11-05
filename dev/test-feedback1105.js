'use strict';
/*
 * 问题表第 59—63 条（仓库主人 2026-11-05 让修）：审查子代理没跑完不重开、/vk-resume 没归档都能切、change 的补录和归属、审查默认 Sonnet。
 * 用法：node dev/test-feedback1105.js [旧套件目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const FROM = process.argv[2];
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false, commitMode: 'off', pullBeforeWork: false, outputGate: false, reviewLenses: 3 };
const blocked = (r) => !!r && /"permissionDecision":"deny"|"decision":"block"/.test(JSON.stringify(r));
const PLAN_HEAD = '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n';
let seq = 0;
const tf = (h, entries) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), entries);
function change(p, name, done, todo, extra) {
  const d = path.join(p, 'openspec/changes', name);
  H.write(path.join(d, 'proposal.md'), '## Why\n\n' + ((extra && extra.proposal) || name) + '\n');
  if (done + todo) H.write(path.join(d, 'tasks.md'), '## 1. 实现\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 改 ' + ((extra && extra.file) || 'a.js') + '：实现\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 改 ' + ((extra && extra.file) || 'a.js') + '：实现\n').join(''));
  return d;
}
function archived(p, name, file) {
  const d = path.join(p, 'openspec/changes/archive', '2026-10-01-' + name);
  H.write(path.join(d, 'proposal.md'), '## Why\n\n' + name + '\n');
  H.write(path.join(d, 'tasks.md'), '- [x] 1.1 改 ' + file + '：实现\n');
}

(async () => {
  const watch = await H.watchWindows('fb1105-win');

  H.section('第 59 条：审查子代理没跑完不重开');
  {
    const h = H.makeHome('fb1105-59', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const R = require(path.join(h.kit, 'lib/review-runner'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const d = change(p, 'c1', 0, 1);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']);
    const sid = 's59'; const opts = { cwd: p, change: 'c1', mode: 'proposal', point: 'proposal' };
    const r1 = R.prepare(opts);
    H.ok('第一轮开 3 个', r1.status === 'prepared' && r1.agents.length === 3, r1);
    const jobOf = () => Object.values(S.readState('review-jobs')).find((x) => x && x.change === 'c1');
    for (const a of r1.agents) H.ok('占位：' + a.lens, R.claim(r1.id, a.lens, 'tool-' + a.lens, sid) === '');
    // 第 59 条的根因（仓库主人的记录）：这个环境 Agent 的结果不写"Async agent launched"，子代理刚开就被判成结束了
    const launched = r1.agents.flatMap((a) => [H.tr.call('Agent', { subagent_type: 'vk-reviewer', prompt: a.prompt }, 'tool-' + a.lens), H.tr.result('tool-' + a.lens, 'Spawned successfully. (This tool result is internal metadata.)\nagent_id: areviewer-facts-a3462d88\nname: reviewer-facts\nThe agent is now running and will receive instructions via mailbox.')]);
    R.sweep(launched, p);
    H.ok('工具结果写"Spawned successfully"：还算在跑，不判成没交', Object.values(jobOf().state).every((s) => s.status === 'sent'), jobOf().state);
    const longReply = '审查结论：' + '这段话讲的是 the agent launched in the background 这类词。'.repeat(40);
    {
      // 单独一个假目录：上面的 3 个还占着位子
      const h2 = H.makeHome('fb1105-fg', FROM, QUIET);
      const S2 = require(path.join(h2.kit, 'lib/session')); const R2 = require(path.join(h2.kit, 'lib/review-runner'));
      const q = H.makeRepo(path.join(h2.work, 'q'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
      change(q, 'c1', 0, 1);
      H.git(q, ['add', '-A']); H.git(q, ['commit', '-qm', 'x']);
      const fg = R2.prepare({ cwd: q, change: 'c1', mode: 'proposal', point: 'proposal' });
      const lens = (fg.agents || [{}])[0].lens;
      if (lens) { R2.claim(fg.id, lens, 'fg-long', 's-fg'); R2.sweep([H.tr.call('Agent', { subagent_type: 'vk-reviewer' }, 'fg-long'), H.tr.result('fg-long', longReply)], q); }
      const row = Object.values(S2.readState('review-jobs')).find((x) => x && x.id === fg.id);
      H.ok('前台子代理的长回复碰巧带这些词：算结束了', !!lens && row.state[lens].status === 'failed', row && row.state);
    }
    H.write(path.join(d, 'proposal.md'), '## Why\n\n改过了\n');
    const r2 = R.prepare(opts);
    H.ok('文档改过、上一轮的子代理还活着：不开新的一轮', r2.status === 'running' && !(r2.agents || []).length && /不开新的一轮/.test(r2.next || ''), r2);
    H.ok('上一轮没被盖掉', jobOf().id === r1.id);
    const r3 = R.prepare(Object.assign({}, opts, { point: 'proposal', full: true }));
    H.ok('--full 也不开', r3.status === 'running', r3);
    // 跑了一个小时：发出去早就过了半小时，最后一次跑命令是刚才
    const old = Date.now() - 3600000;
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === r1.id) for (const l of Object.keys(o[k].state)) o[k].state[l].sentAt = old; });
    H.hook(h, 'guard-commit', { session_id: sid, cwd: p, agent_type: 'vk-reviewer', agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, transcript_path: tf(h, [H.tr.user('审一下')]) });
    R.sweep([], p);
    H.ok('跑了一小时、刚才还在跑命令：不算没交', Object.values(jobOf().state).every((s) => s.status === 'sent'), jobOf().state);
    H.ok('这时候还是不开新的一轮', R.prepare(opts).status === 'running');
    const r4 = R.prepare(Object.assign({}, opts, { point: 'proposal', mode: 'proposal' }));
    H.ok('同样的请求再问一次：说清楚在跑', /在跑/.test(r4.next || ''), r4);
    // 同一个项目里别的审查点也算：最多 3 个
    const d2 = change(p, 'c2', 0, 1);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案 2']);
    const r5 = R.prepare({ cwd: p, change: 'c2', mode: 'proposal', point: 'proposal' });
    H.ok('跑了一小时的也数：第 4 个不让开', /已经有 3 个审查子代理在跑/.test(r5.agents ? R.claim(r5.id, r5.agents[0].lens, 't5', sid) : ''), r5.agents);
    void d2;
    // 真死了：半小时没动静
    S.writeState(sid + '-review-alive', { at: old });
    R.sweep([], p);
    H.ok('半小时没动静：算没交', Object.values(jobOf().state).every((s) => s.status === 'failed'), jobOf().state);
    const r6 = R.prepare(opts);
    H.ok('都没了才开新的一轮', r6.status === 'prepared' && r6.id !== r1.id && r6.agents.length === 3, r6);
    // 主会话的钩子不算子代理的动静
    S.writeState(sid + '-review-alive', {});
    H.hook(h, 'guard-commit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, transcript_path: tf(h, [H.tr.user('审一下')]) });
    H.ok('主会话跑命令不算子代理活着', !S.readState(sid + '-review-alive').at);
    H.hook(h, 'guard-read', { session_id: sid, cwd: p, agent_type: 'vk-reviewer', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, transcript_path: tf(h, [H.tr.user('审一下')]) });
    H.ok('子代理搜文件算动静', !!S.readState(sid + '-review-alive').at);
    // 前台子代理结束了、没交结论，还记着在跑：备审查的钩子先清掉，不让它等一个不会来的通知（复审 20261105-2 第 1 条）
    const r7 = R.prepare({ cwd: p, change: 'c1', mode: 'proposal', point: 'proposal', full: true });
    const lens7 = (r7.agents || [{}])[0].lens;
    if (lens7) for (const a of r7.agents) R.claim(r7.id, a.lens, 'fg-' + a.lens, sid);
    H.write(path.join(d, 'proposal.md'), '## Why\n\n又改了\n');
    H.ok('前提：这时候说在跑', R.prepare(opts).status === 'running');
    const fg = (r7.agents || []).flatMap((a) => [H.tr.call('Agent', { subagent_type: 'vk-reviewer', prompt: a.prompt }, 'fg-' + a.lens), H.tr.result('fg-' + a.lens, '子代理回来了，没交结论')]);
    H.hook(h, 'guard-commit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'p7', tool_input: { command: 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" prepare --change c1 --mode proposal --point proposal --project "' + p.replace(/\\/g, '/') + '"' }, transcript_path: tf(h, [H.tr.user('审一下')].concat(fg)) });
    H.ok('子代理其实结束了：备审查之前清掉，开得了新的一轮', R.prepare(opts).status === 'prepared', R.prepare(opts));
    const auto = H.read(path.join(h.kit, 'hooks/task-anchor.js'));
    H.ok('开关自动的提示说不重开', /不要重开/.test(auto));
  }

  H.section('第 60 条：/vk-resume 只要没归档都能切');
  {
    const h = H.makeHome('fb1105-60', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const B = require(path.join(h.kit, 'lib/big-task'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n' + PLAN_HEAD + '| | c1 | | |\n| | c2 | | |\n| | c3 | | |\n| | c9 | 已归档 2026-10-01 | |\n');
    change(p, 'c1', 1, 1); const c2 = change(p, 'c2', 2, 0); change(p, 'c3', 0, 1);
    H.write(path.join(p, 'openspec/changes/archive/2026-10-01-c9/proposal.md'), '# x\n');
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']);
    const j = { cwd: p, session_id: 's60' };
    const resume = (name) => H.hook(h, 'task-anchor', { session_id: 's60', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '/vk-resume ' + name, transcript_path: tf(h, [H.tr.user('/vk-resume ' + name)]) }, { spawn: true });
    const r = resume('c2');
    const said = JSON.stringify(r);
    H.ok('任务都勾完、没归档：切得过去', S.flowState(j).current === 'c2' && !/没切/.test(said), said.slice(0, 300));
    H.ok('说清楚等你说下一步，不接着做', /等用户说要做什么/.test(said), said.slice(0, 400));
    H.ok('算在做它，不回表的顺序', B.phaseFor(j, B.tasks(p)[0]).change === 'c2', B.phaseFor(j, B.tasks(p)[0]));
    H.ok('进了做任务那一段，能改代码', S.flowStage(j) === 'apply');
    const bar = B.bar(j) || {};
    H.ok('状态栏显示它、等你说', /c2/.test(bar.steps || '') && /等你说下一步/.test(bar.next || ''), bar);
    const stop = () => H.reasonOf(H.hook(h, 'verify-gate', { session_id: 's60', cwd: p, hook_event_name: 'Stop', transcript_path: tf(h, [H.tr.user('看看')]) }));
    const st1 = stop();
    H.ok('收工不催接下一个、全面自测', !/接着做|全面自测/.test(st1), st1);
    H.ok('收工之后还在它上面', S.flowState(j).current === 'c2', S.flowState(j));
    H.write(path.join(c2, 'tasks.md'), H.read(path.join(c2, 'tasks.md')) + '- [ ] 1.3 改 a.js：补一处\n');
    stop();
    H.ok('又补了任务：按普通的算', S.flowState(j).current === 'c2' && !S.flowState(j).keepCurrent, S.flowState(j));
    H.write(path.join(c2, 'tasks.md'), H.read(path.join(c2, 'tasks.md')).replace('- [ ] 1.3', '- [x] 1.3'));
    H.ok('补的做完了：回到表的顺序', B.phaseFor(j, B.tasks(p)[0]).change === 'c1', B.phaseFor(j, B.tasks(p)[0]));
    const r2 = resume('c9');
    H.ok('已归档的：不切，说清楚', /c9/.test(JSON.stringify(r2)) && /归档/.test(JSON.stringify(r2)));
    // 表外的
    const p2 = H.makeRepo(path.join(h.work, 'p2'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    change(p2, 'solo', 1, 0);
    H.git(p2, ['add', '-A']); H.git(p2, ['commit', '-qm', 'docs: 提案']);
    const j2 = { cwd: p2, session_id: 's60b' };
    const r3 = H.hook(h, 'task-anchor', { session_id: 's60b', cwd: p2, hook_event_name: 'UserPromptSubmit', prompt: '/vk-resume solo', transcript_path: tf(h, [H.tr.user('/vk-resume solo')]) }, { spawn: true });
    H.ok('表外的、任务都勾完：切得过去', S.flowState(j2).current === 'solo' && !/没切/.test(JSON.stringify(r3)), JSON.stringify(r3).slice(0, 300));
    H.ok('切过去之后还算当前', B.currentAlive(j2));
    // 开工点名别的 change：保留标记跟着清（复审 20261105-2 第 6 条）
    change(p2, 'other-one', 0, 1);
    require(path.join(h.kit, 'lib/apply-scope')).grant(j2, 'other-one', '');
    H.ok('切走了：保留标记清掉', S.flowState(j2).current === 'other-one' && !S.flowState(j2).keepCurrent, S.flowState(j2));
  }

  H.section('第 61 条：流程改版前的几个 change 找出来问，确认了才写');
  {
    const h = H.makeHome('fb1105-61', FROM, QUIET);
    const Link = (() => { try { return require(path.join(h.kit, 'lib/plan-link')); } catch (e) { return null; } })();
    H.ok('有 lib/plan-link.js', !!Link);
    const S = require(path.join(h.kit, 'lib/session'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'pom.xml': '<p/>\n', 'src/Order.java': 'class Order {}\n', 'src/Pay.java': 'class Pay {}\n' });
    change(p, 'order-export-api', 1, 1, { file: 'src/Order.java' });
    change(p, 'order-export-ui', 0, 1, { file: 'src/Ui.java' });
    change(p, 'pay-fix', 0, 1, { file: 'src/Pay.java' });
    change(p, 'mention-a', 0, 1, { file: 'src/A1.java', proposal: '接着 other-thing 做' });
    change(p, 'other-thing', 0, 1, { file: 'src/B1.java' });
    change(p, 'file-a', 0, 1, { file: 'src/Shared.java' });
    change(p, 'zzz-b', 0, 1, { file: 'src/Shared.java' });
    change(p, 'common-a', 0, 1, { file: 'pom.xml' });
    change(p, 'qqq-b', 0, 1, { file: 'pom.xml' });
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 提案']);
    const os = path.join(p, 'openspec');
    const groups = Link ? Link.orphanGroups(os) : [];
    const has = (a, b) => groups.some((g) => g.changes.includes(a) && g.changes.includes(b));
    H.ok('名字前缀相同的算一组', has('order-export-api', 'order-export-ui'), groups);
    H.ok('文档提到的算一组', has('mention-a', 'other-thing'), groups);
    H.ok('改同一个文件的算一组', has('file-a', 'zzz-b'), groups);
    H.ok('没线索的不算', !groups.some((g) => g.changes.includes('pay-fix')), groups);
    H.ok('都改 pom.xml 不算线索', !has('common-a', 'qqq-b'), groups);
    // 三个以上都改的文件是热点，不算线索（复审 20261105-2 第 4 条）
    change(p, 'hot-a', 0, 1, { file: 'src/Routes.java' }); change(p, 'warm-b', 0, 1, { file: 'src/Routes.java' }); change(p, 'cool-c', 0, 1, { file: 'src/Routes.java' });
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: 又几个']);
    H.ok('三个 change 都改同一个文件：不算线索', Link ? !Link.orphanGroups(os).some((g) => g.changes.includes('hot-a')) : false);
    H.ok('线索写清楚', groups.every((g) => g.why.length > 0), groups);
    const start = () => JSON.stringify(H.hook(h, 'session-start', { session_id: 's61', cwd: p, hook_event_name: 'SessionStart', source: 'startup' }, { spawn: true }));
    const first = start();
    H.ok('会话开始：提示问用户，还没写 plan.md', /可能是一件事/.test(first) && /提问框/.test(first) && !fs.existsSync(path.join(os, 'plan.md')), first.slice(0, 500));
    H.ok('问过的不再问', !/可能是一件事/.test(start()));
    // 自动模式不问，也不记成问过（复审 20261105-2 第 3 条）
    const p2 = H.makeRepo(path.join(h.work, 'p2'), { '.gitignore': '.vibe/\n' });
    change(p2, 'pay-export-api', 0, 1); change(p2, 'pay-export-ui', 0, 1);
    const startIn = (sid) => JSON.stringify(H.hook(h, 'session-start', { session_id: sid, cwd: p2, hook_event_name: 'SessionStart', source: 'startup' }, { spawn: true }));
    S.setSessionAuto({ cwd: p2, session_id: 's61a' }, true, '测试');
    H.ok('开着自动的会话：不提示', !/可能是一件事/.test(startIn('s61a')));
    H.ok('关了自动的会话：还会问', /可能是一件事/.test(startIn('s61b')));
    const run = (args) => H.node(h, path.join(h.kit, 'tools/plan.js'), args, { cwd: p });
    const rel = run(['related', '--project', p]);
    H.ok('plan.js related 列得出来', /order-export-api/.test(rel.out), rel);
    const l1 = run(['link', '--task', '订单导出', '--changes', 'order-export-api,order-export-ui', '--project', p]);
    const plan = H.read(path.join(os, 'plan.md')) || '';
    H.ok('plan.js link：没有 plan.md 也建得出来，两个都在一节里', /## 订单导出/.test(plan) && /\|\s*\|\s*order-export-api\s*\|/.test(plan) && /\|\s*\|\s*order-export-ui\s*\|/.test(plan), [l1, plan]);
    H.ok('不建探索记录：算老任务', !/探索记录/.test(plan) && !fs.existsSync(path.join(os, 'explore', '订单导出.md')));
    const B = require(path.join(h.kit, 'lib/big-task'));
    const task = B.tasks(p).find((t) => t.name === '订单导出');
    H.ok('大任务认得出，老任务', !!task && task.legacy && task.changes.length === 2, task);
    H.ok('状态列填好了', /进行中 1\/2/.test(plan), plan);
    const l2 = run(['link', '--task', '别的', '--changes', 'order-export-api,no-such', '--project', p]);
    const plan2 = H.read(path.join(os, 'plan.md'));
    H.ok('已经在别的大任务里的不动，没有的不加', !/## 别的/.test(plan2) && /已经在大任务 订单导出 里/.test(l2.out) && /没有这个 change/.test(l2.out), [l2, plan2]);
    void S;
  }

  H.section('第 62 条：没有在做的大任务时开的新 change，问归到哪');
  {
    const h = H.makeHome('fb1105-62', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session'));
    const mk = (name) => {
      const p = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n', 'pom.xml': '<p/>\n', 'src/Order.java': 'class Order {}\n' });
      archived(p, 'old-order', 'src/Order.java'); archived(p, 'old-pay', 'src/Pay.java');
      H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n' + PLAN_HEAD + '| | old-order | 已归档 2026-10-01 | |\n\n## 支付\n\n' + PLAN_HEAD + '| | old-pay | 已归档 2026-10-01 | |\n');
      return p;
    };
    const stop1 = (p, sid, name) => H.hook(h, 'verify-gate', { session_id: sid, cwd: p, hook_event_name: 'Stop', transcript_path: tf(h, [H.tr.user('开个新的'), H.tr.ran('Write', { file_path: path.join(p, 'openspec/changes', name, 'proposal.md'), content: 'x' }, 'ok')]) });
    // 写完文档先问审不审，那一问过了才问归到哪：不和别的事挤在一起
    const stop = (p, sid, name) => { let o = stop1(p, sid, name); for (let i = 0; i < 4 && /四份需求文档写完了|写下一份/.test(H.reasonOf(o)); i++) o = stop1(p, sid, name); return o; };
    const p1 = mk('p1');
    change(p1, 'order-fix', 0, 1, { file: 'src/Order.java' });
    const o1 = stop(p1, 's62', 'order-fix');
    const plan1 = H.read(path.join(p1, 'openspec/plan.md'));
    H.ok('全部归档后开的新 change：不自动并进最后一个', !/order-fix/.test(plan1), plan1);
    const said = H.reasonOf(o1);
    H.ok('问归到哪：列出相关的旧大任务和线索', blocked(o1) && /归到 订单/.test(said) && /都改 src\/order\.java/i.test(said) && /新开大任务/.test(said) && /不归/.test(said), said);
    H.ok('不相关的大任务不列', !/归到 支付/.test(said), said);
    H.ok('提示里给了 link 命令和来源', /plan\.js" link --task/.test(said) && /来源：old-order/.test(said), said);
    H.ok('只问一次', !/归到 订单/.test(H.reasonOf(stop(p1, 's62', 'order-fix'))));
    const run = H.node(h, path.join(h.kit, 'tools/plan.js'), ['link', '--task', '订单', '--changes', 'order-fix', '--note', '来源：old-order', '--project', p1], { cwd: p1 });
    const plan2 = H.read(path.join(p1, 'openspec/plan.md'));
    H.ok('用户选了归到旧大任务：进那一节的表，说明列写来源', /old-order[^\n]*\n\|\s*\|\s*order-fix\s*\|[^|]*\|\s*来源：old-order\s*\|/.test(plan2), [run, plan2]);
    H.ok('别的行没动', /\|\s*\|\s*old-pay\s*\|\s*已归档 2026-10-01/.test(plan2));
    change(p1, 'note-x', 0, 1, { file: 'src/Zzz.java' });
    H.node(h, path.join(h.kit, 'tools/plan.js'), ['link', '--task', '订单', '--changes', 'note-x', '--note', '来源|旧\n第二行', '--project', p1], { cwd: p1 });
    H.ok('说明里的 | 和换行不破坏表格', /\|\s*\|\s*note-x\s*\|[^|\n]*\|\s*来源\/旧 第二行\s*\|/.test(H.read(path.join(p1, 'openspec/plan.md'))), H.read(path.join(p1, 'openspec/plan.md')));
    const p1b = H.makeRepo(path.join(h.work, 'p1b'), { '.gitignore': '.vibe/\n' });
    H.write(path.join(p1b, 'openspec/plan.md'), '# 计划\n\n## 老\n\n| 变更名 | 状态 | 模块 |\n|---|---|---|\n| aaa | 已提案 | 甲 |\n');
    change(p1b, 'aaa', 0, 1); change(p1b, 'bbb', 0, 1);
    H.node(h, path.join(h.kit, 'tools/plan.js'), ['link', '--task', '老', '--changes', 'bbb', '--note', '来源：aaa', '--project', p1b], { cwd: p1b });
    H.ok('老表没有说明列：不往模块列塞', /\|\s*bbb\s*\|[^|\n]*\|\s*\|/.test(H.read(path.join(p1b, 'openspec/plan.md'))) && !/来源：aaa/.test(H.read(path.join(p1b, 'openspec/plan.md'))), H.read(path.join(p1b, 'openspec/plan.md')));
    // 没线索：不问、不进表
    const p2 = mk('p2');
    change(p2, 'brand-new', 0, 1, { file: 'src/Other.java' });
    const o2 = stop(p2, 's62b', 'brand-new');
    H.ok('没线索：不问，不进表', !/归到/.test(H.reasonOf(o2)) && !/brand-new/.test(H.read(path.join(p2, 'openspec/plan.md'))), H.reasonOf(o2));
    // 做到一半：照旧自动补进在做的大任务
    const p3 = H.makeRepo(path.join(h.work, 'p3'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    H.write(path.join(p3, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n' + PLAN_HEAD + '| | doing | | |\n');
    change(p3, 'doing', 1, 1); change(p3, 'mid-new', 0, 1);
    const j3 = { cwd: p3, session_id: 's62c' };
    S.setFlow(j3, true, '开工', 'apply'); S.flowTouch(j3, path.join(p3, 'openspec/changes/doing'));
    stop(p3, 's62c', 'mid-new');
    H.ok('做到一半开的：自动补进在做的大任务，不问', /\|\s*\|\s*mid-new\s*\|/.test(H.read(path.join(p3, 'openspec/plan.md'))), H.read(path.join(p3, 'openspec/plan.md')));
    // 只有一个大任务、全部归档：也不并
    const p4 = H.makeRepo(path.join(h.work, 'p4'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    archived(p4, 'gone', 'a.js');
    H.write(path.join(p4, 'openspec/plan.md'), '# 计划\n\n## 旧\n\n' + PLAN_HEAD + '| | gone | 已归档 2026-10-01 | |\n');
    change(p4, 'after', 0, 1, { file: 'a.js' });
    H.hook(h, 'session-start', { session_id: 's62d', cwd: p4, hook_event_name: 'SessionStart', source: 'startup' }, { spawn: true });
    H.ok('只有一个大任务、全部归档：会话开始也不并', !/after/.test(H.read(path.join(p4, 'openspec/plan.md'))), H.read(path.join(p4, 'openspec/plan.md')));
    const o4 = stop(p4, 's62d', 'after');
    H.ok('它还是会问', /归到 旧/.test(H.reasonOf(o4)), H.reasonOf(o4));
    // 自动模式不问：用户不在
    const p5 = mk('p5');
    change(p5, 'order-auto', 0, 1, { file: 'src/Order.java' });
    H.write(path.join(p5, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    const j5 = { cwd: p5, session_id: 's62e' };
    S.setSessionAuto(j5, true, '测试'); S.setFlow(j5, true, '开工', 'apply');
    const o5 = stop(p5, 's62e', 'order-auto');
    H.ok('自动模式不问归到哪', !/归到 订单/.test(H.reasonOf(o5)), H.reasonOf(o5));
  }

  H.section('第 67 条：开着 vk-auto 写到 tasks 再审，不被拦下看一看');
  {
    const h = H.makeHome('fb1105-67', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy'));
    const DESIGN = '## Context\n\n- 读过 a.js：查询\n- 读过 b.js：入口\n\n## Decisions\n\n- 放 a.js：只有一个接口\n\n## 验收用例\n\n| 编号 | 对应场景 | 前置数据和环境 | 步骤 | 预期 | 谁来测 | 对应任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 空列表 | 没有订单 | 调查询 | 返回空 | Claude：node a.js | 1 |\n';
    const SPEC = '## ADDED Requirements\n\n### Requirement: 查询\n\n系统 SHALL 能查询。\n\n#### Scenario: 空\n\n- **WHEN** 没有订单时查询\n- **THEN** 返回空列表\n';
    const mk = (name) => { const p = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' }); const d = path.join(p, 'openspec/changes/add-a'); H.write(path.join(d, 'proposal.md'), '## Why\n\n要查询。\n\n## What Changes\n\n- 加查询\n'); return { p, d }; };
    const write = (p, d, sid, rel, content) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(d, rel), content }, transcript_path: tf(h, [H.tr.user('写需求')]) });
    const lookAt = /看一看|给我看过/;

    // 表外的 change：没有 plan.md、没有探索记录
    const a = mk('a'); const ja = { cwd: a.p, session_id: 's67a', transcript_path: tf(h, [H.tr.user('写需求')]) };
    S.setSessionAuto(ja, true, '测试'); S.setFlow(ja, true, '需求', 'plan'); S.flowTouch(ja, a.d);
    H.ok('表外的 change、开着自动：算生效', S.readConfigFor(ja).autoMode === true, S.flowView(ja));
    const r1 = write(a.p, a.d, 's67a', 'specs/order/spec.md', SPEC);
    H.ok('写完 proposal 接着写 specs：不拦', !blocked(r1), H.reasonOf(r1));
    const m1 = P.stop(ja, [a.d], false, 't1');
    H.ok('写完 proposal 就停了：催接着写，不说看一看', m1.some((x) => /接着写下一份 specs/.test(x)) && !m1.some((x) => lookAt.test(x)), m1);
    H.write(path.join(a.d, 'specs/order/spec.md'), SPEC); H.write(path.join(a.d, 'design.md'), DESIGN); H.write(path.join(a.d, 'tasks.md'), '## 1. 查询\n\n- [ ] 1.1 改 a.js：加查询\n');
    const m2 = P.stop(ja, [a.d], false, 't2');
    H.ok('写完 tasks：自动审一次整套', m2.some((x) => /--point tasks/.test(x)) && !m2.some((x) => /用 Ask 问要不要审/.test(x)), m2);
    P.noteResult(a.d, 'tasks', { id: 'ok', status: 'completed', issues: [] }, P.fingerprint(a.d, 'tasks'));
    H.ok('整套审过：表外的 change 也接着开工', P.automaticApply(ja) && S.flowStage(ja) === 'apply', S.flowState(ja));
    // 探索记录没写完：说缺什么
    const b = mk('b');
    H.write(path.join(b.p, 'openspec/plan.md'), '# 计划\n\n## 订单\n\n探索记录：explore/订单.md\n\n' + PLAN_HEAD + '| | add-a | | |\n');
    H.write(path.join(b.p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n是否分页\n\n## 范围\n\n只改查询\n');
    const jb = { cwd: b.p, session_id: 's67b', transcript_path: tf(h, [H.tr.user('写需求')]) };
    S.setSessionAuto(jb, true, '测试'); S.setFlow(jb, true, '需求', 'plan'); S.flowTouch(jb, b.d);
    H.ok('探索记录还有没定的：自动不生效', S.readConfigFor(jb).autoMode === false);
    const r2 = write(b.p, b.d, 's67b', 'specs/order/spec.md', SPEC);
    H.ok('探索记录没写完就写下一份：拦下，说缺什么，不说看一看', blocked(r2) && /探索还没完/.test(H.reasonOf(r2)) && /是否分页/.test(H.reasonOf(r2)) && !lookAt.test(H.reasonOf(r2)), H.reasonOf(r2));
    const m3 = P.stop(jb, [b.d], false, 't3');
    H.ok('收工也一样', m3.some((x) => /探索还没完/.test(x)) && !m3.some((x) => lookAt.test(x)), m3);
    H.write(path.join(b.p, 'openspec/explore/订单.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    H.ok('探索记录写完了：生效', S.readConfigFor(jb).autoMode === true);
    H.ok('接着写 specs：不拦', !blocked(write(b.p, b.d, 's67b', 'specs/order/spec.md', SPEC)));
    // 老任务
    const c = mk('c');
    H.write(path.join(c.p, 'openspec/plan.md'), '# 计划\n\n## 老\n\n' + PLAN_HEAD + '| | add-a | | |\n');
    const jc = { cwd: c.p, session_id: 's67c', transcript_path: tf(h, [H.tr.user('写需求')]) };
    S.setSessionAuto(jc, true, '测试'); S.setFlow(jc, true, '需求', 'plan'); S.flowTouch(jc, c.d);
    H.ok('老任务、开着自动：算生效', S.readConfigFor(jc).autoMode === true);
    // 没开自动：照旧
    const e = mk('e'); const je = { cwd: e.p, session_id: 's67e', transcript_path: tf(h, [H.tr.user('写需求')]) };
    S.setFlow(je, true, '需求', 'plan'); S.flowTouch(je, e.d);
    H.ok('没开自动：写完 proposal 提醒看一看', P.stop(je, [e.d], false, 't4').some((x) => /提醒用户看一看/.test(x)));
    const r3 = write(e.p, e.d, 's67e', 'specs/order/spec.md', SPEC);
    H.ok('没开自动：用户没看就写下一份，拦下', blocked(r3) && /写完还没给我看过/.test(H.reasonOf(r3)), H.reasonOf(r3));
  }

  H.section('第 68 条：探索完开的 vk-auto，写完四份不问要不要审');
  {
    const h = H.makeHome('fb1105-68', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const B = require(path.join(h.kit, 'lib/big-task'));
    const mk = (name, explore, sid) => {
      const p = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
      const d = path.join(p, 'openspec/changes/add-a');
      H.write(path.join(d, 'proposal.md'), '## Why\n\nx\n'); H.write(path.join(d, 'tasks.md'), '- [ ] 1.1 改 a.js：加查询\n');
      H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 值班模块\n\n探索记录：explore/值班模块.md\n\n' + PLAN_HEAD + '| | add-a | | |\n');
      H.write(path.join(p, 'openspec/explore/值班模块.md'), explore);
      const j = { cwd: p, session_id: sid, transcript_path: tf(h, [H.tr.user('写需求')]) };
      S.setSessionAuto(j, true, '测试'); S.setFlow(j, true, '需求', 'plan'); S.flowTouch(j, d);
      return { p, d, j };
    };
    const OK = '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n';
    for (const [i, text] of ['（无）', '无（都定了）', '已全部确认。', '无。'].entries()) {
      const { j } = mk('w' + i, '# 探索\n\n## 还没定的\n\n' + text + '\n\n## 范围\n\n只改查询\n', 's68w' + i);
      H.ok('还没定的写成"' + text + '"：算写完了，生效', S.readConfigFor(j).autoMode === true, S.flowView(j));
    }
    const open = mk('o1', '# 探索\n\n## 还没定的\n\n无法确定分页\n\n## 范围\n\n只改查询\n', 's68o');
    H.ok('"无法确定分页"：真没定，不生效', S.readConfigFor(open.j).autoMode === false);
    H.ok('这时候查得到原因', B.exploreIssues ? B.exploreIssues(B.tasks(open.p)[0]).length === 1 : false);
    const paren = mk('b1', '# 探索\n\n## 还没定的\n\n（分页方式待定）\n\n## 范围\n\n只改查询\n', 's68b');
    H.ok('括号里写的真问题：不算空，不生效', S.readConfigFor(paren.j).autoMode === false);
    const gone = mk('g1', OK, 's68g'); fs.rmSync(path.join(gone.p, 'openspec/explore/值班模块.md'));
    H.ok('写了探索记录、文件却不在：不生效，不开工', S.readConfigFor(gone.j).autoMode === false && !require(path.join(h.kit, 'lib/flow-policy')).automaticApply(gone.j), S.flowView(gone.j));
    // 只开 Apply 自动（配置）：写需求这一段照人工
    const cfgOnly = mk('c1', OK, 's68c'); S.setSessionAuto(cfgOnly.j, false, '测试'); H.setConfig(h, { autoApply: true, autoRequirements: false });
    H.ok('只开 Apply 自动：写需求照人工问', require(path.join(h.kit, 'lib/flow-policy')).stop(cfgOnly.j, [cfgOnly.d], false, 't-c').some((x) => /四份需求文档写完了/.test(x)));
    H.setConfig(h, { autoApply: false, autoRequirements: false });
    const noScope = mk('n1', '# 探索\n\n## 还没定的\n\n## 范围\n', 's68n');
    H.ok('已经在写文档、范围没写：开着自动也生效', S.readConfigFor(noScope.j).autoMode === true, S.flowView(noScope.j));
    const review = (x, said) => H.hook(h, 'guard-commit', { session_id: x.j.session_id, cwd: x.p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'r' + (++seq), tool_input: { command: 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" prepare --change add-a --mode proposal --point tasks --project "' + x.p.replace(/\\/g, '/') + '"' }, transcript_path: tf(h, [H.tr.user(said || '写需求')]) });
    const asks = (r) => /用户这一轮没说要审查/.test(H.reasonOf(r));
    const ok = mk('k1', OK, 's68k');
    H.ok('开着自动跑审查：不问', !asks(review(ok)), H.reasonOf(review(ok)));
    H.ok('探索还有没定的：审查也不问（文档写完了就审）', !asks(review(open)), H.reasonOf(review(open)));
    const aside = mk('a1', OK, 's68a'); S.updateState('s68a-flow', (o) => { o.aside = true; });
    H.ok('这一轮被判成插话（aside）：开着自动照样生效，审查不问', S.readConfigFor(aside.j).autoMode === true && !asks(review(aside)), H.reasonOf(review(aside)));
    // 真的一句话：带"文档""写"，以前整轮都按人工算（问题表第 68 条的记录）
    const real = mk('r1', OK, 's68r');
    H.hook(h, 'task-anchor', { session_id: 's68r', cwd: real.p, hook_event_name: 'UserPromptSubmit', prompt: '把这几份文档写完', transcript_path: tf(h, [H.tr.user('把这几份文档写完')]) }, { spawn: true });
    H.ok('用户说"把这几份文档写完"：记成插话，自动照样生效', S.flowState(real.j).aside === true && S.readConfigFor(real.j).autoMode === true, S.flowState(real.j));
    H.ok('这种话过后写完四份、审过，接着开工', (require(path.join(h.kit, 'lib/flow-policy')).noteResult(real.d, 'tasks', { id: 'x', status: 'completed', issues: [] }, require(path.join(h.kit, 'lib/flow-policy')).fingerprint(real.d, 'tasks')), H.write(path.join(real.d, 'specs/order/spec.md'), '## ADDED Requirements\n\n### Requirement: 查询\n\n系统 SHALL 能查询。\n\n#### Scenario: 空\n\n- **WHEN** 没有订单时查询\n- **THEN** 返回空列表\n'), H.write(path.join(real.d, 'design.md'), '## Context\n\n- 读过 a.js\n'), require(path.join(h.kit, 'lib/flow-policy')).noteResult(real.d, 'tasks', { id: 'x', status: 'completed', issues: [] }, require(path.join(h.kit, 'lib/flow-policy')).fingerprint(real.d, 'tasks')), require(path.join(h.kit, 'lib/flow-policy')).automaticApply(real.j)), S.flowState(real.j));
    // 范围没写的大任务：开着自动也开工（只有真没定的才挡）
    H.ok('探索记录范围没写、审过了：接着开工', (H.write(path.join(noScope.d, 'specs/order/spec.md'), '## ADDED Requirements\n\n### Requirement: 查询\n\n系统 SHALL 能查询。\n\n#### Scenario: 空\n\n- **WHEN** 没有订单时查询\n- **THEN** 返回空列表\n'), H.write(path.join(noScope.d, 'design.md'), '## Context\n\n- 读过 a.js\n'), require(path.join(h.kit, 'lib/flow-policy')).noteResult(noScope.d, 'tasks', { id: 'y', status: 'completed', issues: [] }, require(path.join(h.kit, 'lib/flow-policy')).fingerprint(noScope.d, 'tasks')), require(path.join(h.kit, 'lib/flow-policy')).automaticApply(noScope.j)), S.flowState(noScope.j));
    const paused = mk('p1', OK, 's68p'); S.updateState('s68p-flow', (o) => { o.paused = true; });
    H.ok('用户说了停：先问', asks(review(paused)), H.reasonOf(review(paused)));
    const plain = mk('q1', OK, 's68q'); S.setFlow(plain.j, false, '测试');
    H.ok('不在流程里（普通改动）：照人工先问', asks(review(plain)), H.reasonOf(review(plain)));
    const manual = mk('m1', OK, 's68m'); S.setSessionAuto(manual.j, false, '测试');
    H.ok('没开自动：先问', asks(review(manual)), H.reasonOf(review(manual)));
    const said = H.reasonOf(review(manual));
    H.ok('提示里不再提不存在的 workflow.js qualify', !/qualify/.test(said) && !/qualify/.test(H.read(path.join(h.kit, 'lib/flow-policy.js')) || ''), said);
  }

  H.section('第 64—66 条：作废的一轮也留基准、子代理的名字、用量上限');
  {
    const h = H.makeHome('fb1105-65', FROM, QUIET);
    const R = require(path.join(h.kit, 'lib/review-runner'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const d = change(p, 'c1', 0, 1);
    H.write(path.join(d, 'proposal.md'), Array.from({ length: 30 }, (_, i) => '第 ' + i + ' 行').join('\n') + '\n');
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'x']);
    const opts = { cwd: p, change: 'c1', mode: 'proposal', point: 'tasks' };
    const send = (id, lens, out) => R.submit(id, lens, '审查任务：' + id + '/' + lens + '\n```json\n' + JSON.stringify(Object.assign({ issues: [], summary: '' }, out)) + '\n```');
    const r = R.prepare(opts);
    H.ok('第 66 条：整套文档的名字', r.agents.every((a) => /^审查整套文档 /.test(a.description)), r.agents.map((a) => a.description));
    H.ok('第 65 条：提示说回来之前不要改文件', /回来之前不要改文件/.test(r.next), r.next);
    send(r.id, r.agents[0].lens, { issues: [{ severity: 'P2', file: 'proposal.md', line: 1, problem: '范围没写', evidence: '没写不做什么', fix: '补上' }] });
    H.write(path.join(d, 'proposal.md'), H.read(path.join(d, 'proposal.md')) + '第一个回来就改了\n');
    let last; for (const a of r.agents.slice(1)) last = send(r.id, a.lens, {});
    H.ok('第一个回来就改：这一轮作废，提示说只审改过的', last.status === 'stale' && /只审改过的地方/.test(last.next || ''), last);
    const r2 = R.prepare(opts);
    H.ok('第 65 条：第二轮只开 1 个，不是 3 个', r2.status === 'prepared' && r2.agents.length === 1 && r2.scope === 'changes', r2);
    H.ok('第 66 条：复审的名字', /^复审整套文档$/.test((r2.agents[0] || {}).description || ''), r2.agents);
    const scope = H.read(/范围文件：(.+)/.exec(r2.agents[0].prompt)[1].trim());
    H.ok('第二轮带着上一轮的问题', /范围没写/.test(scope), scope.slice(0, 400));
    const p2 = H.makeRepo(path.join(h.work, 'p2'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const d2 = change(p2, 'c1', 1, 0, { file: 'a.js' });
    H.git(p2, ['add', '-A']); H.git(p2, ['commit', '-qm', 'x']);
    R.baseline({ cwd: p2, session_id: 's65' }, [d2]);
    H.write(path.join(p2, 'a.js'), 'let a=2;\n');
    const code = R.prepare({ cwd: p2, change: 'c1', mode: 'code', point: 'change' });
    H.ok('第 66 条：代码的名字', code.agents.every((a) => /^审查代码 /.test(a.description)), code.agents.map((a) => a.description));
    const SRC = FROM || path.join(__dirname, '..', 'vibe-kit');
    const agentText = H.read(path.join(SRC, 'kit/review-prompt.md')) || '';
    H.ok('第 64 条：审查代理不限调用次数，只核对点名的', !/40 次/.test(agentText) && /脚本查的/.test(agentText), agentText.slice(0, 300));
    H.ok('第 70 条：代理说明不再要它别缩小范围，框架不读实现', !/不自己缩小范围/.test(agentText) && /只审这次需求/.test(agentText) && /sa-token/.test(agentText) && /没改的老代码/.test(agentText), agentText.slice(0, 400));
    const Sc = require(path.join(h.kit, 'lib/review-scope'));
    const cfgS = { reviewSmallChars: 40000, reviewLenses: 3 };
    const names = (n) => Sc.lensesFor('code', 1, cfgS, n).map((l) => l.name);
    H.ok('第 64 条：4 万字内 1 个', names(40000).join() === '全量', names(40000));
    H.ok('第 64 条：12 万字内 2 个', names(120000).length === 2, names(120000));
    H.ok('第 64 条：24 万字内 3 个', names(240000).length === 3, names(240000));
    H.ok('第 64 条：再大 2 个', names(500000).length === 2, names(500000));
    H.ok('第 64 条：开 2 个时第三个角度不丢', /假验证/.test(Sc.lensesFor('code', 1, cfgS, 100000)[1].text), Sc.lensesFor('code', 1, cfgS, 100000));
    H.ok('第 70 条：安全那个角度只看这次改的代码', /只看这次改的代码/.test(Sc.lensesFor('code', 1, cfgS, 200000)[2].text) && /框架怎么实现鉴权不看/.test(Sc.lensesFor('code', 1, cfgS, 200000)[2].text));
    // 第 64 条：材料小的 1 个看全
    H.setConfig(h, { reviewSmallChars: 40000, reviewLenses: 3 });
    const p3 = H.makeRepo(path.join(h.work, 'p3'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const d3 = change(p3, 'c3', 0, 1, { proposal: '现有逻辑在 a.js 和 no-such/b.js 里' });
    H.git(p3, ['add', '-A']); H.git(p3, ['commit', '-qm', 'x']);
    const small = R.prepare({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    H.ok('小材料：第一轮 1 个子代理', small.agents.length === 1 && small.agents[0].lens === '全量', small.agents);
    H.ok('小材料的名字', small.agents[0].description === '审查整套文档', small.agents[0].description);
    const smallScope = H.read(/范围文件：(.+)/.exec(small.agents[0].prompt)[1].trim());
    H.ok('它一个人看全三个角度', /事实和材料对不对得上/.test(smallScope) && /异常、权限、并发/.test(smallScope) && /前后矛盾/.test(smallScope), smallScope.slice(0, 500));
    H.ok('范围文件写了脚本核过的路径，在和不在', /脚本核过的路径/.test(smallScope) && /在：[^\n]*a\.js/.test(smallScope) && /不在[^\n]*no-such\/b\.js/.test(smallScope), smallScope.slice(0, 700));
    H.ok('第 70 条：范围文件要求框架和基础设施不读实现', /框架和基础设施/.test(smallScope) && /不读实现/.test(smallScope), smallScope.slice(0, 500));
    R.cancel({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    // 涉及的目录：文档点名的文件所在的目录；别处写过新建的不报不在
    H.write(path.join(p3, 'src/order/Order.java'), 'class Order {}\n');
    H.write(path.join(d3, 'proposal.md'), '## Why\n\n改 src/order/Order.java\n');
    H.write(path.join(d3, 'tasks.md'), '- [ ] 1.1 新建 src/order/Fresh.java：加导出\n- [ ] 1.2 改 src/order/Fresh.java：补空列表\n');
    H.write(path.join(d3, 'revisions.md'), '## x\n- 改了：删了 src/gone/Old.java\n');
    H.git(p3, ['add', '-A']); H.git(p3, ['commit', '-qm', 'y']);
    const area = R.prepare({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    const areaScope = H.read(/范围文件：(.+)/.exec(area.agents[0].prompt)[1].trim());
    H.ok('第 70 条：涉及的目录是点名文件的目录', /## 这次涉及的目录\s+src\/order/.test(areaScope), areaScope.slice(0, 600));
    // design 现状里列的探索路径不算涉及的目录，不逐个列（全量回归 test-feedback1013-context 抓到的）
    R.cancel({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    H.write(path.join(p3, 'lib/framework/Auth.java'), 'class Auth {}\n');
    H.write(path.join(d3, 'design.md'), '## Context\n\n- 读过 lib/framework/Auth.java：框架的鉴权\n\n## Decisions\n\n- 只改 src/order/Order.java：只有这里\n');
    H.git(p3, ['add', '-A']); H.git(p3, ['commit', '-qm', 'ctx']);
    const ctx = R.prepare({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    const ctxScope = H.read(/范围文件：(.+)/.exec(ctx.agents[0].prompt)[1].trim());
    H.ok('第 70 条：探索时读过的框架文件不算涉及的目录、不逐个列', /src\/order/.test(ctxScope) && !/lib\/framework/.test(ctxScope.split('## 要审的文件')[0]) && /探索路径 1 个也都在/.test(ctxScope), ctxScope.slice(0, 900));
    H.ok('别处写过新建的不报不在', !/不在[^\n]*Fresh\.java/.test(areaScope), areaScope.slice(0, 700));
    H.ok('revisions.md 记的旧路径不报不在', !/不在[^\n]*Old\.java/.test(areaScope), areaScope.slice(0, 700));
    R.cancel({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    H.write(path.join(d3, 'design.md'), '## Context\n\n' + '这是一段很长的设计说明。\n'.repeat(5000));
    const big = R.prepare({ cwd: p3, change: 'c3', mode: 'proposal', point: 'tasks' });
    H.ok('大材料：照旧分开开', big.agents.length >= 2 && big.agents.every((a) => a.lens !== '全量'), big.agents.map((a) => a.lens));
  }

  H.section('第 69 条：只改过规格的旧 change 不催审代码');
  {
    const h = H.makeHome('fb1105-69', FROM, QUIET);
    const S = require(path.join(h.kit, 'lib/session')); const P = require(path.join(h.kit, 'lib/flow-policy')); const R = require(path.join(h.kit, 'lib/review-runner'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    H.write(path.join(p, 'openspec/plan.md'), '# 计划\n\n## 值班\n\n探索记录：explore/值班.md\n\n' + PLAN_HEAD + '| | old-a | | |\n| | now-b | | |\n');
    H.write(path.join(p, 'openspec/explore/值班.md'), '# 探索\n\n## 还没定的\n\n## 范围\n\n只改查询\n');
    const a = change(p, 'old-a', 2, 0); const b = change(p, 'now-b', 0, 1);
    H.write(path.join(a, 'specs/x/spec.md'), '## ADDED Requirements\n');
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: x']);
    const yesterday = Date.now() - 86400000; fs.utimesSync(path.join(a, 'tasks.md'), yesterday / 1000, yesterday / 1000);
    const j = { cwd: p, session_id: 's69', transcript_path: tf(h, [H.tr.user('改规格')]) };
    S.setSessionAuto(j, true, '测试'); S.setFlow(j, true, '开工', 'apply'); S.flowTouch(j, a); S.flowTouch(j, b);
    R.baseline(j, [a, b]);
    H.write(path.join(a, 'specs/x/spec.md'), '## ADDED Requirements\n\n改了\n');
    const stop = () => P.stop(j, [a, b], false, 't' + (++seq));
    H.ok('旧 change 只改了规格：不催审代码', !stop().some((x) => /--change old-a/.test(x)), stop());
    H.write(path.join(b, 'tasks.md'), H.read(path.join(b, 'tasks.md')).replace('- [ ] 1.1', '- [x] 1.1'));
    const m = stop();
    H.ok('这个会话做完的 change：照样催审', m.some((x) => /--change now-b/.test(x)) && !m.some((x) => /--change old-a/.test(x)), m);
    H.write(path.join(a, 'tasks.md'), H.read(path.join(a, 'tasks.md')) + '- [x] 1.3 改 a.js：补一处\n');
    H.ok('旧 change 这个会话补了任务、勾了：照样审', P.oldDone ? !P.oldDone(j, a) : false);
    // 收工钩子第一次记"碰过"：这一轮刚勾完的不能算旧（钩子对比抓到的）
    const c = change(p, 'this-turn', 0, 1);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: y']);
    const jm = { cwd: p, session_id: 's69m' }; S.setFlow(jm, true, '开工', 'apply');
    H.write(path.join(c, 'tasks.md'), H.read(path.join(c, 'tasks.md')).replace('- [ ] 1.1', '- [x] 1.1'));
    const o = H.hook(h, 'verify-gate', { session_id: 's69m', cwd: p, hook_event_name: 'Stop', transcript_path: tf(h, [H.tr.user('做完 1.1'), H.tr.ran('Edit', { file_path: path.join(c, 'tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, 'ok')]) });
    H.ok('这一轮刚勾完：照样问审查', /this-turn/.test(H.reasonOf(o)) && /任务全部做完了/.test(H.reasonOf(o)), H.reasonOf(o));
    // 还没勾完的不算旧：接回一个写好文档、没审的 change，自动要接着审
    const d = change(p, 'docs-only', 0, 1);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: z']);
    fs.utimesSync(path.join(d, 'tasks.md'), yesterday / 1000, yesterday / 1000);
    const jd = { cwd: p, session_id: 's69d' }; S.setFlow(jd, true, '接回', 'plan'); S.flowTouch(jd, d);
    H.ok('还没勾完的不算旧', P.oldDone ? !P.oldDone(jd, d) : false);
    // 切到的 change、碰过之后改了代码的不算旧
    const e = change(p, 'solo-old', 1, 0);
    H.git(p, ['add', '-A']); H.git(p, ['commit', '-qm', 'docs: w']);
    fs.utimesSync(path.join(e, 'tasks.md'), yesterday / 1000, yesterday / 1000);
    const je = { cwd: p, session_id: 's69e' }; S.setFlow(je, true, '开工', 'apply'); S.flowTouch(je, e);
    H.ok('早勾完、这一轮只碰了文档：算旧', P.oldDone ? P.oldDone(je, e) === true : false);
    S.updateState('s69e-flow', (x) => { x.current = 'solo-old'; });
    // 接回不算碰过：上个会话勾完没审的还要审（复审 20261105-2 第 3 条）
    const jr = { cwd: p, session_id: 's69r' };
    H.hook(h, 'task-anchor', { session_id: 's69r', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '/vk-resume 值班', transcript_path: tf(h, [H.tr.user('/vk-resume 值班')]) }, { spawn: true });
    H.ok('/vk-resume 接回：不算碰过，勾完没审的不算旧', S.flowChanges(jr).length > 0 && !!P.oldDone && !P.oldDone(jr, a) && !(S.flowState(jr).touchedAt || {})[S.normKey(a)], S.flowState(jr));
    H.ok('用户切到它：不算旧', P.oldDone ? !P.oldDone(je, e) : false);
  }

  H.section('第 63 条：审查子代理默认用 Sonnet，不设 effort');
  {
    const SRC = FROM || path.join(__dirname, '..', 'vibe-kit');
    const runner = H.read(path.join(SRC, 'kit/lib/review-runner.js')) || '';
    H.ok('claude -p 用模型名 sonnet', /'--model', 'sonnet'/.test(runner));
    H.ok('不写 effort', !/--effort/.test(runner));
    const skill = H.read(path.join(SRC, 'claude/skills/vk-cross-review/SKILL.md')) || '';
    H.ok('审查技能不让模型自己选模型', !/subagent_type[^\n]*model/.test(skill));
    const manual = H.read(path.join(SRC, '手册/审查和自测.md')) || '';
    H.ok('手册写明 Sonnet 和改名字的环境变量', /默认用 Sonnet/.test(manual) && /ANTHROPIC_DEFAULT_SONNET_MODEL/.test(manual));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('第 59—63 条');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
