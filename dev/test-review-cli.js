'use strict';
/*
 * 审查改成脚本调 claude -p（第 72 条，2026-11-05）：review.js run 备材料、起后台进程、等结果。假的 claude：一个 .cmd 调 node 脚本，把收到的提示写下来，按场景回。
 * 参数：[旧套件目录]（拿上一版跑看多少项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const from = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const NO_ISSUE = '```json\n{"issues":[],"need":[],"summary":"看了"}\n```';
const ONE_ISSUE = '```json\n{"issues":[{"severity":"P2","file":"src/A.java","line":3,"problem":"批量查询之前没有判断列表是不是空的","evidence":"传空列表报语法错","fix":"判空","kind":"边界","avoid":"无","scope":"in"}],"need":["Mapper 的 SQL"],"summary":"看了"}\n```';

/** 假的 claude：场景写在文件里，一行一个回复，用完重复最后一个。特殊回复：SLOW:秒:回复、FAIL:报错 */
function fakeClaude(h) {
  const bin = path.join(h.root, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const js = path.join(bin, 'fake-claude.js');
  const log = path.join(h.root, 'calls.jsonl'); const plan = path.join(h.root, 'plan.json');
  fs.writeFileSync(js, `const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,prompt:s,cwd:process.cwd(),claudecode:process.env.CLAUDECODE||'',traffic:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC||'',mds:process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS||''})+'\\n');
let p=[];try{p=JSON.parse(fs.readFileSync(${JSON.stringify(plan)},'utf8'))}catch(e){}
const n=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(Boolean).length;
let r=p[Math.min(n-1,p.length-1)]||'{"issues":[]}';
const done=()=>{process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:r,usage:{input_tokens:100,output_tokens:50}})+'\\n');process.exit(0)};
if(r.startsWith('FAIL:')){process.stderr.write(r.slice(5));process.exit(1)}
if(r.startsWith('SLOW:')){const m=/^SLOW:(\\d+):([\\s\\S]*)$/.exec(r);r=m[2];setTimeout(done,Number(m[1])*1000);return}
done()});`);
  const cmd = path.join(bin, 'claude.cmd');
  fs.writeFileSync(cmd, '@"' + process.execPath + '" "' + js + '" %*\r\n');
  return { cmd, log, plan, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }, reset: (replies) => { try { fs.unlinkSync(log); } catch (e) { /* 没有 */ } fs.writeFileSync(plan, JSON.stringify(replies)); } };
}

function setup(name, config) {
  const h = H.makeHome(name, from, Object.assign({ reviewSmallChars: 40000, reviewLenses: 3 }, config || {}));
  const fake = fakeClaude(h);
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), {
    'CLAUDE.md': '项目约定 PROJECT-RULE-MARK\n',
    '.claude/rules/vk-lessons-x.md': '经验 LESSON-MARK\n',
    'src/A.java': 'class A {\n  void loadOrders(List ids) {\n    query(ids);\n  }\n}\n',
    'src/Caller.java': 'class Caller {\n  void run() { new A().loadOrders(null); }\n}\n',
    'src/Fact.java': 'class Fact {\n  void viewVerifyAllValue() {\n    FACT-CONTEXT-MARK;\n  }\n}\n',
    'openspec/changes/c1/proposal.md': '# 提案 PROPOSAL-MARK\n说的是 `viewVerifyAllValue` 和 NoSuchThingAnywhere。\n',
    'openspec/changes/c1/design.md': '# 设计 DESIGN-MARK\n',
    'openspec/changes/c1/specs/x/spec.md': '### Requirement: x\n#### Scenario: y\n- WHEN a\n- THEN b\n',
    'openspec/changes/c1/tasks.md': '# 任务\n- [ ] 1.1 改：src/A.java\n',
  });
  const base = H.git(proj, ['rev-parse', 'HEAD']).out.trim();
  fs.writeFileSync(path.join(proj, 'src/A.java'), 'class A {\n  void loadOrders(List ids) {\n    if (ids == null) return;\n    query(ids);\n  }\n}\n');
  const review = (args, extraEnv) => H.node(h, path.join(h.kit, 'tools', 'review.js'), args, { cwd: proj, timeout: 120000, env: Object.assign({ VIBE_KIT_REVIEW_NO_RUN: undefined, VIBE_KIT_CLAUDE_EXE: fake.cmd }, extraEnv || {}) });
  const json = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { return { status: 'bad', raw: r.out + r.err }; } };
  return { h, fake, proj, base, review, json };
}

