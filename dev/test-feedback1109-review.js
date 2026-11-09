'use strict';
/*
 * 20261109 这批的审查改动（docs/feedback-20261109.md）：
 *   #420 审查者报的文件名对不上材料（相对项目的路径、带行号），下一轮把已修的意见原样带回
 *   #422 材料脱敏把 ${YEAR} 这类占位符遮成 ***
 *   #425 复审轮不分批，147 万字进一个请求
 *   #426、#428 角度失败了顶层还是 running；别的审查点的进程活着也算"上一轮在跑"；进程没了还算在跑
 *   #427 不再指定模型（仓库主人 2026-11-09 定的）
 *   第 71 条第 1 点：run --decisions 先登记再复审
 *   未结清单：代码审查一个代码文件都没有时报错
 * 参数：[旧套件目录]（拿上一版跑看多少项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const from = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const KIT = from || H.SRC;
const NO_ISSUE = '```json\n{"issues":[],"need":[],"summary":"看了"}\n```';
const issue = (file, problem) => '```json\n' + JSON.stringify({ issues: [{ severity: 'P2', file, line: 1, problem, evidence: '照着做会出错', fix: '改', scope: 'in' }], need: [], summary: '看了' }) + '\n```';

/** 假的 claude：一行一个回复，用完重复最后一个；SLOW:秒:回复 */
function fakeClaude(h) {
  const bin = path.join(h.root, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const js = path.join(bin, 'fake-claude.js');
  const log = path.join(h.root, 'calls.jsonl'); const plan = path.join(h.root, 'plan.json');
  fs.writeFileSync(js, `const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),prompt:s})+'\\n');
let p=[];try{p=JSON.parse(fs.readFileSync(${JSON.stringify(plan)},'utf8'))}catch(e){}
const n=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(Boolean).length;
let r=p[Math.min(n-1,p.length-1)]||'{"issues":[]}';
const done=()=>{process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:r,usage:{input_tokens:100,output_tokens:50}})+'\\n');process.exit(0)};
if(r.startsWith('SLOW:')){const m=/^SLOW:(\\d+):([\\s\\S]*)$/.exec(r);r=m[2];setTimeout(done,Number(m[1])*1000);return}
done()});`);
  const cmd = path.join(bin, 'claude.cmd');
  fs.writeFileSync(cmd, '@"' + process.execPath + '" "' + js + '" %*\r\n');
  return { cmd, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }, reset: (replies) => { try { fs.unlinkSync(log); } catch (e) { /* 没有 */ } fs.writeFileSync(plan, JSON.stringify(replies)); } };
}
const DOCS = {
  'openspec/changes/c1/proposal.md': '# 提案\n## Why\n要加一个年份占位符。\n## What Changes\n- 标题里的年份换成占位符\n',
  'openspec/changes/c1/design.md': '# 设计\n## 决定\n- 决定 6：按 cells 替换\n',
  'openspec/changes/c1/specs/x/spec.md': '## ADDED Requirements\n### Requirement: 年份\n系统 SHALL 替换年份。\n#### Scenario: 替换\n- **WHEN** 标题里有占位符\n- **THEN** 换成当年\n',
  'openspec/changes/c1/tasks.md': '# 任务\n## 1. 后端\n- [ ] 1.1 改 src/A.java 的替换逻辑（验：mvn test）\n',
};
function setup(name, files, config) {
  const h = H.makeHome(name, from, Object.assign({ reviewSmallChars: 0, autoUpdate: 'off' }, config || {}));
  const fake = fakeClaude(h);
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), Object.assign({ 'src/A.java': 'class A {\n  static final String YEAR_TOKEN = "${YEAR}";\n}\n' }, files || {}));
  const base = H.git(proj, ['rev-parse', 'HEAD']).out.trim();
  const review = (args, extraEnv) => H.node(h, path.join(h.kit, 'tools', 'review.js'), args, { cwd: proj, timeout: 180000, env: Object.assign({ VIBE_KIT_REVIEW_NO_RUN: undefined, VIBE_KIT_CLAUDE_EXE: fake.cmd }, extraEnv || {}) });
  const json = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { return { status: 'bad', raw: (r.out + r.err).slice(-600) }; } };
  const R = () => require(path.join(h.kit, 'lib', 'review-runner.js'));
  const S = () => require(path.join(h.kit, 'lib', 'session.js'));
  return { h, fake, proj, base, review, json, R, S };
}
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); return f; };

