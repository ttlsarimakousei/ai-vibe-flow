'use strict';
/* 开工、自测和恢复只读本机事实。可交付材料写在变更目录；提交计划把检查和许可分开，不自动提交、不擅自补需求。 */
const fs = require('fs');
const path = require('path');
const S = require('./session');
const W = require('./workspace');
const T = require('./task-types');
const R = require('./redact');
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch (e) { return false; } }
function services(root) { const out = []; for (const r of [root].concat(S.isShell(root) ? S.nestedRepos(root) : [])) { const dir = path.join(r, '.vibe', 'run'); let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { continue; } for (const f of names) try { const rec = JSON.parse(read(path.join(dir, f))); out.push({ name: rec.name, root: r, port: rec.port, url: 'http://127.0.0.1:' + rec.port, backend: rec.backendUrl || '', owner: 'devserver', processAlive: alive(rec.pid) }); } catch (e) { /* 损坏记录不冒充服务 */ } } return out; }
/** 代码审查到哪了：none 没审过，running 有角度在跑，completed 每个点都审过了，open 还有没收尾的 */
function reviewStatus(dir) {
  const P = require('./flow-policy'); const points = P.points(dir, 'code');
  if (require('./review-runner').inFlight(dir, 'code')) return 'running';
  // 先看过没过：旧版按组审完的 change 没有整个 change 的记录，也算审过
  if (points.length && points.every((p) => P.settled(dir, p))) return 'completed';
  return points.some((p) => P.record(dir, p).status) ? 'open' : 'none';
}
function facts(root, j) {
  root = path.resolve(root); const changes = S.allChanges(root).map((c) => { const tasks = T.tasks(c.dir); return { name: c.name, done: tasks.filter((t) => t.done).length, total: tasks.length, next: T.automatedLeft(c.dir).slice(0, 1).map((t) => t.text), review: reviewStatus(c.dir), userPending: tasks.some((t) => t.kind === 'user' && !t.done) }; });
  return { root, branch: W.git(root, ['branch', '--show-current']).trim(), dirty: W.git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length, changes, services: services(root), evidence: require('./evidence').current(root).map((e) => ({ kind: e.kind, command: e.command, at: e.at })), flow: j ? S.flowView(j) : null };
}
function brief(root, j) { const f = facts(root, j); return '[本机事实] 分支 ' + (f.branch || '无 Git') + '，未提交文件 ' + f.dirty + '；' + (f.changes.length ? f.changes.map((c) => c.name + ' ' + c.done + '/' + c.total + '，审查 ' + c.review + (c.userPending ? '，等用户验收' : '')).join('；') : '没有活动变更') + '。当前有效验证 ' + f.evidence.length + ' 项。历史交接不授予 apply、提交、归档或 push 许可。'; }
// 任务清单只写实现任务，不写"验："（用户 2026-10-17 定的）；测试和验收写在 design.md 的"验收用例"一节
function taskTemplate() { return '## 1. 实现\n- [ ] 1.1 实现已确认需求：<代码文件>。\n\n## 2. 交付\n- [ ] 2.1 交付需求明确要求的材料：<文件路径>。\n'; }
function decisionIssues(dir) {
  const files = S.artifactFiles(dir).filter((f) => !/revisions\.md$/.test(f)); const declared = new Set(); const used = new Set();
  for (const f of files) { const text = read(f); for (const m of text.matchAll(/\[决策:([A-Za-z0-9_-]+)\]/g)) declared.add(m[1]); for (const m of text.matchAll(/\[依据:([A-Za-z0-9_-]+)\]/g)) used.add(m[1]); }
  return [...used].filter((id) => !declared.has(id)).map((id) => '决策依据未声明：' + id);
}
function deliver(root, name) {
  const c = S.allChanges(root).find((x) => x.name === name); if (!c) throw new Error('没找到变更');
  const a = S.artifactOf(path.join(c.dir, 'proposal.md')); const issues = require('./proposal-files').changeIssues(a).concat(decisionIssues(c.dir)); if (issues.length) throw new Error(issues.join('；'));
  const files = S.artifactFiles(c.dir).filter((f) => !/revisions\.md$/.test(f)).map((f) => path.relative(c.dir, f).replace(/\\/g, '/'));
  let decisions = ''; try { const x = JSON.parse(read(path.join(c.dir, 'decisions.json'))); if (Array.isArray(x.items)) decisions = x.items.map((d) => '| ' + R.text(d.kind || '待分类') + ' | ' + R.text(d.text || '') .replace(/\|/g, '／') + ' | ' + (d.confirmed === true ? '已确认' : '待用户确认') + ' |').join('\n'); } catch (e) { /* 没有时明确待确认，不虚构已批准 */ }
  const text = '# 提案交付\n\n实施输入均相对于本目录，必要非敏感材料放 assets/ 或 references/ 并纳入 Git。\n\n' + files.map((f) => '- [' + f + '](' + f + ')').join('\n') + '\n\n| 类别 | 内容 | 状态 |\n|---|---|---|\n' + (decisions || '| 需求差异 | 用户要求、现状约束、实现细节、新增业务行为、本次不做逐项列入 decisions.json 或 proposal.md | 待用户核对 |') + '\n\n任务类型缺项：' + (T.needs(read(path.join(c.dir, 'tasks.md'))).join('、') || '没有') + '。验收用例在需求阶段准备，在设计阶段补齐输入、环境、步骤和预期。人工审查和自测先 Ask，放弃不记待办。\n';
  const file = path.join(c.dir, 'delivery.md'); if (!require('./state-store').atomicText(file, text)) throw new Error('提案交付说明未能保存'); return { file, files, confirmationRequired: !decisions };
}
function commitPlan(root, j) {
  const cfg = S.readConfigFor(j || { cwd: root }); const roots = S.isShell(root) ? S.nestedRepos(root) : [W.rootOf(root)];
  const baselines = Object.values(S.readState('work-baselines')).flatMap((b) => b.repos || []);
  return { mode: S.commitModeOf(cfg), effectiveAuto: cfg.autoMode, at: Date.now(), repositories: roots.map((r) => ({ root: r, branch: W.git(r, ['branch', '--show-current']).trim(), fingerprint: W.fingerprint(r, 'all').hash, files: W.git(r, ['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3)), existingChanges: [...new Set(baselines.filter((b) => S.normKey(b.root) === S.normKey(r)).flatMap((b) => b.dirtyFiles || []))], verification: require('./evidence').commands(r), review: S.allChanges(r).map((c) => ({ change: c.name, ready: T.readyForReview(c.dir), reviewed: S.codeReviewed(c.dir), tasks: T.tasks(c.dir).filter((t) => t.done && !['review', 'review-fix', 'user'].includes(t.kind)).map((t) => t.text) })) })), confirmation: cfg.autoMode && cfg.autoCommit !== 'off' ? '仅当前明确 apply 范围按档位提交，纯审查轮次不单独提交；已有改动先确认归属，不整文件混入' : '普通任务与提案提交先交代结果，用户确认后提交；apply、归档、push 各自授权' };
}
function selfTest(root) { const f = facts(root); return { services: f.services, verified: f.evidence, pending: f.changes.filter((c) => c.userPending), limits: '服务记录仅核对进程存活，接口和页面预期来自已确认规格；只列实际执行的用例和结果；用户放弃的自测不列未测试或待办，也不冒充通过。交付验收用例供用户自行测试。' }; }
/**
 * 全面自测登记（用户 2026-11-03 定的）：所有 change 的任务做完才行；每条用例要有结果，有没过的不登记；真跑过命令才算（本机证据）。
 * results：[{ case, result: 'pass' | 'fail' | 'manual', note }]。登记了就进人工核验；之后改了代码退回（verify-gate 比 code 指纹）。
 */
function taskSelfTest(root, name, resultsFile) {
  const B = require('./big-task');
  const task = B.named(root, name); if (!task) throw new Error('没有叫 ' + name + ' 的大任务（openspec/plan.md）');
  const phase = B.phaseOf(task).phase;
  if (phase === 'explore' || phase === 'plan' || phase === 'apply') throw new Error('还有 change 没做完（' + B.progressText(task) + '），全部做完才全面自测');
  let list; try { list = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch (e) { throw new Error('结果文件读不了，要 JSON 数组：[{"case":"AC-01","result":"pass","note":"实际结果"}]'); }
  if (!Array.isArray(list) || !list.length) throw new Error('结果文件是空的：每条用例写一条，[{"case":"AC-01","result":"pass","note":"实际结果"}]');
  const bad = list.filter((x) => !x || !x.case || !['pass', 'fail', 'manual'].includes(x.result));
  if (bad.length) throw new Error('有 ' + bad.length + ' 条写法不对：case、result（pass、fail、manual）都要有');
  const fail = list.filter((x) => x.result === 'fail');
  if (fail.length) return { ok: false, failed: fail.map((x) => x.case), next: '有没过的用例：改完记进对应 change 的 revisions.md，重跑受影响 change 的用例和整体用例，再登记。' };
  const cwdRoot = path.dirname(task.osDir);
  let ran = 0; try { ran = require('./evidence').commands(cwdRoot).length; } catch (e) { ran = 0; }
  const auto = list.filter((x) => x.result === 'pass').length;
  if (auto && !ran) throw new Error('这个项目里还没有本机跑过的验证命令记录，说 pass 对不上：先真跑用例（测试命令、接口、页面场景）再登记');
  B.setTaskState(task, { selfTest: { at: Date.now(), count: list.length, code: W.fingerprint(cwdRoot, 'code').hash, manual: list.filter((x) => x.result === 'manual').map((x) => x.case) } });
  return { ok: true, count: list.length, next: '全面自测登记了。把测试清单、实际结果、' + (B.suggestions(task).length ? '范围外建议、' : '') + '留给人工的用例交给用户，等用户人工核验，用户说归档才归档。' };
}
/**
 * 表外的 change（不归哪个大任务）的自测登记（第 86 条，2026-11-12）：自动实施做到最后要全面自测，全过了套件才关自动。
 * 和大任务的一样：任务全部做完才行；每条用例要有结果，有没过的不登记；说 pass 要有本机跑过的命令。登记之后改了代码就作废（比代码指纹）
 */
function changeSelfTest(root, name, resultsFile) {
  const c = S.allChanges(root).find((x) => x.name === name);
  if (!c) throw new Error('没有叫 ' + name + ' 的变更（openspec/changes/ 下没归档的）');
  const left = T.automatedLeft(c.dir);
  if (!T.tasks(c.dir).length || left.length) throw new Error(name + ' 的任务还没做完（还有 ' + left.length + ' 项），全部做完才自测');
  let list; try { list = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch (e) { throw new Error('结果文件读不了，要 JSON 数组：[{"case":"AC-01","result":"pass","note":"实际结果"}]'); }
  if (!Array.isArray(list) || !list.length) throw new Error('结果文件是空的：每条用例写一条，[{"case":"AC-01","result":"pass","note":"实际结果"}]');
  const bad = list.filter((x) => !x || !x.case || !['pass', 'fail', 'manual'].includes(x.result));
  if (bad.length) throw new Error('有 ' + bad.length + ' 条写法不对：case、result（pass、fail、manual）都要有');
  const fail = list.filter((x) => x.result === 'fail');
  if (fail.length) return { ok: false, failed: fail.map((x) => x.case), next: '有没过的用例：改完记进 ' + name + ' 的 revisions.md，重跑用例，再登记。' };
  const projectRoot = path.resolve(c.dir, '../../..');
  let ran = 0; try { ran = require('./evidence').commands(projectRoot).length; } catch (e) { ran = 0; }
  if (list.some((x) => x.result === 'pass') && !ran) throw new Error('这个项目里还没有本机跑过的验证命令记录，说 pass 对不上：先真跑用例（测试命令、接口、页面场景）再登记');
  require('./auto-run').noteChangeTest(c.dir, W.fingerprint(projectRoot, 'code').hash, list.filter((x) => x.result === 'manual').map((x) => x.case));
  return { ok: true, count: list.length, next: '自测登记了。把测试清单、实际结果、留给人工的用例交给用户，等用户核验，用户说归档才归档。' };
}
/** 归档前预演：拷 openspec/ 到临时目录，按表的顺序跑一遍归档，全过才记下来（改名对不上这种到归档才报错，停在一半，用户 2026-11-03 定的） */
function archiveCheck(root, name) {
  const B = require('./big-task');
  const task = B.named(root, name); if (!task) throw new Error('没有叫 ' + name + ' 的大任务（openspec/plan.md）');
  const projectRoot = path.dirname(task.osDir);
  const tmp = path.join(projectRoot, '.vibe', 'tmp', 'archive-check-' + task.name.replace(/[\\/:*?"<>|\s]+/g, '-'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.cpSync(task.osDir, path.join(tmp, 'openspec'), { recursive: true });
  const O = require('./openspec');
  const failed = [];
  try {
    for (const c of task.changes) {
      if (c.archived) continue;
      // 自带的用不了（Node 版本不够）退回用户自己装的，和钩子改写命令的规矩一样
      const opts = { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 120000, input: '', env: Object.assign({}, process.env, { OPENSPEC_TELEMETRY: '0' }) };
      const r = O.usable() ? require('child_process').spawnSync(process.execPath, [O.BIN, 'archive', c.name, '-y'], opts) : require('child_process').spawnSync('openspec archive ' + c.name + ' -y', Object.assign({ shell: true }, opts));
      if (r.status !== 0) { failed.push({ change: c.name, why: String(r.stdout || '').concat(r.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(at |Node\.js v|\}$)/.test(l)).slice(-5).join(' ').slice(0, 400) }); break; }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (failed.length) return { ok: false, failed, next: '预演没过，真目录没动：' + failed[0].change + '：' + failed[0].why + '。改对应 change 的文档（前面改了需求名的，后面对齐），再预演。' };
  B.setTaskState(task, { archiveCheck: { at: Date.now(), specs: B.specsHash(task) } });
  return { ok: true, order: task.changes.filter((c) => !c.archived).map((c) => c.name), next: '预演过了，按这个顺序归档。' };
}
module.exports = { facts, brief, services, deliver, taskTemplate, decisionIssues, commitPlan, selfTest, taskSelfTest, changeSelfTest, archiveCheck };
