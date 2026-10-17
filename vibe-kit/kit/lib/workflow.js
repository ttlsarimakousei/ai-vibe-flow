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
function facts(root, j) {
  root = path.resolve(root); const changes = S.allChanges(root).map((c) => { const tasks = T.tasks(c.dir); return { name: c.name, done: tasks.filter((t) => t.done).length, total: tasks.length, next: T.automatedLeft(c.dir).slice(0, 1).map((t) => t.text), review: require('./review-runner').stateFor(c.dir, 'code').status, userPending: tasks.some((t) => t.kind === 'user' && !t.done) }; });
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
  return { mode: cfg.autoCommit, effectiveAuto: cfg.autoMode, at: Date.now(), repositories: roots.map((r) => ({ root: r, branch: W.git(r, ['branch', '--show-current']).trim(), fingerprint: W.fingerprint(r, 'all').hash, files: W.git(r, ['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3)), existingChanges: [...new Set(baselines.filter((b) => S.normKey(b.root) === S.normKey(r)).flatMap((b) => b.dirtyFiles || []))], verification: require('./evidence').commands(r), review: S.allChanges(r).map((c) => ({ change: c.name, ready: T.readyForReview(c.dir), reviewed: S.codeReviewed(c.dir), tasks: T.tasks(c.dir).filter((t) => t.done && !['review', 'review-fix', 'user'].includes(t.kind)).map((t) => t.text) })) })), confirmation: cfg.autoMode && cfg.autoCommit !== 'off' ? '仅当前明确 apply 范围按档位提交，纯审查轮次不单独提交；已有改动先确认归属，不整文件混入' : '普通任务与提案提交先交代结果，用户确认后提交；apply、归档、push 各自授权' };
}
function selfTest(root) { const f = facts(root); return { services: f.services, verified: f.evidence, pending: f.changes.filter((c) => c.userPending), limits: '服务记录仅核对进程存活，接口和页面预期来自已确认规格；只列实际执行的用例和结果；用户放弃的自测不列未测试或待办，也不冒充通过。交付验收用例供用户自行测试。' }; }
module.exports = { facts, brief, services, deliver, taskTemplate, decisionIssues, commitPlan, selfTest };
