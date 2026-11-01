'use strict';
/*
 * 只提交这个会话改过的文件（K3 M09，2026-11-01）。
 *
 *   node commit.js -m "类型: 内容" [--dir <仓库目录>] [--only <文件>[,<文件>…]] [--session <会话号>]
 *   node commit.js list [--dir …] [--only …] [--session …]     只列出会提交哪些、哪些不提交，不提交
 *   node commit.js help
 *
 * 哪些文件：会话记录里成功的 Edit、Write、MultiEdit、NotebookEdit 改过的、在这个仓库里的（lib/edited-files.js 的 commitPlan）。
 * 别的仓库（壳子里的子项目）的、套件自己的、.vibe 里的、过程文件、被 .gitignore 忽略的、没改动的不提交，列出来说为什么。
 * 用 Bash 改的（sed -i、脚本生成的）认不出来：那些用 git add <文件>、git commit。
 * 怎么提交：用一份临时 index（GIT_INDEX_FILE）——从 HEAD 读出来、只加这几个文件、提交；提交完把真暂存区里这几个文件同步成刚提交的样子。
 *   你暂存区里别的文件不动；git 的钩子（pre-commit、commit-msg）照常跑。
 * 提交检查：guard-commit 把跑这个工具当成一次 git add + git commit 来查（提交信息格式、提交方式的许可、新文件、过程文件、令牌文件），
 *   查过没拦下的记一张票（只能用一次，10 分钟内有效）。没有票不提交：钩子没跑（路由不在、钩子出错放行）时它不能成了绕过检查的后门。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('../lib/edited-files');

const argv = process.argv.slice(2);
const SELF = 'node "$HOME/.claude/vibe-kit/tools/commit.js"';
const opts = { only: [], msg: [] };
let sub = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-m' || a === '--message') { if (argv[i + 1] !== undefined) opts.msg.push(argv[++i]); continue; }
  if (/^-m./.test(a)) { opts.msg.push(a.slice(2)); continue; }
  if (a.startsWith('--message=')) { opts.msg.push(a.slice(10)); continue; }
  if (a === '--dir' && argv[i + 1] !== undefined) { opts.dir = argv[++i]; continue; }
  if (a.startsWith('--dir=')) { opts.dir = a.slice(6); continue; }
  if (a === '--only' && argv[i + 1] !== undefined) { opts.only.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean)); continue; }
  if (a === '--session' && argv[i + 1] !== undefined) { opts.session = argv[++i]; continue; }
  if (a === '--dry-run') { sub = 'list'; continue; }
  if (!sub && /^(help|list|-h|--help)$/i.test(a)) { sub = a.replace(/^-+/, '').replace(/^h$/, 'help'); continue; }
}

function help() {
  console.log([
    '只提交这个会话改过的文件（会话记录里用 Edit、Write 改成功的），工作区里别人的改动、你暂存区里别的文件不动。',
    '',
    '  ' + SELF + ' -m "类型: 内容"                 提交当前目录所在仓库里、这个会话改过的文件',
    '  ' + SELF + ' -m "类型: 内容" --dir <仓库目录>   壳子里提交某个子项目的（一个仓库一条）',
    '  ' + SELF + ' -m "类型: 内容" --only a.java,b.vue  只提交其中几个（别的照旧留着；这个会话新建的别的文件会点名提醒一次）',
    '  ' + SELF + ' list [--dir …]                   只列出会提交哪些、哪些不提交，不提交',
    '',
    '提交信息：类型: 内容（类型 feat、fix、docs、style、refactor、chore、release），例：feat: 新增修改页面。多段的写几个 -m。',
    '不提交的：别的仓库的、套件自己的、.vibe 里的、过程文件（备份、日志）、被 .gitignore 忽略的、没改动的。',
    '用 Bash 改的文件（sed、脚本生成的）认不出来：那些用 git add <文件>、git commit。',
    '提交照样过套件的提交检查（提交方式、提交信息格式……），没过检查的不提交。',
  ].join('\n'));
  return 0;
}

function plan() {
  const cwd = process.cwd();
  const s = E.findSession({ sid: opts.session, cwd, marker: /commit\.js/i });
  if (s.error) return { error: s.error + '。没有提交。用 git add <文件>、git commit 提交。' };
  const root = E.repoOf(opts.dir ? path.resolve(cwd, opts.dir) : cwd);
  if (!root) return { error: (opts.dir || cwd) + ' 不在 git 仓库里。--dir 写仓库目录。', session: s };
  const p = E.commitPlan({ entries: E.entriesOf(s.transcript), cwd, root, only: opts.only });
  return Object.assign(p, { session: s });
}

function describe(p) {
  const out = [];
  if (p.files.length) out.push('这个会话改过、会提交的（' + p.files.length + ' 个）：' + p.files.slice(0, 40).map((f) => f.rel + (f.gone ? '（删掉了）' : '')).join('、') + (p.files.length > 40 ? ' 等' : ''));
  if (p.skipped.length) out.push('不提交的：' + p.skipped.slice(0, 20).map((x) => x.rel + '（' + x.why + '）').join('、') + (p.skipped.length > 20 ? ' 等 ' + p.skipped.length + ' 个' : ''));
  if (p.other.length) out.push('别的仓库里的（到那个仓库再提交一次，--dir <那个仓库>）：' + p.other.slice(0, 10).map((f) => path.relative(p.root, f).split(path.sep).join('/')).join('、') + (p.other.length > 10 ? ' 等' : ''));
  return out.join('\n');
}

function list() {
  const p = plan();
  if (p.error) { console.log(p.error); return 1; }
  console.log('仓库 ' + p.root + '（会话 ' + String(p.session.sid).slice(0, 8) + '）');
  console.log(describe(p) || '这个会话在这个仓库里没有改过文件。');
  if (p.notMine.length) console.log('不是这个会话改过的（commit.js 不提交它们）：' + p.notMine.join('、'));
  return 0;
}

function git(root, args, env, input) {
  return execFileSync('git', ['-C', root].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, env || {}), input, windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function commit() {
  const cwd = process.cwd();
  const s = E.findSession({ sid: opts.session, cwd, marker: /commit\.js/i });
  if (s.error) { console.log(s.error + '。没有提交。用 git add <文件>、git commit 提交。'); return 1; }
  const root = E.repoOf(opts.dir ? path.resolve(cwd, opts.dir) : cwd);
  if (!root) { console.log((opts.dir || cwd) + ' 不在 git 仓库里。--dir 写仓库目录。'); return 1; }
  // 先把票用掉：后面不管因为什么没提交，这张票也不留给下一次
  const ticket = E.takeTicket(s.sid, root);
  const msg = opts.msg.join('\n\n');
  if (!msg.trim()) { console.log('要写提交信息：' + SELF + ' -m "类型: 内容"'); return 1; }
  const first = msg.split(/\r?\n/)[0].trim();
  const G = require('../lib/guard-git');
  if (!G.FORMAT.test(first)) { console.log('提交信息不符合公司规范：' + JSON.stringify(first) + '\n格式：类型: 内容（类型后面是英文冒号加一个空格，然后直接写内容，只写一行）。\n类型只能是 ' + G.TYPES.join(' / ') + '。\n例：feat: 新增修改页面'); return 1; }
  const p = E.commitPlan({ entries: E.entriesOf(s.transcript), cwd, root, only: opts.only });
  if (!ticket) { console.log('这次提交没经过套件的提交检查（钩子没跑，或者被拦下了），没有提交。重新执行一次这条命令；还是不行，用 git add <文件>、git commit 提交。'); return 1; }
  if (p.notMine.length) { console.log('这几个不是这个会话改过的：' + p.notMine.join('、') + '。commit.js 只提交这个会话改过的文件，没有提交。别的文件用 git add <文件>、git commit 提交。'); return 1; }
  const checked = new Set(ticket.files || []);
  const files = p.files.filter((f) => checked.has(f.rel));
  const late = p.files.filter((f) => !checked.has(f.rel));
  if (!files.length) { console.log('没有要提交的改动（这个会话在 ' + root + ' 里改过的文件都和上次提交一样，或者都不该提交）。\n' + describe(p)); return 1; }
  let gd = '';
  try { gd = git(root, ['rev-parse', '--absolute-git-dir']).trim(); } catch (e) { console.log('读不了 ' + root + ' 的 git 目录：' + String((e && e.stderr) || e).trim().slice(0, 300)); return 1; }
  const tmp = path.join(gd, 'vibe-commit-' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.idx');
  const list = files.map((f) => f.rel).join('\0') + '\0';
  let sha = '';
  try {
    let head = true;
    try { git(root, ['rev-parse', '--verify', '-q', 'HEAD']); } catch (e) { head = false; }
    if (head) git(root, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: tmp });
    git(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { GIT_INDEX_FILE: tmp, GIT_LITERAL_PATHSPECS: '1' }, list);
    git(root, ['commit', '-q', '-F', '-'], { GIT_INDEX_FILE: tmp }, msg.replace(/\r\n/g, '\n') + '\n');
    sha = git(root, ['rev-parse', '--short', 'HEAD']).trim();
  } catch (e) {
    console.log('没提交成：' + (String((e && (e.stderr || e.stdout)) || '').trim() || String((e && e.message) || e)).slice(0, 1500) + '\n暂存区没动。');
    return 1;
  } finally {
    for (const f of [tmp, tmp + '.lock']) { try { fs.unlinkSync(f); } catch (e) { /* 没有 */ } }
  }
  // 真暂存区里这几个文件还是提交前的样子（git status 会显示成反向的已暂存改动）：同步成刚提交的
  let synced = true;
  try { git(root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { GIT_LITERAL_PATHSPECS: '1' }, list); } catch (e) { synced = false; }
  const out = ['已提交 ' + sha + '：' + first, '带上了 ' + files.length + ' 个文件：' + files.slice(0, 40).map((f) => f.rel + (f.gone ? '（删掉了）' : '')).join('、') + (files.length > 40 ? ' 等' : '')];
  if (late.length) out.push('提交检查之后才出现的改动，没带上：' + late.map((f) => f.rel).join('、') + '。要提交就再执行一次。');
  if (p.skipped.length) out.push('不提交的：' + p.skipped.slice(0, 20).map((x) => x.rel + '（' + x.why + '）').join('、'));
  if (p.other.length) out.push('别的仓库里也有这个会话改过的文件：到那个仓库再提交一次（--dir <那个仓库>）。');
  if (!synced) out.push('提交成功了，但暂存区里这几个文件没同步上（git status 会显示成反向的已暂存改动）：跑一次 git -C "' + root + '" reset -q -- <这几个文件>。');
  console.log(out.join('\n'));
  return 0;
}

let code = 0;
try {
  if (sub === 'help') code = help();
  else if (sub === 'list') code = list();
  else if (!opts.msg.length && !argv.length) code = help();
  else code = commit();
} catch (e) { console.log('出错了：' + ((e && e.stack) || e)); code = 1; }
process.exit(code);
