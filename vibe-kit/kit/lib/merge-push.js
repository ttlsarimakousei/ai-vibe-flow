'use strict';
/*
 * 合并 push：只整理当前分支尚未推送的线性提交。同组必须有相同的变更名和任务号，或同一独立修复标记，
 * 点名的文档修订可带伴随文档和计划表，不凭标题相似程度猜。交错事件只有改动文件完全不相交才调到一起，否则保持原顺序。
 * 所有重建先在独立 index 里完成，最终 tree 必须和原 HEAD 完全一样；备份 ref 后才原子换分支。
 * 不改工作区，不改远端历史，不 force push。需要整理历史时先预览再确认；单笔普通推送仍必须有真人许可。
 * 计划过期、工作区不干净、远端前进都停；含 merge、签名或版本标签时保留整段历史，只预览普通推送。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { envFor } = require('./pull');
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function gitEnv() {
  const env = envFor();
  // 当前目录必须决定仓库和 index，不能继承另一个 git 命令留下的重定向。
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/i.test(k)) delete env[k];
  return env;
}
function git(root, args, opt) {
  const I = require('./invocation'); I.phase('推送 Git ' + args[0]); opt = Object.assign({}, opt, { timeout: I.remaining(opt && opt.timeout || 30000) });
  const r = spawnSync('git', ['-C', root].concat(args), Object.assign({ env: gitEnv(), windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, opt || {}));
  if (opt && opt.optional && (r.status === 1 || r.status === 128)) return '';
  if (r.status !== 0) throw new Error('git ' + args[0] + ' 没有成功，操作已停止；核对仓库和远端后重试。');
  return opt && opt.raw ? r.stdout : r.stdout.trim();
}
function state(root, fetch, options) {
  // 完成/执行钩子只核对不可变提交的端点；完整分组在 CLI 执行前再次计算。
  // 2026-10-12 #64：不能在 25 秒的 HTTP 钩子里对每条提交起四次 Git。
  const deadline = options && options.deadline;
  const run = (dir, args, optional) => {
    const left = deadline ? deadline - Date.now() : 30000;
    if (left <= 0) throw new Error('推送预览的本机核对超时，稍后重试同一计划。');
    return git(dir, args, { timeout: Math.min(30000, left), optional: !!optional });
  };
  root = run(root, ['rev-parse', '--show-toplevel']);
  if (run(root, ['status', '--porcelain', '-uall'])) throw new Error('工作区或暂存区还有改动，先完成提交，不自动 stash。');
  const ref = run(root, ['symbolic-ref', '-q', 'HEAD']);
  if (!ref.startsWith('refs/heads/')) throw new Error('当前没有本地分支。');
  const dir = run(root, ['rev-parse', '--absolute-git-dir']);
  for (const n of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) if (fs.existsSync(path.join(dir, n))) throw new Error('仓库还有合并、变基或锁，先处理完。');
  const branch = ref.slice(11);
  const configured = run(root, ['config', '--get', 'branch.' + branch + '.remote'], true);
  const remotes = run(root, ['remote']).split('\n').filter(Boolean);
  const remote = configured || (remotes.length === 1 ? remotes[0] : '');
  const merge = run(root, ['config', '--get', 'branch.' + branch + '.merge'], true) || 'refs/heads/' + branch;
  if (!remote) throw new Error('没有唯一的推送远端，请先明确 branch.' + branch + '.remote 和 merge。');
  if (remote === '.' || !merge.startsWith('refs/heads/')) throw new Error('需要一个真实远端上的跟踪分支，不能猜推到哪里。');
  const fetchUrls = run(root, ['remote', 'get-url', '--all', remote]).split('\n');
  const pushUrls = run(root, ['remote', 'get-url', '--push', '--all', remote]).split('\n');
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) throw new Error('远端的拉取和推送地址不同或有多个地址，先人工确认目标，不改历史。');
  const upstream = 'refs/remotes/' + remote + '/' + merge.slice(11);
  let base = run(root, ['rev-parse', '--verify', upstream], true);
  if (fetch) {
    const heads = run(root, ['ls-remote', '--heads', remote, merge]);
    if (!heads) base = '';
    else { run(root, ['fetch', '--no-tags', remote, merge]); base = run(root, ['rev-parse', 'FETCH_HEAD']); }
  }
  // FETCH_HEAD 是此次取到的目标，不依赖用户的 remote.fetch 是否包含这个分支。
  const head = run(root, ['rev-parse', 'HEAD']);
  const common = base ? run(root, ['merge-base', head, base]) : '';
  if (base && common !== base) throw new Error('远端已经前进或发生分叉，先正常合并代码，不能合并 push。');
  if (options && options.headerOnly) return { root, ref, remote, merge, upstream, base, head, dir, targetHash: sha([fetchUrls, pushUrls]) };
  const ids = run(root, ['rev-list', '--reverse', base ? base + '..' + head : head]).split('\n').filter(Boolean);
  if (ids.length > 200) throw new Error('本地未推送提交超过 200 条，先人工整理范围。');
  const commits = ids.map((id) => {
    const raw = run(root, ['cat-file', '-p', id]);
    const protectedHistory = (raw.match(/^parent /gm) || []).length !== 1 || /^gpgsig /m.test(raw) || !!run(root, ['tag', '--points-at', id]);
    const fields = run(root, ['show', '-s', '--format=%T%x00%an%x00%ae%x00%aI%x00%s', id]).split('\x00');
    const files = run(root, ['diff-tree', '--root', '--no-commit-id', '--no-renames', '-r', '--name-only', '-z', id]).split('\x00').filter(Boolean);
    return { id, tree: fields[0], author: fields[1], email: fields[2], date: fields[3], title: fields[4], message: raw.slice(raw.indexOf('\n\n') + 2), files, protectedHistory };
  });
  return { root, ref, remote, merge, upstream, base, head, dir, commits, targetHash: sha([fetchUrls, pushUrls]) };
}
function eventOf(c) {
  // 任务号不能丢；只有明确的独立修复编号才能合并没有任务来源的提交。
  const task = /[（(]源自\s+([^\s（）()]+)\s+(\d+(?:\.\d+)+)[）)]/.exec(c.title);
  if (task) return 'task:' + task[1] + ':' + task[2];
  const fix = /(?:^|\s)事件[:：]\s*([^\s（）()]+)/.exec(c.title);
  if (fix) return 'event:' + fix[1];
  return 'single:' + c.id;
}
function groupsOf(commits) {
  const knownNames = new Set(commits.map((c) => eventOf(c)).filter((s) => s.startsWith('event:')).map((s) => s.slice(6)));
  for (const c of commits) for (const f of c.files) { const m = /^openspec\/changes\/(?:archive\/\d{4}-\d{2}-\d{2}-)?([^/]+)\//.exec(f); if (m) knownNames.add(m[1]); }
  if (commits.some((c) => c.protectedHistory)) return commits.map((c) => ({ event: eventOf(c, knownNames), ids: [c.id], title: c.title, titles: [c.title], reason: '历史含 merge、签名或版本标签，保留原提交' }));
  const out = [];
  for (const c of commits) {
    const event = eventOf(c, knownNames);
    let target = null;
    // 提案和归档保留独立节点，不和实现、审查混成一条。
    const boundary = /^docs: (提案|需求定稿|文档定稿|验收|归档|同步规格)/.test(c.title);
    let reason = boundary ? '文档定稿、验收、归档和同步规格保留独立节点' : event.startsWith('single:') ? '缺少具体任务或独立修复编号，保留原提交' : '同事件没有其它可合并提交';
    if (!boundary && !event.startsWith('single:')) {
      for (let i = out.length - 1; i >= 0; i--) {
        const g = out[i];
        if (g.boundary) { reason = '隔着文档定稿、验收或归档节点'; break; }
        if (g.event !== event) continue;
        const moving = new Set(c.files);
        if (out.slice(i + 1).some((x) => x.commits.some((v) => v.files.some((f) => moving.has(f))))) { reason = '中间其它事件修改了相同文件，保持原顺序'; break; }
        target = g; break;
      }
    }
    if (target) target.commits.push(c);
    else out.push({ event, boundary, reason, commits: [c] });
  }
  return out.map((g) => {
    const first = g.commits.find((c) => !/审查|复审|review/.test(c.title)) || g.commits[0];
    return { event: g.event, ids: g.commits.map((c) => c.id), title: first.title, titles: g.commits.map((c) => c.title), reason: g.commits.length > 1 ? '同一具体任务或独立修复，合并后文件内容保持一致' : g.reason };
  });
}
function plan(root, fetch) {
  const s = state(root, fetch !== false);
  const p = { version: 1, root: s.root, ref: s.ref, remote: s.remote, merge: s.merge, base: s.base, head: s.head, targetHash: s.targetHash, groups: groupsOf(s.commits), warnings: s.commits.some((c) => c.protectedHistory) ? ['本地历史含 merge、签名或版本标签，整段保持原提交，只做普通推送。'] : [] };
  p.hash = sha(p);
  return p;
}
function apply(p, push) {
  if (!p || p.version !== 1 || p.hash !== sha(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'hash')))) throw new Error('合并计划被改过，重新生成。');
  const s = state(p.root, true);
  if (s.head !== p.head || s.base !== p.base || s.ref !== p.ref || s.remote !== p.remote || s.merge !== p.merge || s.targetHash !== p.targetHash || JSON.stringify(groupsOf(s.commits)) !== JSON.stringify(p.groups)) throw new Error('本地或远端已变化，重新生成计划。');
  let head = s.head;
  let backup = '';
  const fewer = p.groups.length < s.commits.length;
  if (fewer) {
    const index = path.join(s.dir, 'vibe-merge-index-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
    const env = Object.assign(gitEnv(), { GIT_INDEX_FILE: index });
    try {
      git(s.root, ['read-tree', s.base], { env });
      let parent = s.base;
      const byId = new Map(s.commits.map((c) => [c.id, c]));
      for (const group of p.groups) {
        for (const id of group.ids) {
          const patch = git(s.root, ['diff', '--binary', '--no-ext-diff', '--no-renames', id + '^', id], { raw: true });
          if (patch) git(s.root, ['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: patch });
        }
        const tree = git(s.root, ['write-tree'], { env });
        const first = byId.get(group.ids[0]);
        const message = group.ids.length === 1 ? first.message : group.title + '\n\n合并的本地提交：\n\n' + group.ids.map((id) => byId.get(id).message.trimEnd()).join('\n\n');
        parent = git(s.root, ['commit-tree', tree, '-p', parent], { env: Object.assign({}, env, { GIT_AUTHOR_NAME: first.author, GIT_AUTHOR_EMAIL: first.email, GIT_AUTHOR_DATE: first.date }), input: message + '\n' });
      }
      if (git(s.root, ['rev-parse', s.head + '^{tree}']) !== git(s.root, ['rev-parse', parent + '^{tree}'])) throw new Error('合并后的文件内容不一致，原分支没有改。');
      if (git(s.root, ['status', '--porcelain', '-uall']) || git(s.root, ['rev-parse', 'HEAD']) !== s.head || git(s.root, ['symbolic-ref', '-q', 'HEAD']) !== s.ref) throw new Error('整理时仓库或当前分支有了变化，原分支没有改。');
      backup = 'refs/vibe-kit/backups/merge-push-' + Date.now() + '-' + process.pid;
      git(s.root, ['update-ref', backup, s.head, '0'.repeat(s.head.length)]);
      git(s.root, ['update-ref', '-m', 'vibe-kit 合并本地事件提交', s.ref, parent, s.head]);
      head = parent;
    } finally {
      for (const f of [index, index + '.lock']) { try { fs.unlinkSync(f); } catch (e) { /* 未产生文件 */ } }
    }
  }
  if (push) {
    try { git(s.root, ['push', '--set-upstream', s.remote, s.ref + ':' + s.merge]); }
    catch (e) { return { ok: false, before: s.commits.length, after: p.groups.length, head, backup, pushed: false, msg: '推送失败；本地整理结果和旧提交备份仍保留。先核对远端，重试普通 push，不强推。' }; }
  }
  return { ok: true, before: s.commits.length, after: p.groups.length, head, backup, pushed: !!push };
}
// 完成钩子才登记预览；第一次说 push 只是启动检测，不能借同一句话立即改历史。
function voiceId(v) { return require('./session').voiceKey(v); }
function receiptKey(j) { return j.session_id && j.session_id !== 'unknown' ? String(j.session_id) + '-push-preview' : ''; }
function norm(root) { return path.resolve(root).replace(/\\/g, '/').toLowerCase(); }
function commandOf(j) {
  const cmd = String(j.tool_input && j.tool_input.command || '');
  const parser = require('../hooks/guard-commit');
  const ps = j.tool_name === 'PowerShell';
  const groups = parser.splitCommand(cmd, ps);
  if (groups.length !== 1) return null;
  const redir = parser.scanRedirects(groups[0][0]);
  if (redir.list.length) return null;
  const words = parser.words(redir.rest, ps).map((w) => w.text);
  const at = words.findIndex((w) => /(?:^|[\\/])merge-push\.js$/i.test(w));
  if (at !== 1 || !/^(?:node|node\.exe)$/i.test(path.basename(words[0].replace(/\\/g, '/')))) return null;
  const S = require('./session');
  if (norm(path.resolve(j.cwd || process.cwd(), S.expandHome(words[at]))) !== norm(path.join(S.KIT, 'tools/merge-push.js'))) return null;
  const args = words.slice(at + 1);
  // plan 的输出可以截行查看，但必须仍收到完整 JSON。其它管道不猜执行含义。
  if (groups[0].length > 1 && (!['plan', 'apply'].includes(args[0]) || !groups[0].slice(1).every((s) => /^(?:(?:tail|head)(?:\s+(?:-n\s*\d+|-\d+))?|cat|(?:Select-Object|select)\s+-(?:First|Last)\s+\d+|Out-String)$/i.test(s)))) return null;
  const val = (key) => { const n = args.indexOf(key); return n < 0 ? '' : S.expandHome(args[n + 1] || ''); };
  return { action: args[0], root: path.resolve(j.cwd || process.cwd(), val('--dir') || '.'), file: val('--plan'), confirmed: val('--confirmed'), push: args.includes('--push') };
}
function previewNotice(reason) {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[vibe-kit 推送预览] 预览未登记：' + reason + '。用不带管道、重定向或串联命令的 merge-push.js plan --dir <仓库> 重跑，完整展示结果后再让用户确认。' }, systemMessage: '[vibe-kit] 推送预览未登记：' + reason + '。' };
}
function readPlan(root, file) {
  const base = path.resolve(root, '.vibe/tmp');
  const f = path.resolve(root, file || '.vibe/tmp/merge-push/plan.json');
  if (!norm(f).startsWith(norm(base) + '/')) throw new Error('推送计划必须位于当前项目 .vibe/tmp 内。');
  const realRoot = norm(fs.realpathSync(root)); const realBase = norm(fs.realpathSync(base));
  if (!realBase.startsWith(realRoot + '/') || !norm(fs.realpathSync(f)).startsWith(realBase + '/')) throw new Error('推送计划链接到了受管过程目录外。');
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (norm(p.root) !== norm(root) || p.hash !== sha(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'hash')))) throw new Error('推送计划已经修改或属于另一个仓库。');
  return { file: f, plan: p };
}
function recordPreview(j) {
  const call = commandOf(j); const k = receiptKey(j);
  if (!k) return null;
  if (!call) return /\bmerge-push\.js["']?\s+plan\b/i.test(String(j.tool_input && j.tool_input.command || '')) ? previewNotice('命令包含无法核对的管道、重定向或串联操作') : null;
  if (call.action !== 'plan') return null;
  let result; try { result = JSON.parse(String(j.tool_response && j.tool_response.stdout || '').trim()); } catch (e) { return previewNotice('工具输出不是完整的预览 JSON，可能被截断或重定向'); }
  if (!result.ok || result.kind !== 'push-preview') return previewNotice('工具没有返回成功的推送预览');
  const S = require('./session');
  const loaded = readPlan(call.root, result.plan); const p = loaded.plan;
  if (result.hash !== p.hash || git(p.root, ['rev-parse', 'HEAD'], { timeout: 3000 }) !== p.head || git(p.root, ['symbolic-ref', '-q', 'HEAD'], { timeout: 3000 }) !== p.ref) return previewNotice('生成后仓库或计划已变化');
  const voice = S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
  S.updateState(k, (s) => { const roots = s.roots || (s.roots = {}); roots[norm(p.root)] = { hash: p.hash, file: loaded.file, voice: voiceId(voice), voiceSchema: 2, at: Date.now(), consumed: false }; });
  const before = p.groups.reduce((n, g) => n + g.ids.length, 0);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[vibe-kit 推送预览] ' + before + ' 条提交拟保留为 ' + p.groups.length + ' 条。把工具输出中的每组原提交、最终标题、分支与远端完整给用户看，等待另一条真人确认（回复“确认推送”或在提问框选择“照计划推送”均可）。确认后才 apply --plan <文件> --confirmed ' + p.hash + ' --push；不能把第一次 push 指令当作合并计划确认。' }, systemMessage: '[vibe-kit] 已生成推送预览 ' + p.hash.slice(0, 8) + '：' + before + ' 条提交拟保留为 ' + p.groups.length + ' 条，分支 ' + p.ref.slice(11) + '，远端 ' + p.remote + '。等待你看过并确认。' };
}
function previewAllowed(j, root, call) {
  try {
    const S = require('./session'); const k = receiptKey(j);
    const saved = k && (S.readState(k).roots || {})[norm(root)];
    if (!saved || saved.consumed || Date.now() - saved.at > 1800000) return { ok: false, reason: '还没有当前会话的有效推送预览' };
    if (saved.voiceSchema !== 2) return { ok: false, reason: '旧版预览没有稳定的确认记录，请重新生成预览并确认' };
    const said = S.userSaid(S.tailEntries(j.transcript_path, 3000000), 'push');
    if (!said.ok || voiceId(said.voice) === saved.voice) return { ok: false, reason: '预览后还没有另一条真人推送确认；用户可以回复“确认推送”，或在提问框选择“照计划推送”' };
    const loaded = readPlan(root, saved.file); const p = loaded.plan;
    const current = state(root, false, { headerOnly: true, deadline: Date.now() + 8000 });
    if (p.hash !== saved.hash || p.head !== current.head || p.base !== current.base || p.ref !== current.ref || p.remote !== current.remote || p.merge !== current.merge || p.targetHash !== current.targetHash) return { ok: false, reason: '仓库或推送目标已变化，需要重新预览并确认' };
    if (call && (path.resolve(root, call.file || '') !== loaded.file || call.confirmed !== p.hash || !call.push)) return { ok: false, reason: '执行命令没有绑定已确认计划，请用相同计划和完整 --confirmed 编号及 --push' };
    if (!call && p.groups.some((g) => g.ids.length > 1)) return { ok: false, reason: '计划会整理本地历史，须用 merge-push.js apply 绑定计划执行' };
    return { ok: true, file: loaded.file, hash: p.hash };
  } catch (e) { return { ok: false, reason: '推送预览无法核对：' + require('./redact').clip(e.message, 250) }; }
}
// 只认真正执行的脚本参数；反馈正文和提交信息里引用 apply 不触发执行检查。
function isApplyCommand(j) {
  const S = require('./session'), parser = require('../hooks/guard-commit');
  return parser.splitCommand(String(j.tool_input && j.tool_input.command || ''), j.tool_name === 'PowerShell').some((g) => g.some((seg) => { const ws = parser.words(parser.scanRedirects(seg).rest, j.tool_name === 'PowerShell'); return ws.some((w, i) => i > 0 && /(?:^|[\\/])merge-push\.js$/i.test(w.text) && ws[i + 1] && ws[i + 1].text === 'apply' && norm(path.resolve(j.cwd, S.expandHome(w.text))) === norm(path.join(S.KIT, 'tools/merge-push.js'))); }));
}
function simpleAllowed(j, g) {
  try {
    if (!require('./session').userSaid(require('./session').tailEntries(j.transcript_path, 3000000), 'push').ok || g.dyn) return false;
    const args = g.args.map((a) => a.text); if (args.some((a) => a.startsWith('-') && !['-u', '--set-upstream'].includes(a))) return false;
    const s = state(g.dir, false, { headerOnly: true, deadline: Date.now() + 8000 }); const pos = args.filter((a) => !a.startsWith('-'));
    if (pos.length > 2 || pos[0] && pos[0] !== s.remote || pos[1] && ![s.ref, s.ref.slice(11), 'HEAD', s.ref + ':' + s.merge, s.ref.slice(11) + ':' + s.merge.slice(11)].includes(pos[1])) return false;
    const count = Number(git(s.root, ['rev-list', '--count', s.base ? s.base + '..' + s.head : s.head], { timeout: 2000 }));
    return Number.isInteger(count) && count <= 1 || previewAllowed(j, s.root, null).ok;
  } catch (e) { return false; }
}
function consumePreview(j) {
  const k = receiptKey(j); if (!k) return;
  const call = commandOf(j); const cmd = String(j.tool_input && j.tool_input.command || '');
  if (!(call && call.action === 'apply' && call.push) && !/\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?push\b/i.test(cmd)) return;
  if (call) { let r; try { r = JSON.parse(String(j.tool_response && j.tool_response.stdout || '').trim()); } catch (e) { return; } if (!r.ok || !r.pushed) return; }
  const root = call ? call.root : require('./workspace').rootOf(j.cwd || process.cwd());
  require('./session').updateState(k, (s) => { const v = (s.roots || {})[norm(root)]; if (v) { v.consumed = true; v.finished = Date.now(); } });
}
module.exports = { plan, apply, eventOf, groupsOf, commandOf, recordPreview, previewAllowed, consumePreview, isApplyCommand, simpleAllowed };