(async () => {
  H.section('一轮代码审查');
  {
    const s = setup('rc-code');
    s.fake.reset([ONE_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('一条命令审完，结论在输出里', r.status === 'completed' && (r.issues || []).length === 1, r);
    H.ok('结果里有 next', /P1、P2/.test(r.next || ''), r.next);
    H.ok('need 带回来了', (r.need || []).includes('Mapper 的 SQL') && /自己用 Grep、Read 查/.test(r.next || ''), r);
    const c = s.fake.calls();
    H.ok('发了一个请求', c.length === 1, c.length);
    if (c[0]) {
      const a = c[0].args.join(' ');
      H.ok('不带工具（--tools 空）', /--tools (""|$| )/.test(a) || c[0].args.includes(''), a);
      H.ok('关掉钩子（--settings）', c[0].args.includes('--settings'), a);
      H.ok('模型 sonnet', /--model sonnet/.test(a), a);
      H.ok('不留会话记录', a.includes('--no-session-persistence'), a);
      H.ok('提示带规矩', c[0].prompt.includes('你是审查者') && c[0].prompt.includes('没有工具可用'));
      H.ok('提示带差异', c[0].prompt.includes('+    if (ids == null) return;'));
      H.ok('提示带当前文件', c[0].prompt.includes('void loadOrders'));
      H.ok('提示带调用方（脚本查的）', c[0].prompt.includes('src/Caller.java'));
      H.ok('工作目录是项目（项目约定由 Claude Code 带上）', path.resolve(c[0].cwd).toLowerCase() === path.resolve(s.proj).toLowerCase(), c[0].cwd);
      H.ok('嵌套标记去掉了', c[0].claudecode === '', c[0].claudecode);
      H.ok('不连用户配的 MCP（--strict-mcp-config）', c[0].args.includes('--strict-mcp-config'), a);
      H.ok('少一个起标题的请求、不带全局约定', c[0].traffic === '1' && c[0].mds === '1', c[0]);
      H.ok('项目约定和经验规则脚本放进提示', c[0].prompt.includes('PROJECT-RULE-MARK') && c[0].prompt.includes('LESSON-MARK'));
      H.ok('规矩只留这一轮的模式', c[0].prompt.includes('## 代码模式') && !c[0].prompt.includes('## 提案模式') && !c[0].prompt.includes('## 复审模式'));
      H.ok('提示里不让它开工具交结论的旧说法没了', !/最后一条回复只写这两样/.test(c[0].prompt));
    }
    const rec = H.read(path.join(s.proj, '.vibe/reviews/plain/审查记录.md')) || '';
    H.ok('审查记录记了', /批量查询之前没有判断/.test(rec), rec.slice(0, 200));
    H.ok('任务目录清了', !fs.readdirSync(path.join(s.proj, '.vibe/reviews/plain')).some((n) => /^job-/.test(n)));
    // 改完第二轮：只审修改点
    fs.writeFileSync(path.join(s.proj, 'src/A.java'), 'class A {\n  void loadOrders(List ids) {\n    if (ids == null || ids.isEmpty()) return;\n    query(ids);\n  }\n}\n');
    s.fake.reset([NO_ISSUE]);
    const r2 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    const c2 = s.fake.calls();
    H.ok('第二轮：一个请求，只审改过的', r2.status === 'completed' && r2.scope === 'changes' && c2.length === 1, r2);
    H.ok('第二轮的提示带上一轮的问题和改动', c2[0] && c2[0].prompt.includes('上一轮的问题') && c2[0].prompt.includes('ids.isEmpty()'));
    H.ok('第二轮的规矩是复审模式', c2[0] && c2[0].prompt.includes('## 复审模式') && !c2[0].prompt.includes('## 代码模式'));
    s.fake.reset([NO_ISSUE]);
    const r3 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('文件没变：不发请求', s.fake.calls().length === 0 && r3.noChange === true, r3);
  }

  H.section('提案审查：脚本查好事实');
  {
    const s = setup('rc-doc');
    s.fake.reset([NO_ISSUE]);
    const r = s.json(s.review(['run', '--change', 'c1', '--mode', 'proposal', '--project', s.proj]));
    const c = s.fake.calls();
    H.ok('审完', r.status === 'completed', r);
    if (c[0]) {
      H.ok('四份文档都送了', ['PROPOSAL-MARK', 'DESIGN-MARK', 'WHEN a', '1.1 改'].every((m) => c[0].prompt.includes(m)));
      H.ok('文档点名的方法查好了，带前后几行', c[0].prompt.includes('src/Fact.java') && c[0].prompt.includes('FACT-CONTEXT-MARK'));
      H.ok('搜不到的名字告诉它', /一处都没搜到[\s\S]*NoSuchThingAnywhere/.test(c[0].prompt));
    }
  }

  H.section('没拿到结论');
  {
    const s = setup('rc-retry');
    s.fake.reset(['想了很久还没有结论', ONE_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('只想不答：重试一次拿到', r.status === 'completed' && s.fake.calls().length === 2, r);
    H.ok('第二次提示它直接交', /这次不要再分析/.test(s.fake.calls()[1].prompt) && !/这次不要再分析/.test(s.fake.calls()[0].prompt));
    H.ok('结果里有用了多少 token', r.tokens && r.tokens.out === 100, r.tokens);
    H.ok('审查记录写了 token', /输出 100 token/.test(H.read(path.join(s.proj, '.vibe/reviews/plain/审查记录.md')) || ''));
    s.fake.reset(['{"issues":[{"file":"a","problem":"第一行\n第二行","evidence":"e"},],"summary":"s"}']);
    fs.appendFileSync(path.join(s.proj, 'src/A.java'), '// x\n');
    const r2 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base, '--full']));
    H.ok('字符串里有裸换行、多逗号的 JSON 也认', r2.status === 'completed' && r2.issues.length === 1, r2);
  }
  {
    const s = setup('rc-lost');
    s.fake.reset(['没有结论']);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('两次都没结论：failed，说清', r.status === 'failed' && (r.lost || []).length === 1 && /没有能解析的 JSON/.test(r.reason || ''), r);
    H.ok('试了两次', s.fake.calls().length === 2, s.fake.calls().length);
    H.ok('没写审查结果（不算通过）', !fs.existsSync(path.join(s.proj, '.vibe/reviews/plain/code.json')));
    s.fake.reset([NO_ISSUE]);
    const r2 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('再跑一次补上', r2.status === 'completed', r2);
  }
  {
    const s = setup('rc-missing');
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base], { VIBE_KIT_CLAUDE_EXE: path.join(s.h.root, 'no-such-claude.exe') }));
    H.ok('claude 起不来：failed，不算通过', r.status === 'failed' && /claude/.test(r.reason || ''), r);
  }

  H.section('升级前子代理留下的');
  {
    const s = setup('rc-old-job');
    const dir = path.join(s.proj, '.vibe/reviews/plain');
    // 一个一天前的任务目录、一条还记着"发出去了"的旧记录（没有进程号、也没有提示文件）
    const stale = path.join(dir, 'job-' + 'a'.repeat(24)); fs.mkdirSync(stale, { recursive: true }); H.write(path.join(stale, '全量.md'), '旧的范围文件');
    const old = new Date(Date.now() - 2 * 86400000); fs.utimesSync(stale, old, old);
    s.fake.reset([NO_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('审查照常', r.status === 'completed', r);
    H.ok('一天前留下的任务目录清掉了', !fs.existsSync(stale));
    const R = require(path.join(s.h.kit, 'lib/review-runner.js'));
    H.ok('旧接口都没了', !R.claim && !R.heartbeat && !R.taskOf && !R.dispatch && !R.noteReject);
  }

  H.section('等不完');
  {
    const s = setup('rc-slow');
    s.fake.reset(['SLOW:6:' + NO_ISSUE]);
    const first = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base, '--wait', '1']));
    H.ok('没审完返回 running', first.status === 'running' && /再跑一次/.test(first.next || ''), first);
    const second = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base, '--wait', '60']));
    H.ok('再跑一次接着等，拿到结果', second.status === 'completed', second);
    H.ok('没有重开', s.fake.calls().length === 1, s.fake.calls().length);
  }

  H.section('几个角度、分批');
  {
    const s = setup('rc-lens', { reviewSmallChars: 10 });
    s.fake.reset([ONE_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('材料超过设置：几个角度同时跑', r.status === 'completed' && r.lenses >= 2 && s.fake.calls().length === r.lenses, r);
    H.ok('几个角度报同一件事只留一条', r.issues.length === 1, r.issues);
  }
  {
    // 大文件改几行：按差异算大小，不开几个角度
    const s = setup('rc-small', { reviewSmallChars: 2000 });
    fs.writeFileSync(path.join(s.proj, 'src/Big.java'), 'class Big {\n' + '  int a;\n'.repeat(3000) + '}\n'); H.git(s.proj, ['add', '.']); H.git(s.proj, ['commit', '-qm', 'big']);
    const base2 = H.git(s.proj, ['rev-parse', 'HEAD']).out.trim();
    fs.appendFileSync(path.join(s.proj, 'src/Big.java'), '// 改一行\n');
    s.fake.reset([NO_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', base2]));
    H.ok('大文件改一行：一个请求', r.status === 'completed' && s.fake.calls().length === 1, r);
  }
  {
    const Facts = require(path.join(from || H.SRC, 'kit/lib/review-facts.js'));
    const big = 'x'.repeat(150000);
    const packs = Facts.packsOf([{ file: 'a.java', text: big }, { file: 'b.java', text: big }, { file: 'c.java', text: big }, { file: 'spec.md', role: '需求文档', text: 'SPEC' }], 240000);
    H.ok('放不下分批', packs.length >= 2, packs.length);
    H.ok('每批都带需求文档', packs.every((p) => p.some((e) => e.file === 'spec.md')));
    H.ok('要审的都送到', packs.flat().filter((e) => !e.role).reduce((n, e) => n + e.text.length, 0) === 450000);
    H.ok('放得下一批', Facts.packsOf([{ file: 'a', text: 'x' }], 240000).length === 1);
    const code = Facts.entriesOf([{ file: 'a', text: '基线差异：\n@@ x\n\n当前文件：\n' + 'y'.repeat(50000) }]);
    H.ok('太大的文件只送差异', code[0].text.length < 100 && code[0].text.includes('@@ x'));
    H.ok('认类名、方法名、表名，不认普通词', (() => { const n = Facts.symbolsOf('`NotLoginException` 在 `OrderService.loadOrders`，表 EXCEL_CUSTOM_VALUE，`status` Word'); return ['NotLoginException', 'OrderService', 'loadOrders', 'EXCEL_CUSTOM_VALUE'].every((x) => n.includes(x)) && !n.includes('status') && !n.includes('Word'); })());
    H.ok('改动落在哪个方法', Facts.enclosingNames('@@ -2,2 +2,3 @@\n  void loadOrders(List ids) {\n+    x;\n     y;', 'class A {\n  void loadOrders(List ids) {\n    x;\n    y;\n}').includes('loadOrders'));
  }

  H.section('钩子');
  {
    const s = setup('rc-hook', { autoUpdate: 'off' });
    const j = (input, name) => ({ session_id: 's1', cwd: s.proj, transcript_path: H.transcript(path.join(H.tempDir('rc-t'), 't.jsonl'), [H.tr.user('审查一下')]), hook_event_name: 'PreToolUse', tool_name: name || 'Bash', tool_input: input });
    const up = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.updatedInput;
    const cmd = 'node "' + path.join(s.h.kit, 'tools/review.js').split(path.sep).join('/') + '" run --mode code --project "' + s.proj.split(path.sep).join('/') + '" --base ' + s.base;
    let o = H.hook(s.h, 'guard-commit', j({ command: cmd }));
    H.ok('review.js run：timeout 改成 10 分钟', up(o) && up(o).timeout === 600000 && up(o).command === cmd, o);
    o = H.hook(s.h, 'guard-commit', j({ command: cmd, timeout: 600000 }));
    H.ok('已经写了 10 分钟：不动', !up(o), o);
    o = H.hook(s.h, 'guard-commit', j({ command: cmd, run_in_background: true }));
    H.ok('放后台的：不动', !up(o), o);
    o = H.hook(s.h, 'guard-commit', j({ command: 'git status' }));
    H.ok('别的命令：不动', !up(o), o);
    o = H.hook(s.h, 'guard-ask', j({ subagent_type: 'vk-reviewer', description: 'x', prompt: 'x' }, 'Agent'));
    H.ok('开 vk-reviewer 拦下，说跑 review.js run', /review\.js run/.test(H.reasonOf(o)), o);
    o = H.hook(s.h, 'guard-ask', j({ subagent_type: 'general-purpose', description: 'x', prompt: '审查任务：abc/全量' }, 'Agent'));
    H.ok('别的代理带审查任务也拦', /review\.js run/.test(H.reasonOf(o)), o);
    o = H.hook(s.h, 'guard-ask', j({ subagent_type: 'general-purpose', description: 'x', prompt: '查一下这个目录' }, 'Agent'));
    H.ok('普通子代理不管', !/review\.js run/.test(H.reasonOf(o)), o);
  }

  H.section('安装');
  {
    const h = H.freshHome('rc-inst');
    H.write(path.join(h.cfg, 'agents', 'vk-reviewer.md'), '---\nname: vk-reviewer\ndescription: 用 review.js prepare 输出的提示开\n---\n你是审查者\n');
    H.write(path.join(h.cfg, 'agents', 'my-agent.md'), '---\nname: my-agent\n---\n别人的\n');
    const r = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
    H.ok('安装成功', r.code === 0, r.out.slice(-400) + r.err);
    H.ok('旧的审查代理删了', !fs.existsSync(path.join(h.cfg, 'agents', 'vk-reviewer.md')));
    H.ok('别人的代理还在', fs.existsSync(path.join(h.cfg, 'agents', 'my-agent.md')));
    H.ok('审查的规矩装进套件', fs.existsSync(path.join(h.kit, 'review-prompt.md')));
    const settings = H.read(path.join(h.cfg, 'settings.json')) || '';
    H.ok('不再登记 SubagentStop', !/review-stop/.test(settings));
    H.ok('review-stop.js 还留着（自检按旧名单载）', fs.existsSync(path.join(h.kit, 'hooks', 'review-stop.js')));
    H.ok('约定里说不开子代理', /review\.js run/.test(H.read(path.join(h.kit, 'hook-rules.md')) || ''));
    H.ok('不建 agents 目录也不动别人的', fs.existsSync(path.join(h.cfg, 'agents', 'my-agent.md')));
    H.ok('技能写的是 run', /review\.js" run/.test(H.read(path.join(h.cfg, 'skills', 'vk-cross-review', 'SKILL.md')) || ''));
  }
  {
    // 从装着子代理的 1915 升上来：SubagentStop 的登记要收回，老状态文件要清
    const from1915 = H.baselineDir('20261105.1915');
    if (from1915) {
      const dir = H.tempDir('rc-1915'); H.copyDir(from1915, dir, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(dir);
      const h = H.freshHome('rc-up');
      const old = H.node(h, path.join(dir, 'install.js'), ['--no-router', '--no-open'], { cwd: dir, timeout: 180000 });
      H.ok('旧版装上了，有 SubagentStop', old.code === 0 && /review-stop/.test(H.read(path.join(h.cfg, 'settings.json')) || ''), old.out.slice(-200));
      H.ok('旧版有 vk-reviewer', fs.existsSync(path.join(h.cfg, 'agents', 'vk-reviewer.md')));
      H.write(path.join(h.kit, 'state', 'idea-mcp.json'), '{}');
      const r = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
      const settings = H.read(path.join(h.cfg, 'settings.json')) || '';
      H.ok('升级：SubagentStop 收回了', r.code === 0 && !/SubagentStop/.test(settings) && !/review-stop/.test(settings), settings.slice(0, 300));
      H.ok('升级：vk-reviewer 删了', !fs.existsSync(path.join(h.cfg, 'agents', 'vk-reviewer.md')));
      H.ok('升级：老状态文件清了', !fs.existsSync(path.join(h.kit, 'state', 'idea-mcp.json')));
      H.ok('升级：空的 retired 目录清了', !fs.existsSync(path.join(h.kit, 'retired')));
      H.ok('升级：空的 agents 目录清了', !fs.existsSync(path.join(h.cfg, 'agents')));
      H.ok('升级：别的钩子还在', /guard-commit/.test(settings) && /task-anchor/.test(settings));
    }
  }
  H.done('审查 claude -p');
})().catch((e) => { H.ok('异常', false, e.stack); H.done('审查 claude -p'); });
