'use strict';
/* 两阶段工作流：自动条件、逐产物/任务组审查点、人工 Ask 与提示去重。只保存套件本机状态，不把执行安排写进团队任务。 */
const fs = require('fs');
const path = require('path');
const S = require('./session');
const W = require('./workspace');
const T = require('./task-types');
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const key = (dir, point) => S.normKey(dir) + '|' + point;
function groups(dir) {
  const out = new Map();
  for (const t of T.tasks(dir).filter(t => !['review', 'review-fix', 'user', 'deferred'].includes(t.kind))) {
    const m = t.text.match(/^(\d+)\./); if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], []); out.get(m[1]).push(t);
  }
  return [...out].map(([id, tasks]) => ({ id: 'group-' + id, tasks, done: tasks.every(t => t.done) }));
}
function points(dir, mode) {
  if (mode === 'code') return groups(dir).filter(g => g.done).map(g => g.id);
  const files = S.artifactFiles(dir);
  return ['proposal', 'specs', 'design', 'tasks'].filter(p => files.some(f => p === 'specs' ? /[\\/]specs[\\/]/.test(f) : path.basename(f) === p + '.md'));
}
function pointFiles(dir, point) {
  const files = S.artifactFiles(dir).filter(f => !/revisions\.md$/.test(f));
  const order = ['proposal', 'specs', 'design', 'tasks']; const rank = order.indexOf(point);
  if (rank >= 0) return files.filter(f => { const p = /[\\/]specs[\\/]/.test(f) ? 'specs' : path.basename(f, '.md'); return order.indexOf(p) >= 0 && order.indexOf(p) <= rank; });
  const group = groups(dir).find(g => g.id === point); if (!group) return files;
  const roots = S.projectRootsOf(dir); const code = new Set();
  for (const t of group.tasks) for (const token of S.pathTokens(t.text.split(/(?:验|验证|验收)\s*[:：]/)[0])) {
    for (const root of roots) { const f = path.resolve(root, token); const checked = W.pathStatus(f, root); if (checked.safe && !checked.missing && !/[\\/](?:openspec|\.vibe)[\\/]/.test(f)) code.add(f); }
  }
  return [...code];
}
function fingerprint(dir, point) {
  const group = groups(dir).find(g => g.id === point); const files = pointFiles(dir, point);
  const rows = files.map(f => [S.normKey(f), W.hash(path.basename(f) === 'tasks.md' ? W.progressText(read(f)) : read(f))]);
  if (group) {
    rows.push(['任务', group.tasks.map(t => t.text)]);
    for (const f of pointFiles(dir, 'design')) rows.push([S.normKey(f), W.hash(read(f))]);
    if (!files.length) rows.push(['代码', W.fingerprint(dir, 'code').hash]);
  }
  return W.hash(JSON.stringify(rows));
}
function record(dir, point) { return S.readState('review-points')[key(dir, point)] || {}; }
function passed(dir, point) { const r = record(dir, point); return r.status === 'completed' && r.issues === 0 && r.fingerprint === fingerprint(dir, point) && require('./review-runner').inputsCurrent(r.materialInputs); }
function settled(dir, point) { const r = record(dir, point); return passed(dir, point) || r.status === 'resolved' && r.resolvedFingerprint === fingerprint(dir, point) && require('./review-runner').inputsCurrent(r.materialInputs); }
function pending(dir, mode) { return points(dir, mode).find(p => !settled(dir, p)) || ''; }
function allPassed(dir, mode) { const ps = points(dir, mode); return ps.length > 0 && ps.every(p => settled(dir, p)); }
function limit(cfg, mode) { return Math.min(20, Math.max(1, Number(mode === 'proposal' ? cfg.requirementsReviewMaxRounds : cfg.applyReviewMaxRounds) || 3)); }
function begin(dir, point, id, inputHash) {
  S.updateState('review-points', o => { const k = key(dir, point); const previous = o[k] || {}; o[k] = { rounds: (previous.rounds || 0) + 1, status: 'running', key: id, fingerprint: inputHash, at: Date.now() }; });
}
function noteResult(dir, point, result, inputHash) {
  S.updateState('review-points', o => { const k = key(dir, point); const previous = o[k] || {}; o[k] = { rounds: (previous.rounds || 0) + (previous.key === result.id && previous.status === 'running' ? 0 : 1), status: result.status, issues: result.issues.length, fingerprint: inputHash, report: result.file, key: result.id, materialInputs: result.materialInputs, at: Date.now() }; });
}
function qualify(j, assessment) {
  if (!j.session_id || j.session_id === 'unknown') throw new Error('自动条件评估需要当前会话编号');
  const cfg = S.readConfig(); if (!cfg.autoRequirements) throw new Error('需求自动模式未开启');
  const a = assessment || {}; const fields = ['description', 'scope', 'acceptance'];
  if (fields.some(k => typeof a[k] !== 'string' || a[k].trim().length < 6) || !Array.isArray(a.unresolved)) throw new Error('自动条件评估需要 description、scope、acceptance 和 unresolved；先探索并明确用户要求');
  const entries = j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : [];
  const st = S.flowState(j); const since = Number(st.explorationAt) || 0;
  const explored = S.toolCalls(entries.filter(e => !since || (Date.parse(e.timestamp || '') || 0) >= since), 0);
  if (!S.lastUserVoice(entries) || !S.projectReads(explored).length) throw new Error('还没有用户描述或实际探索记录，先读相关代码并沟通');
  const ready = a.unresolved.length === 0;
  S.updateState(j.session_id + '-flow', st => { st.planReady = ready; st.planAssessment = { description: a.description, scope: a.scope, acceptance: a.acceptance, unresolved: a.unresolved, onlyPlan: a.onlyPlan === true, at: Date.now() }; st.waiting = ready ? '' : '需求仍有疑问'; });
  return { ready, next: ready ? '逐个产物完成审修，验收用例随需求和设计完善' : '先用 Ask 沟通 unresolved，明确后重新评估' };
}
function automaticApply(j) {
  const cfg = S.readConfig(); const st = S.flowState(j);
  if (!cfg.autoRequirements || !cfg.autoApply || !st.planReady || st.stage !== 'plan' || st.waiting || st.planAssessment && st.planAssessment.onlyPlan) return false;
  const changes = S.allChanges(j.cwd).filter(c => S.flowChanges(j).includes(S.normKey(c.dir)));
  if (changes.length !== 1) return false;
  const c = changes[0]; if (points(c.dir, 'proposal').length !== 4 || !allPassed(c.dir, 'proposal')) return false;
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  try { if (!W.checkedGit(root, ['ls-files', '--', rel + '/tasks.md']).trim() || W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim()) return false; } catch (e) { return false; }
  if (!require('./apply-scope').grant(j, c.name, '').ok) return false;
  S.setFlow(j, true, '两阶段自动：文档逐点审修并定稿提交后开工', 'apply'); return true;
}
function planNext(j, c) {
  const root = path.resolve(c.dir, '../../..'); const rel = path.relative(root, c.dir).replace(/\\/g, '/');
  let dirty; try { dirty = W.checkedGit(root, ['status', '--porcelain', '--', rel]).trim(); } catch (e) { return ''; }
  if (dirty) return once(j, 'plan-commit|' + c.dir, fingerprint(c.dir, 'tasks'), '同一套需求文档已定稿，提交本变更的产物和用例一次 docs: 提案 ' + c.name + '。');
  const st = S.flowState(j);
  if (st.planAssessment && st.planAssessment.onlyPlan) return '';
  return once(j, 'plan-apply|' + c.dir, fingerprint(c.dir, 'tasks'), '文档已经定稿提交。用 Ask 给出“执行 apply / 继续修改 / 暂不执行”的选项。');
}
function instruction(dir, point, cfg) {
  const mode = point.startsWith('group-') ? 'code' : 'proposal'; const rec = record(dir, point); const max = limit(cfg, mode);
  if ((rec.rounds || 0) >= max) return '当前审查点 ' + point + ' 已达到 ' + max + ' 轮上限且尚未通过，停止自动循环并报告问题；用户主动要求仍可继续审查。';
  return '审查点 ' + point + '：执行 review.js run --change ' + path.basename(dir) + ' --mode ' + mode + ' --point ' + point + '。自动核验、修改、复验，最多 ' + max + ' 轮；当前已经 ' + (rec.rounds || 0) + ' 轮。需求变化先沟通并同步相关产物和用例。';
}
function entriesOf(j) { return j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : []; }
function explicit(j, action) { return S.userSaid(entriesOf(j), action).ok; }
// 提示只记发过哪条，不生成“未审查/未测试”任务，也不登记放弃状态。
function once(j, id, signature, text) {
  if (!j.session_id) return text;
  let fresh = false; S.updateState(j.session_id + '-workflow-prompts', o => { if (o[id] !== signature) { o[id] = signature; fresh = true; } });
  return fresh ? text : '';
}
function stop(j, touched, codeChanged) {
  const cfg = S.readConfigFor(j); const out = [];
  const dirs = [...new Set([...touched, ...S.flowChanges(j)].filter(d => fs.existsSync(d)))];
  for (const dir of dirs) {
    const mode = S.flowStage(j) === 'apply' ? 'code' : 'proposal'; const point = cfg.autoMode ? pending(dir, mode) : points(dir, mode).slice().reverse().find(p => !settled(dir, p));
    if (!point) continue;
    if (!cfg.autoMode) {
      const msg = once(j, key(dir, point), fingerprint(dir, point), '当前 ' + path.basename(dir) + ' 的 ' + point + ' 已完成。用 Ask 问是否审查' + (mode === 'code' ? '、是否按验收用例自测' : '') + '，用户已明确要求的直接执行。选择放弃就继续，不写未审查或未测试记录、不催补做。审查后先展示全部问题，再逐条 Ask：改（推荐）/不改/自行输入；复验前另问。');
      if (msg) out.push(msg);
    } else { const msg = once(j, key(dir, point), fingerprint(dir, point) + ':' + (record(dir, point).rounds || 0), instruction(dir, point, cfg)); if (msg) out.push(msg); }
  }
  if (!cfg.autoMode && codeChanged && !dirs.length && !explicit(j, 'test')) {
    const msg = once(j, 'plain-test', W.fingerprint(j.cwd, 'code').hash, '本次代码已修改。用 Ask 询问是否审查、是否按验收用例自测；放弃后直接继续，不记待办、不反复提醒。'); if (msg) out.push(msg);
  }
  return out;
}
function actionIssue(j) {
  const cfg = S.readConfigFor(j); let inp = j.tool_input || {}; let name = String(j.tool_name || '');
  // IDEA 的 execute_tool 按路由里的实际工具判断：转发的编译、检查同样要人工许可。
  if (/^mcp__.+__execute_tool$/.test(name)) { const r = require('./idea-tools').route(inp.command); if (r) { name = name.replace(/execute_tool$/, r.name); inp = r.input; } }
  const cmd = String(inp.command || '');
  const review = /^(Agent|Task)$/.test(name) && /(?:ttls|vibe)-reviewer/.test(inp.subagent_type || '') || /review\.js["']?\s+run\b/.test(cmd) || name === 'Skill' && /cross-review/.test(inp.skill || '');
  const shellTest = /^(Bash|PowerShell)$/.test(name) && testCommand(cmd, name === 'PowerShell');
  // IDEA 的编译、文件检查、lint 是快检，直接跑；运行配置会起程序或跑测试，算自测。
  const test = !review && (shellTest || /execute_run_configuration/.test(name) || name === 'Skill' && /see-page/.test(inp.skill || ''));
  if (!review && !test) return '';
  if (cfg.autoMode) {
    if (review) {
      if (!/review\.js["']?\s+run\b/.test(cmd)) return '自动逐点审查使用 review.js 的有限材料请求，不启动兼容代理；先确定当前 --point。';
      const m = cmd.match(/--change\s+["']?([^\s"']+)/); const p = cmd.match(/--point\s+([\w-]+)/);
      const change = m && S.allChanges(j.cwd).find(c => c.name === m[1]);
      const mode = /--mode\s+proposal/.test(cmd) ? 'proposal' : 'code';
      if (change && !p) return '自动审查必须指定当前审查点 --point ' + (pending(change.dir, mode) || (mode === 'proposal' ? 'tasks' : 'group-1'));
      if (change && p && (record(change.dir, p[1]).rounds || 0) >= limit(cfg, mode)) {
        const permit = require('./permissions').allow(j, 'review', change.dir, j.tool_use_id);
        if (!permit.ok) return '该审查点已达到自动审查上限，停止自动循环并报告；用户主动要求可继续。' + permit.reason;
      }
    }
    return '';
  }
  if (review && /--new-budget\b/.test(cmd) && explicit(j, 'reviewBudget')) return '';
  if (explicit(j, review ? 'review' : 'test')) {
    if (!review) return '';
    const permit = require('./permissions').allow(j, 'review', j.cwd, j.tool_use_id);
    if (permit.ok) return '';
  }
  return '人工模式：先用 Ask 询问是否' + (review ? '审查' : '自测或复验') + '及范围，得到用户明确要求后执行。用户放弃就继续，不记录未审查、未测试或待办。';
}
// 人工模式要先 Ask 的"自测"：跑测试、起服务、看页面。编译、类型检查、静态检查算写代码的一部分，直接跑（用户 2026-10-16 定的）。
function testCommand(cmd, ps) {
  const G = require('../hooks/guard-commit');
  return G.splitCommand(G.preprocess(cmd, ps).s, ps).flat().some(seg => selfTestWords(G.words(seg, ps).map(w => w.text)));
}
const SCRIPT_EXT = /\.(?:[cm]?js|ts|py)$/i;
// 脚本只看文件名，目录只认 test、tests、__tests__、spec：test-package/publish.js 不是自测
function testScript(file) {
  const parts = String(file).replace(/[\\/]+$/, '').split(/[\\/]+/); const name = parts[parts.length - 1];
  return parts.slice(0, -1).some(d => /^(?:tests?|__tests__|spec)$/i.test(d)) || SCRIPT_EXT.test(name) && /(?:^|[-_.])(?:tests?|spec|scenario|probe)(?:[-_.]|$)/i.test(name.replace(SCRIPT_EXT, ''));
}
function selfTestWords(words) {
  const base = w => path.basename(String(w || '')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  let ws = words.slice();
  // 前面的环境变量赋值、env / cross-env 包一层的，看里面真正跑的命令
  for (let k = 0; ;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k] || '')) { k++; continue; }
    if (/^(?:env|cross-env)$/.test(base(ws[k]))) { k++; while (/^-/.test(ws[k] || '')) { if (/^(?:-C|--chdir|-u|--unset)$/.test(ws[k])) k++; k++; } continue; }
    ws = ws.slice(k); break;
  }
  let exe = base(ws[0]); let args = ws.slice(1);
  if (/^(?:npx|pnpx)$/.test(exe)) { args = args.filter(a => !/^(?:-y|--yes|--no-install)$/.test(a)); exe = base(args[0]); args = args.slice(1); }
  if (/^(?:pytest|jest|vitest|mocha|ava|karma|cypress)$/.test(exe)) return true;
  if (exe === 'playwright') return args.includes('test');
  // 后面跟目录、文件、模块名的开关，它的取值不当子命令
  const plainOf = (valued) => { const out = []; for (let i = 0; i < args.length; i++) { if (valued.test(args[i])) { i++; continue; } if (!/^-/.test(args[i])) out.push(args[i].toLowerCase()); } return out; };
  if (/^(?:npm|pnpm|yarn)$/.test(exe)) {
    const w = plainOf(/^(?:--prefix|--cwd|--dir|-C|--filter|-F|--workspace|-w)$/); const sub = w[0] || '';
    const script = /^(?:run|run-script|rum|urn)$/.test(sub) ? w[1] || '' : sub;
    return /^(?:t|tst|test)$/.test(sub) || /^(?:test|e2e|cypress|playwright)(?:[:_-].*)?$/.test(script) || /^(?:dev|start|serve|preview)(?:[:_-].*)?$/.test(script);
  }
  if (/^mvnw?$/.test(exe)) {
    const goals = plainOf(/^(?:-f|--file|-pl|--projects|-s|--settings|-gs|--global-settings|-rf|--resume-from|-T|--threads|-t|--toolchains|-l|--log-file|-P|--activate-profiles|-D|--define)$/);
    const skip = args.some(a => /^-D(?:skipTests|maven\.test\.skip)(?:=true)?$/i.test(a));
    return goals.some(g => /^[\w.-]+:(?:run|start)$/.test(g)) || !skip && goals.some(g => /^(?:test|integration-test|verify|package|install|deploy)$/.test(g) || /:(?:test|integration-test)$/.test(g));
  }
  if (/^gradlew?$/.test(exe)) {
    const excluded = args.filter((a, i) => i > 0 && /^(?:-x|--exclude-task)$/.test(args[i - 1])).map(a => a.toLowerCase().split(':').pop());
    const tasks = plainOf(/^(?:-x|--exclude-task|-p|--project-dir|-b|--build-file|-c|--settings-file|-g|--gradle-user-home|-I|--init-script)$/).map(t => t.split(':').pop());
    const skipTest = excluded.includes('test');
    return tasks.some(t => /^(?:test|check|build)$/.test(t) ? !skipTest : /^(?:integrationtest|connectedcheck|bootrun|run|apprun)$/.test(t));
  }
  if (exe === 'node') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--test') return true;
      if (/^(?:-e|--eval|-p|--print|-c|--check)$/.test(a)) return false;
      if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(a)) { i++; continue; }
      if (/^-/.test(a)) continue;
      if (/[\\/]skills[\\/](?:ttls-db-crud|ttls-redis)[\\/]/i.test(a)) return false;
      if (base(a) === 'devserver.js') return String(args[i + 1] || '').toLowerCase() === 'start';
      return testScript(a);
    }
    return false;
  }
  if (/^(?:python3?|py)$/.test(exe)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m') return /^(?:pytest|unittest|nose2?|tox)$/i.test(args[i + 1] || '');
      if (a === '-c') return false;
      if (/^-/.test(a)) continue;
      if (/[\\/]skills[\\/](?:ttls-db-crud|ttls-redis)[\\/]/i.test(a)) return false;
      return testScript(a) || base(a) === 'manage.py' && String(args[i + 1] || '').toLowerCase() === 'test';
    }
    return false;
  }
  return false;
}
module.exports = { groups, points, pointFiles, fingerprint, record, passed, settled, pending, allPassed, limit, begin, noteResult, qualify, automaticApply, planNext, instruction, stop, actionIssue, explicit, testCommand };
