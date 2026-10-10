'use strict';
/*
 * 合并 push：只整理当前分支尚未推送的线性提交。同一事件要有同一个 OpenSpec 来源或事件标记，
 * 不凭标题相似程度猜。交错事件只有改动文件完全不相交才调到一起，否则保持原顺序。
 * 所有重建先在独立 index 里完成，最终 tree 必须和原 HEAD 完全一样；备份 ref 后才原子换分支。
 * 不改工作区，不改远端历史，不 force push。计划过期、工作区不干净、远端前进、含 merge/签名/tag 都停。
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
  const r = spawnSync('git', ['-C', root].concat(args), Object.assign({ env: gitEnv(), windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, opt || {}));
  if (r.status !== 0) throw new Error('git ' + args[0] + ' 没有成功，操作已停止；核对仓库和远端后重试。');
  return opt && opt.raw ? r.stdout : r.stdout.trim();
}
function state(root, fetch) {
  root = git(root, ['rev-parse', '--show-toplevel']);
  if (git(root, ['status', '--porcelain', '-uall'])) throw new Error('工作区或暂存区还有改动，先完成提交，不自动 stash。');
  const ref = git(root, ['symbolic-ref', '-q', 'HEAD']);
  if (!ref.startsWith('refs/heads/')) throw new Error('当前没有本地分支。');
  const dir = git(root, ['rev-parse', '--absolute-git-dir']);
  for (const n of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) if (fs.existsSync(path.join(dir, n))) throw new Error('仓库还有合并、变基或锁，先处理完。');
  const branch = ref.slice(11);
  const remote = git(root, ['config', '--get', 'branch.' + branch + '.remote']);
  const merge = git(root, ['config', '--get', 'branch.' + branch + '.merge']);
  if (remote === '.' || !merge.startsWith('refs/heads/')) throw new Error('需要一个真实远端上的跟踪分支，不能猜推到哪里。');
  const fetchUrls = git(root, ['remote', 'get-url', '--all', remote]).split('\n');
  const pushUrls = git(root, ['remote', 'get-url', '--push', '--all', remote]).split('\n');
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) throw new Error('远端的拉取和推送地址不同或有多个地址，先人工确认目标，不改历史。');
  const upstream = git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  if (fetch) git(root, ['fetch', '--no-tags', remote, merge]);
  // FETCH_HEAD 是此次取到的目标，不依赖用户的 remote.fetch 是否包含这个分支。
  const base = git(root, ['rev-parse', fetch ? 'FETCH_HEAD' : upstream]);
  const head = git(root, ['rev-parse', 'HEAD']);
  const common = git(root, ['merge-base', head, base]);
  if (common !== base) throw new Error('远端已经前进或发生分叉，先正常合并代码，不能合并 push。');
  const ids = git(root, ['rev-list', '--reverse', base + '..' + head]).split('\n').filter(Boolean);
  if (ids.length > 200) throw new Error('本地未推送提交超过 200 条，先人工整理范围。');
  const commits = ids.map((id) => {
    const raw = git(root, ['cat-file', '-p', id]);
    if ((raw.match(/^parent /gm) || []).length !== 1 || /^gpgsig /m.test(raw) || git(root, ['tag', '--points-at', id])) throw new Error('本地提交含 merge、签名或版本标签，保持原历史，请人工处理。');
    const fields = git(root, ['show', '-s', '--format=%T%x00%an%x00%ae%x00%aI%x00%s', id]).split('\x00');
    const files = git(root, ['diff-tree', '--no-commit-id', '--no-renames', '-r', '--name-only', '-z', id]).split('\x00').filter(Boolean);
    return { id, tree: fields[0], author: fields[1], email: fields[2], date: fields[3], title: fields[4], message: raw.slice(raw.indexOf('\n\n') + 2), files };
  });
  return { root, ref, remote, merge, upstream, base, head, dir, commits };
}
function eventOf(c) {
  const explicit = /(?:（源自 |\(源自 |(?:^|\s)事件[:：]\s*)([^\s（）()]+)/.exec(c.title);
  if (explicit) return 'event:' + explicit[1];
  const names = new Set();
  for (const f of c.files) { const m = /^openspec\/changes\/(?:archive\/\d{4}-\d{2}-\d{2}-)?([^/]+)\//.exec(f); if (m) names.add(m[1]); }
  if (names.size === 1 && c.files.every((f) => f.startsWith('openspec/changes/'))) return 'event:' + [...names][0];
  return 'single:' + c.id;
}
function groupsOf(commits) {
  const out = [];
  for (const c of commits) {
    const event = eventOf(c);
    let target = null;
    // 提案和归档保留独立节点，不和实现、审查混成一条。
    const boundary = /^docs: (提案|归档|同步规格)/.test(c.title);
    if (!boundary && !event.startsWith('single:')) {
      for (let i = out.length - 1; i >= 0; i--) {
        const g = out[i];
        if (g.event === event && g.boundary) break;
        if (g.event !== event) continue;
        const moving = new Set(c.files);
        if (out.slice(i + 1).some((x) => x.commits.some((v) => v.files.some((f) => moving.has(f))))) break;
        target = g; break;
      }
    }
    if (target) target.commits.push(c);
    else out.push({ event, boundary, commits: [c] });
  }
  return out.map((g) => {
    const first = g.commits.find((c) => !/审查|复审|review/.test(c.title)) || g.commits[0];
    return { event: g.event, ids: g.commits.map((c) => c.id), title: first.title };
  });
}
function plan(root, fetch) {
  const s = state(root, fetch !== false);
  const p = { version: 1, root: s.root, ref: s.ref, remote: s.remote, merge: s.merge, base: s.base, head: s.head, groups: groupsOf(s.commits) };
  p.hash = sha(p);
  return p;
}
function apply(p, push) {
  if (!p || p.version !== 1 || p.hash !== sha(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'hash')))) throw new Error('合并计划被改过，重新生成。');
  const s = state(p.root, true);
  if (s.head !== p.head || s.base !== p.base || s.ref !== p.ref || s.remote !== p.remote || s.merge !== p.merge || JSON.stringify(groupsOf(s.commits)) !== JSON.stringify(p.groups)) throw new Error('本地或远端已变化，重新生成计划。');
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
    try { git(s.root, ['push', s.remote, head + ':' + s.merge]); }
    catch (e) { return { ok: false, before: s.commits.length, after: p.groups.length, head, backup, pushed: false, msg: '推送失败；本地整理结果和旧提交备份仍保留。先核对远端，重试普通 push，不强推。' }; }
  }
  return { ok: true, before: s.commits.length, after: p.groups.length, head, backup, pushed: !!push };
}
module.exports = { plan, apply, eventOf, groupsOf };