(async () => {
  H.section('#420 文件名对不上材料');
  {
    const s = setup('fb1109-420', DOCS);
    const P = ['--change', 'c1', '--mode', 'proposal', '--point', 'tasks', '--project', s.proj];
    // 审查者写的是相对项目的路径（材料的名字是 tasks.md）
    s.fake.reset([issue('openspec/changes/c1/tasks.md', 'Workflow follow-up 没拆成开发库、现场库两步')]);
    const r1 = s.json(s.review(['run'].concat(P)));
    H.ok('第一轮报了一条', r1.status === 'completed' && (r1.issues || []).length === 1, r1);
    H.ok('文件名认成材料里的 tasks.md', r1.issues && r1.issues[0] && r1.issues[0].file === 'tasks.md', r1.issues);
    fs.appendFileSync(path.join(s.proj, 'openspec/changes/c1/tasks.md'), '- [ ] 1.2 开发库、现场库各跑一次（验：手工）\n');
    const dec = writeJson(path.join(s.h.root, 'dec1.json'), { findings: [{ id: 'r1', action: 'fixed', reason: '拆成开发库和现场库两步，见 tasks 1.2' }] });
    const reg = s.json(s.review(['resolve'].concat(P, ['--decisions', dec])));
    H.ok('登记修了', reg.status === 'needs_review', reg);
    s.fake.reset([NO_ISSUE]);
    const r2 = s.json(s.review(['run'].concat(P)));
    const c2 = s.fake.calls();
    H.ok('复审的提示里有上一轮那条（送去核对）', c2[0] && /上一轮的问题[\s\S]*开发库、现场库/.test(c2[0].prompt.split('## 已处理')[0]), c2[0] && c2[0].prompt.slice(0, 1500));
    H.ok('审查者说没问题：不再原样带回', r2.status === 'completed' && (r2.issues || []).length === 0, r2);
  }
  {
    // 上一版存下的快照里文件名是原样的（升级时正审到一半）：下一轮也要认
    const Sc = require(path.join(KIT, 'kit', 'lib', 'review-scope.js'));
    const currents = new Map([['tasks.md', { text: 'a\nb\n', source: 'D:\\w\\proj\\openspec\\changes\\c1\\tasks.md' }], ['specs/x/spec.md', { text: 's\n', source: 'D:\\w\\proj\\openspec\\changes\\c1\\specs\\x\\spec.md' }]]);
    const prior = { files: { 'tasks.md': 'a\n', 'specs/x/spec.md': 's\n' }, issues: [{ id: 'r1', file: 'openspec/changes/c1/tasks.md', line: 1, problem: 'p', severity: 'P2' }, { id: 'r2', file: 'tasks.md:12', line: 12, problem: 'q', severity: 'P2' }, { id: 'r3', file: 'nowhere.md', problem: 'z', severity: 'P2' }], decisions: [{ id: 'r1', action: 'fixed' }, { id: 'r2', action: 'fixed' }, { id: 'r3', action: 'fixed' }], closed: [], covered: ['tasks.md', 'specs/x/spec.md'], round: 1 };
    const plan = Sc.planRound({ currents }, prior);
    H.ok('相对项目的路径、带行号的都送去核对', plan.scoped && plan.open.filter((x) => x.file === 'tasks.md').length === 2, plan.open);
    H.ok('怎么也对不上的修了：也送去核对，不原样带回', plan.open.some((x) => x.file === 'nowhere.md') && !plan.carried.length, plan);
    H.ok('同名的 spec.md 有几个时不乱认', !Sc.matchLabel || Sc.matchLabel('spec.md', new Map([['specs/a/spec.md', {}], ['specs/b/spec.md', {}]])) === 'spec.md');
  }

  H.section('#422 占位符不遮');
  {
    const Rd = require(path.join(KIT, 'kit', 'lib', 'redact.js'));
    H.ok('${YEAR} 照原样', Rd.material('static final String YEAR_TOKEN = "${YEAR}";').includes('"${YEAR}"'));
    H.ok('#{x}、{{x}} 照原样', Rd.material('token: "#{t}" secret="{{ s }}"').includes('#{t}') && Rd.material('secret="{{ s }}"').includes('{{ s }}'));
    H.ok('真口令照遮', Rd.material('password = "abc123"') === 'password = "***"');
    const s = setup('fb1109-422');
    fs.appendFileSync(path.join(s.proj, 'src/A.java'), '// 用 YEAR_TOKEN 替换\n');
    s.fake.reset([NO_ISSUE]);
    s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    const c = s.fake.calls();
    H.ok('送去审的代码里还是 ${YEAR}', c[0] && c[0].prompt.includes('YEAR_TOKEN = "${YEAR}"'), c[0] && c[0].prompt.slice(0, 300));
  }

  H.section('#427 不指定模型');
  {
    const s = setup('fb1109-427');
    fs.appendFileSync(path.join(s.proj, 'src/A.java'), '// x\n');
    s.fake.reset([NO_ISSUE]);
    const r = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    const c = s.fake.calls();
    H.ok('审完', r.status === 'completed', r);
    H.ok('claude -p 不带 --model（用用户默认的模型）', c[0] && !c[0].args.includes('--model'), c[0] && c[0].args.join(' '));
  }

  H.section('#425 复审也分批');
  {
    const line = (i) => '  int field' + i + ' = ' + i + '; // ' + 'x'.repeat(40) + '\n';
    const big = (n) => 'class B' + n + ' {\n' + Array.from({ length: 2000 }, (_, i) => line(i)).join('') + '}\n';
    const files = {}; for (let i = 0; i < 6; i++) files['src/Old' + i + '.java'] = big(i);
    const s = setup('fb1109-425', files);
    // 第一轮：6 个大文件都改一行（审的是全文）
    for (let i = 0; i < 6; i++) fs.appendFileSync(path.join(s.proj, 'src/Old' + i + '.java'), '// 第一轮\n');
    s.fake.reset([NO_ISSUE]);
    const r1 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    H.ok('第一轮审完', r1.status === 'completed', r1);
    // 第二轮：新加 3 个大文件（上一轮没审到，整份审），改动不到六成，按复审走
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(s.proj, 'src/New' + i + '.java'), big(10 + i));
    s.fake.reset([NO_ISSUE]);
    const r2 = s.json(s.review(['run', '--mode', 'code', '--project', s.proj, '--base', s.base]));
    const c2 = s.fake.calls();
    H.ok('第二轮是复审', r2.status === 'completed' && r2.scope === 'changes', r2);
    H.ok('复审放不下：分了几批', c2.length >= 2, c2.length);
    H.ok('每批不超过 24 万字左右', c2.every((x) => x.prompt.length < 300000), c2.map((x) => x.prompt.length));
    H.ok('三个新文件都送到了', ['src/New0.java', 'src/New1.java', 'src/New2.java'].every((f) => c2.some((x) => x.prompt.includes('### ' + f))));
  }

  H.section('#426、#428 状态和"上一轮在跑"');
  {
    const s = setup('fb1109-426', DOCS);
    const P = ['--change', 'c1', '--mode', 'proposal', '--point', 'tasks', '--project', s.proj];
    const prep = s.json(s.review(['prepare'].concat(P), { VIBE_KIT_REVIEW_NO_RUN: '1' }));
    H.ok('备好一轮', prep.status === 'prepared', prep);
    // 后台进程起过、又没了（Claude Code 结束命令时连它一起结束了）
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const S = s.S();
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === prep.id) for (const l of o[k].lenses) o[k].state[l] = { status: 'sent', sentAt: Date.now(), pid: dead }; });
    const R = s.R();
    H.ok('进程没了：不算还在审（不挡提交、不让收工干等）', R.inFlight(path.join(s.proj, 'openspec/changes/c1'), 'proposal') === false);
    const st = s.json(s.review(['status'].concat(P)));
    H.ok('status：角度都没了，顶层也是 failed', st.status === 'failed' && (st.lost || []).length >= 1 && /再跑一次/.test(st.next || ''), st);
    // 别的审查点（整套不带 --point）有进程真在跑：不挡这个点
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === prep.id) for (const l of o[k].lenses) o[k].state[l] = { status: 'sent', sentAt: Date.now(), pid: process.pid }; });
    s.fake.reset([NO_ISSUE]);
    const other = s.json(s.review(['run', '--change', 'c1', '--mode', 'proposal', '--project', s.proj]));
    H.ok('别的审查点的进程活着：这次照样审', other.status === 'completed', other);
    // 同一个点、输入变了、上一轮的进程还活着：说清是哪个、怎么取消
    fs.appendFileSync(path.join(s.proj, 'openspec/changes/c1/design.md'), '- 决定 7：x\n');
    const same = s.json(s.review(['run'].concat(P)));
    H.ok('同一个点：说上一轮在跑，带进程号和取消的写法', same.status === 'running' && /进程 \d+/.test(same.next || '') && /review\.js cancel --change c1 --mode proposal --point tasks/.test(same.next || ''), same);
  }

  H.section('run --decisions');
  {
    const s = setup('fb1109-dec', DOCS);
    const P = ['--change', 'c1', '--mode', 'proposal', '--point', 'tasks', '--project', s.proj];
    s.fake.reset([issue('tasks.md', '任务没写验法')]);
    const r1 = s.json(s.review(['run'].concat(P)));
    H.ok('第一轮报了一条', (r1.issues || []).length === 1, r1);
    fs.appendFileSync(path.join(s.proj, 'openspec/changes/c1/tasks.md'), '- [ ] 1.2 补验法（验：mvn test）\n');
    const dec = writeJson(path.join(s.h.root, 'dec.json'), { findings: [{ id: 'r1', action: 'fixed', reason: '1.2 补了验法，写了 mvn test' }] });
    s.fake.reset(['SLOW:4:' + NO_ISSUE]);
    const r2 = s.json(s.review(['run'].concat(P, ['--decisions', dec, '--wait', '1'])));
    H.ok('一条命令：先登记，接着复审', r2.resolved && r2.resolved.status === 'needs_review' && ['running', 'completed'].includes(r2.status), r2);
    const r3 = s.json(s.review(['run'].concat(P, ['--decisions', dec, '--wait', '60'])));
    H.ok('返回 running 后再跑一次一样的命令：不再登记，接着等到结果', r3.status === 'completed' && (r3.issues || []).length === 0, r3);
    H.ok('复审只发了一个请求', s.fake.calls().length === 1, s.fake.calls().length);
    // 全部驳回：只登记，不复审
    s.fake.reset([issue('design.md', '决定 6 写得不清楚')]);
    fs.appendFileSync(path.join(s.proj, 'openspec/changes/c1/design.md'), '- 决定 8：y\n');
    const r4 = s.json(s.review(['run'].concat(P)));
    const rej = writeJson(path.join(s.h.root, 'rej.json'), { findings: (r4.issues || []).map((x) => ({ id: x.id, action: 'rejected', reason: '决定 6 写的是 renderedCells，意思清楚' })) });
    s.fake.reset([NO_ISSUE]);
    const r5 = s.json(s.review(['run'].concat(P, ['--decisions', rej])));
    H.ok('全部驳回：只登记，不发请求', r5.status === 'resolved' && s.fake.calls().length === 0 && /没有要复审的/.test(r5.next || ''), r5);
  }

  H.section('run --decisions 里有"接受不改"：照样要用户的决定');
  {
    const s = setup('fb1109-acc', DOCS);
    const dec = writeJson(path.join(s.h.root, 'acc.json'), { findings: [{ id: 'r1', action: 'accepted', reason: '用户说这条不改，原因写在 design 里' }] });
    const j = (cmd) => ({ session_id: 'acc1', cwd: s.proj, transcript_path: H.transcript(path.join(H.tempDir('fb1109-t'), 't.jsonl'), [H.tr.user('审查一下')]), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } });
    const tool = path.join(s.h.kit, 'tools/review.js').split(path.sep).join('/');
    const o = H.hook(s.h, 'guard-commit', j('node "' + tool + '" run --change c1 --mode proposal --point tasks --project "' + s.proj.split(path.sep).join('/') + '" --decisions "' + dec.split(path.sep).join('/') + '"'));
    H.ok('用户没说不改：拦下', /审查决定/.test(H.reasonOf(o)), o);
  }

  H.section('代码审查没有代码改动');
  {
    const s = setup('fb1109-nocode', DOCS);
    const S = s.S();
    // 开工基线记在现在：代码改动都在基线之前
    S.updateState('work-baselines', (o) => { o[S.normKey(path.join(s.proj, 'openspec/changes/c1'))] = { at: Date.now(), born: S.changeBorn(path.join(s.proj, 'openspec/changes/c1')), repos: [{ root: s.proj, ref: s.base, dirtyFiles: [] }] }; });
    s.fake.reset([NO_ISSUE]);
    const r = s.json(s.review(['run', '--change', 'c1', '--mode', 'code', '--project', s.proj]));
    H.ok('报错说没有代码改动，给 --base 和 --docs-only 的写法', r.status === 'failed' && /没有代码改动可审/.test(r.reason || '') && /--docs-only/.test(r.reason || ''), r);
    H.ok('没发请求', s.fake.calls().length === 0);
    const r2 = s.json(s.review(['run', '--change', 'c1', '--mode', 'code', '--project', s.proj, '--docs-only']));
    H.ok('加 --docs-only：照样审需求文档', r2.status === 'completed', r2);
  }
  H.done('20261109 审查');
})().catch((e) => { H.ok('异常', false, e.stack); H.done('20261109 审查'); });
