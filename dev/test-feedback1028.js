'use strict';
/*
 * 1028 导出议题和问题反馈表第 6—16 条（docs/feedback-20261028.md）。
 *   路由：发给上游的请求不带 Authorization: Bearer（第 11 条）；模型名照带（第 18 条：1834 去掉过，网关报缺少 model）
 *   审查：不截断；只回思考时少想重试、再拆半批；碰到上限、超时记问题反馈（第 6、7 条，#226）；不带变更的审查能登记决定（#234）
 * 用法：node dev/test-feedback1028.js [路由端口] [旧版的 vibe-kit 目录]（给了旧版就拿旧版跑，看哪些项不过）
 * 全在假用户目录里；假上游只听本机端口，不连真的模型网关。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18797;
const from = process.argv[3] ? path.resolve(process.argv[3]) : H.SRC;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  const watch = await H.watchWindows('t1028');

  // ---------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------
  H.section('审查：只回思考时少想重试、再拆半批；碰到输出上限记问题反馈（#226、第 6、7 条）；不带变更也能登记决定（#234）');
  {
    const h = H.makeHome('t1028-review', from, { autoVerify: false, autoSeePage: false, specGate: false, commitMode: 'off' });
    const p = H.makeRepo(path.join(h.work, 'plain'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n', 'b.js': 'const b=1;\n' });
    const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();
    H.write(path.join(p, 'a.js'), 'const a=2;\n'); H.write(path.join(p, 'b.js'), 'const b=2;\n');
    {
      const R = require(path.join(h.kit, 'lib/review-runner'));
      // 文件没变，默认不开子代理（第 37 条）：这里要整份再审一遍
      const r2 = await H.fakeReview(R, { cwd: p, mode: 'code', base, full: true }, () => ({ issues: [{ severity: 'P2', file: 'a.js', line: 1, problem: '常量改了没说明', evidence: 'a.js 第 1 行', fix: '补说明' }], summary: '审完' }));
      H.ok('不带变更的审查报了一条', r2.status === 'completed' && r2.issues.length === 1, r2);
      const dec = path.join(h.root, 'decisions.json');
      H.write(dec, JSON.stringify({ findings: [{ id: 'r1', action: 'accepted', reason: '用户说这条不改：常量改动在提交信息里说明了' }] }));
      let res = null; let err = '';
      try { res = R.resolve({ cwd: p, mode: 'code', decisions: dec }); } catch (e) { err = e.message; }
      H.ok('#234 不带 --change 的 resolve 能登记决定', !!res && res.status === 'resolved', err || res);
      const rep = readJson(path.join(p, '.vibe/reviews/plain/code.json'));
      H.ok('决定记进了 .vibe/reviews/plain/code.json', Array.isArray(rep.decisions) && rep.decisions[0].action === 'accepted', rep.decisions);
      const tool = path.join(h.kit, 'tools/review.js').replace(/\\/g, '/');
      const cmd = 'node "' + tool + '" resolve --mode code --project "' + p.replace(/\\/g, '/') + '" --decisions "' + dec.replace(/\\/g, '/') + '"';
      let seq = 0;
      const guard = (said) => H.hook(h, 'guard-commit', { session_id: 'plain-' + (++seq), cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'resolve-' + seq, tool_input: { command: cmd }, transcript_path: H.transcript(path.join(h.root, 'r' + seq + '.jsonl'), [H.tr.user(said)]) });
      const ok = guard('r1 这条不改');
      H.ok('#234 用户说了"这条不改"：带"接受"的 resolve 不再被"必须绑定有效变更"拦', ok === null || !/必须绑定有效变更/.test(H.reasonOf(ok)), ok);
      H.ok('#234 用户没表态：带"接受"的 resolve 照旧要用户决定', /需要当前用户明确决定/.test(H.reasonOf(guard('继续'))), H.reasonOf(guard('继续')));
    }
  }

  // ---------------------------------------------------------------------------------------------
  H.section('中途打开 Apply 自动：说"开始实施"也算开工；不算自动时提示写清为什么（第 8 条、#227）');
  {
    const h = H.makeHome('t1028-auto', from, { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false });
    const S = require(path.join(h.kit, 'lib/session'));
    const DESIGN = '## Context\n\n- 读过 src/A.java\n\n## Decisions\n\n- 放在 A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 返回 200 | 人工 | 1 |\n';
    const p = H.makeRepo(path.join(h.work, 'one'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
      'openspec/changes/feat-019/proposal.md': '## Why\n\n要做。\n\n## What Changes\n\n- 改 src/A.java\n',
      'openspec/changes/feat-019/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 做\n\n系统 SHALL 做。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
      'openspec/changes/feat-019/design.md': DESIGN, 'openspec/changes/feat-019/tasks.md': '- [ ] 1.1 改 src/A.java：加功能\n' });
    let seq = 0;
    const tf = (es) => H.transcript(path.join(h.root, 'a' + (++seq) + '.jsonl'), es);
    const prompt = (sid, text, es) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: tf(es) });
    let es = [H.tr.user('/opsx:explore 做一个导出功能，写需求')];
    prompt('s-auto', '/opsx:explore 做一个导出功能，写需求', es);
    es = es.concat([H.tr.say('feat-019 的提案、规格、设计、任务都写完了，能开工吗？')]);
    H.setConfig(h, { autoApply: true });
    // 还在需求阶段时去审查：提示写清 Apply 自动开着、为什么这一轮不算
    const reviewCmd = 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" run --change feat-019 --mode proposal --point design --project "' + p.replace(/\\/g, '/') + '"';
    const before = H.hook(h, 'guard-commit', { session_id: 's-auto', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'rv-1', tool_input: { command: reviewCmd }, transcript_path: tf(es) });
    H.ok('不算自动时：提示说配置页开了 Apply 自动、还在需求阶段要说开工', /Apply 自动/.test(H.reasonOf(before)) && /开工|开始实施/.test(H.reasonOf(before)), H.reasonOf(before));
    es = es.concat([H.tr.user('开始实施 feat-019')]);
    prompt('s-auto', '开始实施 feat-019', es);
    H.ok('说"开始实施 feat-019"：进了实施阶段，Apply 自动算数', S.flowState({ session_id: 's-auto' }).stage === 'apply' && S.readConfigFor({ session_id: 's-auto', cwd: p }).autoMode === true, S.flowState({ session_id: 's-auto' }));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('审查、提交：同一句许可这一轮里能用好几次（第 16 条）');
  {
    const h = H.makeHome('t1028-perm', from, { autoVerify: false, autoSeePage: false, commitMode: 'off', specGate: false });
    const p = H.makeRepo(path.join(h.work, 'perm'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n', 'b.js': 'const b=1;\n' });
    let seq = 0;
    const run = (command, entries) => H.hook(h, 'guard-commit', { session_id: 'perm', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'perm-' + (++seq), tool_input: { command }, transcript_path: H.transcript(path.join(h.root, 'p' + seq + '.jsonl'), entries) });
    const done = (command, entries) => H.hook(h, 'after-tool', { session_id: 'perm', cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'perm-' + seq, tool_input: { command }, tool_response: { exit_code: 0, stdout: 'ok' }, transcript_path: H.transcript(path.join(h.root, 'p' + seq + '.jsonl'), entries) });
    const said = [H.tr.user('改好了，提交')];
    H.write(path.join(p, 'a.js'), 'const a=2;\n'); H.git(p, ['add', 'a.js']);
    const c1 = run('git commit -m "fix: 改 a"', said);
    H.ok('说了"提交"：第一次提交放行', c1 === null, c1);
    H.git(p, ['commit', '-m', 'fix: 改 a']); done('git commit -m "fix: 改 a"', said);
    H.write(path.join(p, 'b.js'), 'const b=2;\n'); H.git(p, ['add', 'b.js']);
    const c2 = run('git commit -m "fix: 改 b"', said);
    H.ok('同一句"提交"：按规矩分开的第二次提交也放行，不再问', c2 === null, c2);
    const reviewCmd = 'node "' + path.join(h.kit, 'tools/review.js').replace(/\\/g, '/') + '" run --mode code --project "' + p.replace(/\\/g, '/') + '" --base HEAD~2';
    const rs = [H.tr.user('审查一下')];
    const r1 = run(reviewCmd, rs);
    H.ok('说了"审查"：第一次审查放行', r1 === null, r1);
    done(reviewCmd, rs);
    H.write(path.join(p, 'b.js'), 'const b=3;\n');
    const r2 = run(reviewCmd, rs);
    H.ok('同一句"审查"：改完再复审也放行，不再问', r2 === null, r2);
    const r3 = run(reviewCmd, [H.tr.user('审查一下'), H.tr.say('审完了'), H.tr.user('看看日志')]);
    H.ok('换了一句话（不是要审查）：照旧先问', !!r3 && /用户这一轮没说要审查/.test(H.reasonOf(r3)), H.reasonOf(r3));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('#225 产出位置：提问框答"项目根目录"认得出；问过位置后记进项目说明的算定过；两种拦截话第一行一样');
  {
    const h = H.makeHome('t1028-out', from, { autoVerify: false, autoSeePage: false, specGate: false, commitMode: 'off' });
    const p = H.makeRepo(path.join(h.work, 'test-skill'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n' });
    let seq = 0;
    const ask = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, 'User has answered your questions: "' + q + '"="' + a + '". You can now continue with the user\'s answers in mind.');
    const write = (sid, file, entries) => H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(p, file), content: '# 使用说明\n' }, transcript_path: H.transcript(path.join(h.root, 'o' + (++seq) + '.jsonl'), entries) });
    const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
    const doc = 'official-material-使用说明.md';
    const said = [H.tr.user('写一份使用说明')];
    H.ok('没问过位置：拦下', blocked(write('o1', doc, said)));
    const root = write('o2', doc, said.concat(ask('这份使用说明放哪？', '项目根目录')));
    H.ok('提问框问放哪、答"项目根目录"：根目录下的说明文档放行', root === null, H.reasonOf(root));
    const sub = write('o3', 'docs/使用说明.md', said.concat(ask('这份使用说明放哪？', '项目根目录')));
    H.ok('答的是根目录、文件却在 docs/ 下：照旧拦', blocked(sub), H.reasonOf(sub));
    // 模型在会话里自己把位置记进项目说明：没问过用户不算；问过用户（随便怎么答）、照答案记的算
    const first = write('o4', 'docs/说明.md', said);
    // 模型改项目说明之前，pre-edit 先把原来的产出位置记下来（会话里之后加的不算定过）
    H.hook(h, 'pre-edit', { session_id: 'o4', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(p, '.vibe/project.md'), content: '# 项目说明\n' }, transcript_path: H.transcript(path.join(h.root, 'pm.jsonl'), said) });
    H.write(path.join(p, '.vibe/project.md'), '# 项目说明\n\n## 产出位置\n\n- 说明文档：docs/\n');
    const self = write('o4', 'docs/说明.md', said);
    H.ok('自己加的位置、没问过用户：照旧拦，提示说是自己加的', blocked(self) && /自己加的/.test(H.reasonOf(self)), H.reasonOf(self));
    const firstLine = (o) => H.reasonOf(o).split('\n')[0];
    H.ok('两种拦截话第一行一样（放行按第一行认是不是同一条规矩）', firstLine(first) === firstLine(self), [firstLine(first), firstLine(self)]);
    const F = require(path.join(h.kit, 'lib/feedback'));
    const target = 'file:' + require(path.join(h.kit, 'lib/session')).normKey(path.join(p, 'docs/说明.md'));
    H.ok('为第一种申请的放行，对第二种也算', !!F.pickPass([{ hook: 'guard-output', sig: 'x', target, reason: H.reasonOf(first) }], 'guard-output', 'y', target, H.reasonOf(self)));
    const asked = write('o4', 'docs/说明.md', said.concat(ask('说明文档放在哪个目录？', '放说明文档的那个目录')));
    H.ok('这个会话问过用户放哪、模型照答案记进项目说明：放行', asked === null, H.reasonOf(asked));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('起服务看日志等：日志说起好了才发请求，日志报了起不来马上返回（第 14 条）');
  {
    const h = H.makeHome('t1028-dev', from);
    const proj = H.makeRepo(path.join(h.work, 'svc'), { 'pom.xml': '<project/>' });
    const TOOL = path.join(h.kit, 'tools', 'devserver.js');
    const tool = (args) => H.node(h, TOOL, args, { cwd: proj, timeout: 120000 });
    // 像 Tomcat：一起来就占端口，15 秒后才部署好；没部署好之前来的请求直接断开。每来一个请求记一笔
    H.write(path.join(proj, 'slow.js'), [
      "const http = require('http'); const fs = require('fs'); let ready = false;",
      "http.createServer((q, r) => { fs.appendFileSync(process.argv[2], 'x'); if (ready) r.end('ok'); else q.socket.destroy(); }).listen(Number(process.env.PORT), '127.0.0.1', () => {",
      "  console.log('booting'); setTimeout(() => { ready = true; console.log('Started Demo in 15.0 seconds (JVM running for 16)'); }, 15000); });",
    ].join('\n'));
    // 起不来：报了 Spring Boot 的错，进程却不退
    H.write(path.join(proj, 'bad.js'), "console.log('***************************\\nAPPLICATION FAILED TO START\\n***************************'); setInterval(() => {}, 1000);");
    const hits = path.join(h.root, 'hits.txt');
    const t0 = Date.now();
    const up = tool(['start', '--name', 'slow', '--port', '18798', '--', 'node', 'slow.js', hits]);
    const n = (H.read(hits) || '').length;
    H.ok('起来了，说是日志里看到起好了', up.code === 0 && /日志里看到 "Started Demo/.test(up.out), up.out.slice(-600));
    H.ok('没部署好的 15 秒里不是每秒去探：一共只发了几次请求（以前每秒一次）', n >= 1 && n <= 4, n);
    tool(['stop', '--name', 'slow']);
    const t1 = Date.now();
    const bad = tool(['start', '--name', 'bad', '--port', '18799', '--', 'node', 'bad.js']);
    const last = bad.out.trim().split(/\r?\n/).pop() || '';
    H.ok('日志报了起不来：马上返回，不干等到超时（180 秒）', bad.code === 1 && Date.now() - t1 < 30000 && /日志里报了 "APPLICATION FAILED TO START"/.test(last), [Date.now() - t1, last]);
    H.ok('起不来的进程停掉了、记录清掉了', !fs.existsSync(path.join(proj, '.vibe', 'run', 'bad.json')), bad.out.slice(-400));
    H.ok('（用时参考）', true, Math.round((t1 - t0) / 1000) + ' 秒');
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 17 条：认得自己起过的服务（换目录、换名字、记录丢了），重启先停再起，热更新的不重启');
  {
    const h = H.makeHome('t1028-own', from);
    const shell = path.join(h.work, 'shell');
    const proj = H.makeRepo(path.join(shell, 'api'), { 'pom.xml': '<project/>', 'A.java': 'class A {}\n' });
    const front = H.makeRepo(path.join(shell, 'web'), { 'package.json': JSON.stringify({ scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build' } }) });
    const TOOL = path.join(h.kit, 'tools', 'devserver.js');
    const tool = (cwd, args) => H.node(h, TOOL, args, { cwd, timeout: 120000 });
    const last = (r) => r.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const portOf = (r) => Number((/端口 (\d+)/.exec(last(r)) || [])[1]) || 0;
    // 服务回自己的进程号：看是不是同一个进程
    const srv = "require('http').createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1');";
    H.write(path.join(proj, 'srv.js'), srv);
    H.write(path.join(front, 'vite.js'), srv);   // 命令写成 node vite.js：认得出是 vite（热更新）
    const pidAt = (port) => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: '/', agent: false, timeout: 3000 }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve(Number(t) || 0)); }).on('error', () => resolve(0)); });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } };

    const s1 = tool(proj, ['start', '--name', 'api', '--port', 'auto', '--', 'node', 'srv.js']);
    const port = portOf(s1); const pid1 = await pidAt(port);
    H.ok('在子项目里起了 api', s1.code === 0 && port > 0 && pid1 > 0, s1.out.slice(-400));
    // 换到壳子根、换个名字、用 --cwd 指到同一个子项目
    const s2 = tool(shell, ['start', '--name', 'backend', '--port', 'auto', '--cwd', 'api', '--', 'node', 'srv.js']);
    H.ok('换到壳子根、换了名字：认出是之前起的那个，直接用，不另起', s2.code === 0 && /认出来了：端口 \d+ 上是之前用 devserver 起的"api"/.test(s2.out) && /^已经在跑：backend（端口 \d+/.test(last(s2)) && portOf(s2) === port && (await pidAt(port)) === pid1, s2.out.slice(-600));
    // 改了代码：在原来的端口先停再起
    H.write(path.join(proj, 'A.java'), 'class A { int x; }\n');
    const s3 = tool(shell, ['start', '--name', 'backend', '--port', 'auto', '--cwd', 'api', '--', 'node', 'srv.js']);
    const pid3 = await pidAt(port);
    H.ok('改了代码：在原来的端口重启（先停再起），不换端口', s3.code === 0 && /停掉，在同一个端口重启/.test(s3.out) && portOf(s3) === port && pid3 > 0 && pid3 !== pid1 && !alive(pid1), s3.out.slice(-600));
    // 记录、登记都丢了（比如以前的版本、手删了 .vibe/run）：端口上是 Claude 用 devserver 起的，不当成用户的，先停再起，不另挑端口
    for (const d of [path.join(shell, '.vibe', 'run'), path.join(proj, '.vibe', 'run')]) { try { for (const n of fs.readdirSync(d)) if (n.endsWith('.json')) fs.unlinkSync(path.join(d, n)); } catch (e) { /* 没有 */ } }
    try { fs.unlinkSync(path.join(h.kit, 'state', 'devserver.json')); } catch (e) { /* 没有 */ }
    const s4 = tool(proj, ['start', '--name', 'api', '--port', 'auto', '--', 'node', 'srv.js']);
    const pid4 = await pidAt(port);
    H.ok('记录丢了：认出端口上是 Claude 起的，不说是用户起的，先停再在这个端口起', s4.code === 0 && portOf(s4) === port && /Claude 用 devserver 起的，记录丢了/.test(s4.out) && !/用户自己起的/.test(s4.out) && pid4 > 0 && pid4 !== pid3 && !alive(pid3), s4.out.slice(-600));
    // 热更新：vite 改了代码不重启
    const v1 = tool(front, ['start', '--name', 'web', '--port', 'auto', '--', 'node', 'vite.js']);
    const vport = portOf(v1); const vpid = await pidAt(vport);
    H.ok('vite 起来了，说会热更新', v1.code === 0 && /会热更新：改了代码不用重启/.test(last(v1)), last(v1));
    H.write(path.join(front, 'App.vue'), '<template>改了</template>\n');
    const v2 = tool(front, ['start', '--name', 'web', '--port', 'auto', '--', 'node', 'vite.js']);
    H.ok('vite 改了代码：不重启，直接用', v2.code === 0 && /^已经在跑：web/.test(last(v2)) && /会热更新，改了代码不用重启/.test(last(v2)) && (await pidAt(vport)) === vpid, last(v2));
    const D = require(path.join(h.kit, 'tools', 'devserver.js'));
    H.ok('npm run dev 对应的脚本是 vite：认成热更新；npm run build 不是', D.hotOf('npm run dev -- --port 30001', front) && D.hotOf('npm --prefix web run dev', shell) && !D.hotOf('npm run build', front) && !D.hotOf('mvn spring-boot:run', proj));
    // 同一个目录、同一条命令、名字不同：是有意起两份（环境变量不同），不认成同一个
    const a1 = tool(proj, ['start', '--name', 'one', '--port', 'auto', '--', 'node', 'srv.js']);
    const a2 = tool(proj, ['start', '--name', 'two', '--port', 'auto', '--env', 'X=2', '--', 'node', 'srv.js']);
    H.ok('同一个目录里名字不同、命令相同：起两份，不认成同一个', a1.code === 0 && a2.code === 0 && portOf(a1) !== portOf(a2) && !/认出来了/.test(a2.out) && fs.existsSync(path.join(proj, '.vibe', 'run', 'one.json')), a2.out.slice(-400));
    tool(proj, ['stop', '--name', 'one']); tool(proj, ['stop', '--name', 'two']);
    // 从 Claude Code 里跑的别的程序（这里是测试自己起的进程）占着端口：往上找得到 claude，但不是 devserver 起的，不能当成自己的去结束
    const holder = require('child_process').spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end('x')).listen(18802,'127.0.0.1')"], { windowsHide: true, stdio: 'ignore' });
    await H.sleep(800);
    const busy = tool(proj, ['start', '--name', 'busy', '--port', '18802', '--', 'node', 'srv.js']);
    H.ok('端口被不是 devserver 起的程序占着：不动它，说清是谁', busy.code === 1 && alive(holder.pid) && !/记录丢了/.test(busy.out), busy.out.slice(-400));
    try { holder.kill(); } catch (e) { /* 已经退了 */ }
    // 在壳子根 stop --all：各个子项目里起的都停掉
    const st = tool(shell, ['status']);
    H.ok('在壳子根看 status：子项目里起的也列出来', /api：在跑/.test(st.out) && /web：在跑/.test(st.out), st.out.slice(-600));
    const sp = tool(shell, ['stop', '--all']);
    H.ok('在壳子根 stop --all：都停了', sp.code === 0 && !alive(pid4) && !(await pidAt(vport)), sp.out.slice(-600));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('1028 反馈');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
