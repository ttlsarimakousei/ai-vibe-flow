'use strict';
/*
 * git 相关的检查（2026-11-01 从 guard-commit 拆出来，K 批）：认 push、发布；拆 git 子命令；提交信息格式、整仓 add、gitlink；
 * 新文件没 add；提交方式（关 / 询问 / 自动）能不能提交。规矩写在 hooks/guard-commit.js 开头 1、2、3、9、12 条。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let tidy = null;
try { tidy = require('./tidy.js'); } catch (e) { /* 老版本没有 */ }
let lessons = null;
try { lessons = require('./lessons.js'); } catch (e) { /* 老版本没有 */ }
const { flowState, flowChanges, userSaid, allChanges, nestedRepos, readState, writeState, normKey, expandHome, syncReviews, syncReviewRounds, tailEntries, toolCalls, toolResults, hookLog } = require('./session');
const { preprocess, dynamic, dynamicPath, local, headOf, repoRoot, substitutions } = require('./shell-words');

const TYPES =['feat', 'fix', 'docs', 'style', 'refactor', 'chore', 'release'];

const FORMAT = new RegExp('^(' + TYPES.join('|') + '): {1,2}\\S');

/*
 * push 的保守兜底：拆命令总有想不到的写法（函数、别名、变量拼命令……）。去掉 heredoc 正文和引号里的内容之后，
 * 只要出现 git [选项] push，就要用户确认——多问一次没有坏处，漏一次就推出去了
 */
const PUSH_WORD = /(^|[^\w.-])git(\.exe)?((\s+(-C|-c|--git-dir|--work-tree|--namespace)\s+\S+)|(\s+--?[\w-]+(=\S+)?))*\s+push(?=$|[\s;&|)}`])/i;

function pushAnywhere(cmd, ps) {
  const { s } = preprocess(cmd, ps);
  // 引号里的换成一个占位词：提交信息里写的"git push"不算，git -C "$d" push 的目录参数还在
  const bare = s.replace(/"(?:[^"\\`]|\\.|`.)*"|'[^']*'/g, ' Q ');
  if (PUSH_WORD.test(bare)) return true;
  // 命令替换照样会执行：bash 的 $(…) 和 `…`，PowerShell 的 $(…)，在双引号里也一样。以前整段引号当成文字，
  // echo "r $(git push)"、x=`git push` 都放行了（审核 P08）；里面再套引号（echo "$(git -C "$d" push)"）也要认（复审 S2）。
  // 按括号配对取出每一段替换的内容，当一条命令再查一遍
  for (const body of substitutions(s, ps)) if (pushAnywhere(body, ps)) return true;
  return false;
}

/**
 * 跑套件的发布脚本（安装包里的 publish.js、"发布到 GitLab"那个 bat）：它会把安装包 git push 到团队的仓库，
 * 命令里看不到 push 这个词，所以单独认。和 push 一样，一律要用户确认。
 * 别的项目里恰好也叫 publish.js 的不算：旁边得有 install.js 和 kit/VERSION 才是套件的安装包
 */
function publishAnywhere(cmd, cwd) {
  if (/发布到\s*GitLab[^\r\n|;&]*\.bat/i.test(cmd)) return true;
  if (!/publish\.js/i.test(cmd)) return false;
  const base = path.resolve(cwd || process.cwd());
  const dirs = [base];
  const cd = /(?:^|[\s;&|(])(?:cd|chdir|pushd|set-location|sl|push-location)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/gi;
  let m;
  while ((m = cd.exec(cmd))) { try { dirs.push(path.resolve(dirs[dirs.length - 1], local(m[1] || m[2] || m[3]))); } catch (e) { /* 认不出就跳过 */ } }
  const re = /"([^"]*publish\.js)"|'([^']*publish\.js)'|([^\s"'|;&<>()]*publish\.js)/gi;
  while ((m = re.exec(cmd))) {
    const p = local(m[1] || m[2] || m[3]);
    for (const d of dirs) {
      try { const at = path.dirname(path.resolve(d, p)); if (fs.existsSync(path.join(at, 'install.js')) && fs.existsSync(path.join(at, 'kit', 'VERSION'))) return true; } catch (e) { /* 认不出就不算 */ }
    }
  }
  return false;
}

// ---------- git ----------
/**
 * 返回 { sub, args, dir, dyn }。dyn：-C / --git-dir / --work-tree 给的目录写在变量里（git -C "$r" add …），算不出是哪个仓库，
 * 这时 dir 不可信（议题 #2：以前把 "$r" 当成字面的目录名往上找仓库，找到的是外面那层壳子，说"会提交成 gitlink"）
 */
function parseGit(ws, dir) {
  const h = headOf(ws);
  if (h.name !== 'git') return null;
  let i = h.i + 1;
  let at = dir;
  let gitDir = '';
  let dyn = '';
  const to = (w, text) => { if (dynamicPath(w)) dyn = dyn || String(w.raw); else at = path.resolve(at, local(text)); };
  while (i < ws.length && ws[i].text.startsWith('-')) {
    const t = ws[i].text;
    if (t === '-C' && ws[i + 1]) { to(ws[i + 1], ws[i + 1].text); i += 2; continue; }
    if (/^-C.+/.test(t)) { to(ws[i], t.slice(2)); i++; continue; }
    if (t === '--git-dir' && ws[i + 1]) { if (dynamicPath(ws[i + 1])) dyn = dyn || String(ws[i + 1].raw); else gitDir = ws[i + 1].text; i += 2; continue; }
    if (t.startsWith('--git-dir=')) { if (dynamicPath(ws[i])) dyn = dyn || String(ws[i].raw); else gitDir = t.slice(10); i++; continue; }
    if (t === '--work-tree' && ws[i + 1]) { to(ws[i + 1], ws[i + 1].text); i += 2; continue; }
    if (t.startsWith('--work-tree=')) { to(ws[i], t.slice(12)); i++; continue; }
    if (['-c', '--namespace', '--exec-path', '--super-prefix', '--config-env'].includes(t) && ws[i + 1]) { i += 2; continue; }
    i++;
  }
  if (i >= ws.length) return null;
  if (gitDir) { const g = path.resolve(at, local(gitDir)); at = /\.git$/i.test(g) ? path.dirname(g) : g; }
  return { sub: ws[i].text, args: ws.slice(i + 1), dir: at, dyn };
}

/** 提交信息的第一行；取不出来、算不出来返回 null */
function messageOf(args, docs) {
  for (const a of args) {
    const t = a.text;
    if (['-F', '--file', '--no-edit', '-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash'].includes(t) || /^--(file|reuse-message|reedit-message|fixup|squash)=/.test(t)) return null;
  }
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    let val = null;
    let src = null;
    if (t.startsWith('--message=')) { val = t.slice(10); src = args[i]; }
    else if (t === '--message' && args[i + 1]) { val = args[i + 1].text; src = args[i + 1]; }
    else if (/^-[A-Za-z]/.test(t) && !t.startsWith('--')) {
      const k = t.indexOf('m', 1);
      if (k > 0) { const rest = t.slice(k + 1); if (rest) { val = rest; src = args[i]; } else if (args[i + 1]) { val = args[i + 1].text; src = args[i + 1]; } }
    }
    if (val === null) continue;
    const hd = String(val).match(/__HD(\d+)__/);
    if (hd) return ((docs[Number(hd[1])] || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
    if (dynamic(src)) return null;
    return String(val).split(/\\n|\r?\n/)[0].trim();
  }
  return null;
}

/** git commit -a / --all：短选项组里 m 前面有 a（-am、-a），-mawesome 里的 a 是提交信息的一部分，不算 */
function commitAll(args) {
  for (const a of args) {
    const t = a.text;
    if (t === '--all') return true;
    if (/^-[A-Za-z]/.test(t) && !t.startsWith('--')) { const k = t.indexOf('m', 1); if ((k > 0 ? t.slice(1, k) : t.slice(1)).includes('a')) return true; }
  }
  return false;
}

const WHOLE_ADD = (t) => t === '-A' || t === '--all' || t === '--no-ignore-removal' || (/^-[a-zA-Z]+$/.test(t) && t.includes('A')) || ['.', './', '.\\', '*', './*', '.\\*', ':/', ':/*', ':(top)', ':(top).'].includes(t);

const UPDATE_ADD = (t) => t === '-u' || t === '--update' || (/^-[a-zA-Z]+$/.test(t) && t.slice(1).includes('u'));

const SUBJECT = '只 git add 这一轮改的和新建的文件：git add <文件1> <文件2>。';

const FIRST_IMPORT = '新建的仓库第一次入仓（还没有任何提交）不拦，可以整仓 add。';

/** 新建的仓库，还没有任何提交：这时整仓 add 带不进"原来就有的改动"，里面什么都还没提交过（议题 #2：新仓首次入仓只能整仓加） */
function freshRepo(root) {
  if (!root || !fs.existsSync(path.join(root, '.git'))) return false;
  try { execFileSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 5000, windowsHide: true, stdio: 'ignore' }); return false; } catch (e) { return !!e && e.status === 1; }
}

function gitIssue(g, docs) {
  if (g.sub === 'add' && g.dyn) {
    // 目录写在变量里，算不出是哪个仓库：不猜（以前往上找到了外面的壳子，说会提交成 gitlink）。整仓 add 照样不许，话说清楚
    if (g.args.some((a) => a.text !== '--' && (UPDATE_ADD(a.text) || WHOLE_ADD(a.text)))) {
      return '[vibe-kit] 这条 git add 的目录写在变量里（' + g.dyn + '），算不出是哪个仓库。git add -A / . / -u 会把那个仓库工作区里原来就有的改动一起加进去。' + SUBJECT
        + '新建的仓库第一次入仓（还没有任何提交）可以整仓 add，目录要写成确定的路径，一个仓库一条：git -C <仓库目录> add -A；'
        + '用循环的话，取值直接写在 for 里（for r in a b c; do git -C "$r" add -A; done）也认得出来。';
    }
    return '';
  }
  if (g.sub === 'add') {
    const root = repoRoot(g.dir) || g.dir;
    const nested = nestedRepos(root);
    const shell = nested.length > 0 || fs.existsSync(path.join(root, 'workspace.yaml'));
    const gitlink = (list) => '[vibe-kit] ' + root + ' 下面套着别的 git 仓库（各个子项目：' + (list.slice(0, 5).map((p) => path.basename(p)).join('、') || '见 workspace.yaml') + '），这样 add 会把它们提交成 gitlink。' + SUBJECT;
    let fresh = null;
    for (const a of g.args) {
      const t = a.text;
      if (t === '--') continue;
      if (!UPDATE_ADD(t) && !WHOLE_ADD(t)) continue;
      if (WHOLE_ADD(t) && shell) return gitlink(nested);
      if (fresh === null) fresh = freshRepo(root);
      if (fresh) { hookLog('guard-commit 新建的仓库第一次入仓（还没有提交），整仓 add 放行：' + root); break; }
      if (UPDATE_ADD(t)) return '[vibe-kit] git add -u 会把你工作区里原来就有的、已跟踪文件的改动一起加进去。' + SUBJECT;
      return '[vibe-kit] git add -A / git add . 会把你工作区里原来就有的改动、没打算提交的新文件一起加进去。' + SUBJECT + FIRST_IMPORT;
    }
    if (nested.length) {
      for (const a of g.args) {
        if (a.text.startsWith('-') || dynamic(a)) continue;
        const p = normKey(path.resolve(g.dir, local(a.text)));
        const hit = nested.filter((r) => normKey(r) === p || normKey(r).startsWith(p + '/'));
        if (hit.length) return gitlink(hit);
      }
    }
  }
  if (g.sub === 'commit') {
    if (commitAll(g.args)) return '[vibe-kit] git commit -a 会把你工作区里原来就有的、已跟踪文件的改动一起提交。先 git add 这一轮改的和新建的文件，再 git commit -m "类型: 内容"。';
    const msg = messageOf(g.args, docs);
    if (msg !== null && !FORMAT.test(msg)) return '[vibe-kit] 提交信息不符合公司规范：' + JSON.stringify(msg) + '\n格式：类型: 内容（类型后面是英文冒号加一个空格，然后直接写内容，只写一行）。\n类型只能是 ' + TYPES.join(' / ') + '。\n例：feat: 新增修改页面';
  }
  return '';
}

// ---------- 提交时：它新建的文件有没有 add ----------
/*
 * git 不会自动带上新文件：它这个会话里用 Write 新建的文件，在要提交的这个仓库里还是"未跟踪"（??），而且这条命令里也没 git add 它，
 * 就拦一次，点名是哪些。属于这次提交的一起 add；为了测试临时加的不提交、测完删掉；它确实要先不提交，原样再执行一次就放行（同样的一批只拦一次）。
 * 过程文件（备份、日志）不在这里说：那些本来就不该提交。
 */
/**
 * 用临时 index 提交（GIT_INDEX_FILE=… git add / commit：把工作区里别人没提交的改动隔在外面）：要提交什么看的是那份 index，
 * 真实的 index 里看不到（议题 #5：文件明明 add 进了临时 index，却说"还没 git add"）。
 * 命令里设了就返回 { file: 那份 index 的路径，算不出来是 '' }；没设返回 null
 */
function tempIndexOf(cmd) {
  const s = String(cmd || '');
  if (!/GIT_INDEX_FILE/.test(s)) return null;
  const m = s.match(/GIT_INDEX_FILE\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/);
  const v = m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
  // /tmp/… 是 Git Bash 自己的路径，这里换算不出来
  if (!v || /\$[({\w]|`|%\w+%/.test(expandHome(v)) || /^\/(tmp|var|dev|proc)(\/|$)/.test(v)) return { file: '' };
  return { file: local(v) };
}

/** 查这个仓库要用的环境变量：没用临时 index 返回 undefined（照常查）；用了、那份 index 找得到，带上它；找不到返回 null（查不了） */
function indexEnv(st, root, dir) {
  if (!st.tempIndex) return undefined;
  const f = st.tempIndex.file;
  if (!f) return null;
  const cands = path.isAbsolute(f) ? [f] : [path.resolve(root, f), path.resolve(dir, f)];
  const hit = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  return hit ? Object.assign({}, process.env, { GIT_INDEX_FILE: hit }) : null;
}

function newFilesIssue(g, st) {
  const j = st.j;
  if (!j || !j.transcript_path || !j.session_id) return '';
  const root = repoRoot(g.dir);
  if (!root) return '';
  const env = indexEnv(st, root, g.dir);
  // 临时 index 还没建出来（同一条命令里现建现用）、路径算不出来：查不了，不猜
  if (env === null) return '';
  const entries = tailEntries(j.transcript_path, 2000000);
  const res = toolResults(entries);
  const rootKey = normKey(root);
  const mine = new Set();
  for (const c of toolCalls(entries)) {
    if (!/^(Write|NotebookEdit)$/.test(c.name) || !res.has(c.id) || res.get(c.id).error) continue;
    const f = String(c.input.file_path || c.input.notebook_path || '');
    if (!f) continue;
    const abs = path.resolve(j.cwd || st.dir, f);
    const k = normKey(abs);
    if (!k.startsWith(rootKey + '/') || /\/\.(vibe|claude)\//.test(k) || !fs.existsSync(abs)) continue;
    if (tidy && (tidy.isProcessFile(abs) || tidy.processDirOf(abs, root, false))) continue;
    mine.add(abs);
  }
  if (!mine.size) return '';
  const rel = [...mine].map((f) => path.relative(root, f).split(path.sep).join('/')).slice(0, 80);
  let out = '';
  try { out = execFileSync('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--'].concat(rel), { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env || process.env }); } catch (e) { return ''; }
  const added = [...st.added];
  const pending = out.split(/\r?\n/).filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((r) => { const k = normKey(path.join(root, r)); return !added.some((a) => k === a || k.startsWith(a.replace(/\/$/, '') + '/')); });
  if (!pending.length) return '';
  const sig = pending.slice().sort().join('|');
  const key = j.session_id + '-newfiles-commit';
  if (readState(key).sig === sig) return '';
  // 记不下"拦过这一批"就放行：不然每次都拦，"原样再执行一次就放行"这条路走不通
  if (!writeState(key, { sig, at: Date.now() })) return '';
  return '[vibe-kit] 你这个会话里新建的这些文件还没 git add，这次提交不会带上它们（git 不会自动加新文件）：' + pending.slice(0, 8).join('、') + (pending.length > 8 ? ' 等 ' + pending.length + ' 个' : '') + '。\n'
    + '- 属于这次提交的（这项任务新加的代码、配置、页面）：一起 git add 再提交。\n'
    + '- 为了测试临时加的（测试页面、调试接口、测试数据、临时脚本）：不要提交，这件事测完就删掉；能放 .vibe/tmp/<事由>/ 的放那里。\n'
    + '- 确实要先留着、不放进这次提交：原样再执行一次这条提交命令就行。';
}

// ---------- 提交方式：关 / 询问 / 自动（用户 2026-10-17 定的，人工和自动都用，替代 autoCommit 档位和 plainCommit） ----------
/*
 * 关：只在用户说了"提交"时提交。询问：用户在就交代改动、用提问框问"提交 / 还要改"；自动模式下用户不在，先不提交、记进报告。
 * 自动：做完一件完整的事才提交（OpenSpec 实施里上次提交之后又勾完任务、审查修复收尾；需求文档定稿；不走 OpenSpec 的改动做完）。
 * 提案产物的提交始终要用户点头，提交方式是自动、需求文档定稿时除外；经验规则文件（套件催着单独提交的）询问、自动都不再问。
 * 怎么算他点了头：会话记录里他最后一次开口（自己打的字、提问框里选的）是"提交"（lib/session.js 的 userSaid）。
 */
function onlyMetadata(g, st) {
  const root = repoRoot(g.dir) || g.dir;
  const rk = normKey(root);
  const added = [...st.added].filter((a) => a === rk || a.startsWith(rk + '/'));
  const kitFile = (a) => /\/\.claude\/rules\/(?:[^/]*lessons-[^/]*|learned-rules)\.md$/i.test(a) || /\/openspec\//i.test(a);
  try {
    const staged = (Array.isArray(g.files) ? g.files : execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], { windowsHide: true, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\x00').filter(Boolean)).map((f) => normKey(path.resolve(root, f)));
    const files = added.concat(staged);
    return files.length > 0 && files.every(kitFile);
  } catch (e) { return false; }
}

/**
 * 这次提交会带上的文件（相对仓库根）：已经暂存的，加上这条命令里 git add 的路径下有改动的。
 * PreToolUse 时同一条命令里的 git add 还没执行，只看暂存区会把"git add 提案 && git commit"当成空提交（2026-10-17 审核问题 1）。
 * Git 出错、超时返回 null，调用方按更严的一边处理。
 */
function commitFiles(g, st) {
  // 跑 tools/commit.js 合成的提交（commitToolRun）：要提交的就是它算好的那几个，不看真暂存区
  if (Array.isArray(g.files)) return g.files.slice();
  const root = repoRoot(g.dir) || g.dir; const rk = normKey(root);
  const opt = { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const out = new Set(execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], opt).split('\0').filter(Boolean));
    const added = [...st.added].filter((a) => a === rk || a.startsWith(rk + '/')).map((a) => path.relative(root, a).split(path.sep).join('/') || '.');
    if (added.length) {
      // -z 的格式：两位状态、一个空格、路径；改名、复制的后面再跟一段原路径
      const parts = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '-uall', '--'].concat(added.slice(0, 50)), opt).split('\0');
      for (let i = 0; i < parts.length; i++) { const e = parts[i]; if (e.length < 4) continue; out.add(e.slice(3)); if (/^[RC]/.test(e)) i++; }
    }
    return [...out];
  } catch (e) { return null; }
}

const PROPOSAL_FILE = /(?:^|\/)openspec\/changes\/(?!archive\/)[^/]+\/(?:proposal\.md|design\.md|tasks\.md|specs\/)/;

function consentIssue(g, st, cfg, docs) {
  const j = st.j || {};
  const msg = messageOf(g.args, docs);
  let es = [];
  try { if (j.transcript_path) es = tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain); } catch (e) { es = []; }
  const permit = userSaid(es, 'commit').ok ? require('../lib/permissions').allow(j, 'commit', repoRoot(g.dir) || g.dir, j.tool_use_id) : { ok: false };
  if (permit.reason && !permit.ok) return '[vibe-kit] ' + permit.reason + '。交代当前改动后重新确认是否提交。';
  let approved = permit.ok;
  // 用户自己说了合并推送（用户 2026-10-28 补充：去掉的是套件的合并推送工具，用户跟 Claude 说合并推送时照做、不拦）：合并时重新提交算在这句话里
  if (!approved) { try { const ps = userSaid(es, 'push'); if (ps.ok && require('../lib/intent').mergeIntent(ps.text)) approved = true; } catch (e) { /* 认不出照原来的规矩 */ } }
  const fl = flowState(j);
  const files = commitFiles(g, st);
  // 读不出要提交哪些文件：后面按提交方式的判断都做不了，没有用户许可就先问（审核问题 13）
  if (files === null) return approved ? '' : '[vibe-kit] 读不出这次要提交哪些文件（Git 超时或出错）。先交代改动，问用户是否提交。';
  const proposalCommit = files.some(f => PROPOSAL_FILE.test(f));
  const S = require('../lib/session'); const P = require('../lib/flow-policy');
  const mode = S.commitModeOf(cfg);
  // 需求文档定稿：提交方式是"自动"才直接提交（需求自动生效时要四份都审过；人工时四份都写完，每份用户都看过）。询问、关都要用户点头（审核问题 2）
  const planRoots = allChanges(st.cwd0).filter(c => flowChanges(j).includes(normKey(c.dir)) && P.points(c.dir, 'proposal').length === 4 && (!cfg.autoMode || P.allDone(c.dir, 'proposal'))).map(c => normKey(c.dir) + '/');
  const automaticPlan = mode === 'auto' && fl.stage === 'plan' && files.length && files.every(f => planRoots.some(d => normKey(path.resolve(repoRoot(g.dir) || g.dir, f)).startsWith(d)));
  if (automaticPlan) return '';
  if (!approved && proposalCommit && fl.stage !== 'apply') return '[vibe-kit] 提案提交要单独确认：先交代定稿内容，问用户是否提交；开工许可不能代替提交许可。';
  if (approved) return '';
  if (mode === 'off') return '[vibe-kit] 提交方式是"关"：不自动提交，也不问。用户说了"提交"再提交，没说就留给用户自己提交，接着做别的。';
  // 经验规则文件（套件自己催着单独提交的 docs: 更新经验规则）：询问、自动都不用再问
  if (onlyMetadata(g, st)) return '';
  if (mode === 'ask') return cfg.autoMode
    ? '[vibe-kit] 提交方式是"询问"，自动模式下用户不在：先不提交，收工时列进全自动报告，等用户回来说。接着做别的。'
    : '[vibe-kit] 提交方式是"询问"：先自己把 diff 过一遍（有没有调试代码、误改、漏改），交代改了什么、怎么验的，用提问框问用户（选项写"提交"和"还要改"）。用户选了提交再提交；说还要改什么，改完再问。';
  // 自动：做完一件完整的事才提交。OpenSpec 实施里，上次提交之后又勾完了任务、或者审查修复刚收尾；做到一半、审查没收尾不提交
  const current = allChanges(st.cwd0).filter((c) => flowChanges(j).some((d) => normKey(d) === normKey(c.dir)));
  if (!(cfg.autoMode || fl.on && fl.stage === 'apply')) return '';
  if (!current.length) return cfg.autoMode ? '[vibe-kit] 这次提交没有对应的当前 OpenSpec 变更，不能借用全自动许可；交代改动后问用户是否提交。' : '';
  const root = repoRoot(g.dir) || g.dir; const baselines = readState('work-baselines');
  const original = new Set(current.flatMap((c) => ((baselines[normKey(c.dir)] || {}).repos || []).filter((r) => normKey(r.root) === normKey(root)).flatMap((r) => r.dirtyFiles || [])));
  if (original.size) { const mixed = files.filter((f) => original.has(f)); if (mixed.length) return '[vibe-kit] 暂存文件在开工前已有用户改动：' + mixed.join('、') + '。先核对 diff 与文件段归属，不能自动全部提交；交代范围后取得用户的明确提交许可。'; }
  const rounds = syncReviewRounds(es, syncReviews(es, st.cwd0));
  // 只有审出了问题、还没处理完的才算"没收尾"（问题表第 25、26 条）：审过之后代码又改了的、到了自动审查上限的不算，以前它们一直挡着，自动提交就永远提交不了
  const open = current.some(c => P.points(c.dir, 'code').some(p => P.fixPending(c.dir, p, cfg))) || current.some(c => { const r = readState('review-rounds')['code|' + normKey(c.dir)]; return r && r.pendingFix && !r.done; });
  if (open) return '[vibe-kit] 审查还没收尾，成立的问题全部修完、验证并审完后一起提交，不逐轮提交。';
  if (S.pendingReviewsIn(toolCalls(es, 0), toolResults(es), current, S.taskNotes(es)).length) return '[vibe-kit] 审查还在运行，等结论回来、修完并验证后一起提交。';
  const since = require('../hooks/verify-gate').lastCommitAt(root);
  const reviewReady = rounds.some((x) => x.key.startsWith('code|') && current.some((c) => normKey(c.dir) === normKey(x.change.dir)) && (x.rec.done || (!cfg.reviewLoop && x.fixed)) && x.rec.at > since);
  // 任务都勾完了（等用户验收、用户报了问题在改）：改完一处就算做完一件事（问题表第 25 条，2026-10-31）。
  // 以前只认"上次提交之后有新勾的任务或刚收尾的审查"，任务全勾完以后改 bug 永远凑不出来，提交方式选了自动也一直攒着
  // 每个当前变更都有任务、而且都勾完了才算（复审 V9：以前还没写 tasks 的变更也算勾完，几个变更里一个勾完就放行别的半成品）
  const allTicked = current.length > 0 && current.every((c) => { try { const T = require('../lib/task-types'); return T.tasks(c.dir).length > 0 && T.automatedLeft(c.dir).length === 0; } catch (e) { return false; } });
  const ready = reviewReady || allTicked || current.some((c) => Object.values(S.syncTicks(c.dir)).some((tick) => tick > since));
  if (!ready) return '[vibe-kit] 提交方式是"自动"，但还没做完一件事：上次提交之后还没有新勾完的任务，也没有刚收尾的审查修复。做完、勾上再提交。';
  return '';
}

/**
 * 普通推送（用户说了推送就直接推）：不带参数（-u 除外）、推到当前分支跟踪的那个远端分支。强推、删远端分支、推到别的分支、
 * 目标看不清（命令里有变量）的返回 false，在确认框里问。原来在 lib/merge-push.js 的 plainAllowed，合并推送取消后挪到这里（2026-10-28）
 */
function plainPush(g) {
  try {
    if (g.dyn) return false;
    const W = require('../lib/workspace');
    const args = g.args.map((a) => a.text);
    if (args.some((a) => a.startsWith('-') && !['-u', '--set-upstream'].includes(a))) return false;
    const root = W.git(g.dir, ['rev-parse', '--show-toplevel']).trim();
    if (!root) return false;
    const ref = W.git(root, ['symbolic-ref', '-q', 'HEAD']).trim();
    if (!ref.startsWith('refs/heads/')) return false;
    const branch = ref.slice(11);
    const remotes = W.git(root, ['remote']).split(/\r?\n/).filter(Boolean);
    const remote = W.git(root, ['config', '--get', 'branch.' + branch + '.remote']).trim() || (remotes.length === 1 ? remotes[0] : '');
    const merge = W.git(root, ['config', '--get', 'branch.' + branch + '.merge']).trim() || ref;
    const pos = args.filter((a) => !a.startsWith('-'));
    if (!remote || pos.length > 2) return false;
    if (pos[0] && pos[0] !== remote) return false;
    if (pos[1] && ![ref, branch, 'HEAD', ref + ':' + merge, branch + ':' + merge.slice(11), 'HEAD:' + merge, 'HEAD:' + merge.slice(11)].includes(pos[1])) return false;
    return true;
  } catch (e) { return false; }
}

// ---------- 跑 tools/commit.js：当成一次 git add + git commit 来查（K3 M09，2026-11-01） ----------
/*
 * commit.js 只提交这个会话改过的文件（lib/edited-files.js 的 commitPlan）。它不能成了绕过提交检查的后门：
 * 这里按它会提交的文件和提交信息合成两条——git add -- <那几个文件>、git commit -m <信息>（g.files 是要提交的文件，
 * commitFiles、onlyMetadata 认它，不看真暂存区）——guard-commit 照 git 的检查走一遍：提交信息格式、提交方式（关 / 询问 / 自动）、
 * 提案材料、过程文件、新文件没带上（--only 只提交一部分时，这个会话新建的别的文件照样点名）。套件自己的文件（含令牌文件）commitPlan 不收。
 * 没拦下的，guard-commit 最后给这次运行记一张票（noteCommitTools）；commit.js 没有票不提交（钩子没跑、出错放行时）。
 * 只看不提交的（help、list、--dry-run）不合成
 */
/** 这一段是不是在跑套件的 tools/commit.js：是的话返回脚本后面的参数（词），不是返回 null */
function commitToolArgs(ws, head, dir) {
  if (!head || head.name !== 'node') return null;
  const rest = ws.slice(head.i + 1);
  const k = rest.findIndex((w) => !String(w.text).startsWith('-'));
  if (k < 0 || dynamicPath(rest[k])) return null;
  const script = path.resolve(dir, local(rest[k].text));
  if (!/[\\/]tools[\\/]commit\.js$/i.test(script)) return null;
  try { if (!require('./session').isKitPath(script, dir)) return null; } catch (e) { return null; }
  return rest.slice(k + 1);
}
function commitToolRun(ws, head, dir, st) {
  const args = commitToolArgs(ws, head, dir);
  if (!args) return null;
  const t = args.map((w) => String(w.text));
  if ((t[0] && /^(help|list|-h|--help)$/i.test(t[0])) || t.includes('--dry-run')) return null;
  let dirWord = null;
  const only = [];
  const msgWords = [];
  for (let i = 0; i < args.length; i++) {
    const x = t[i];
    if (x === '--dir' && args[i + 1]) { dirWord = args[++i]; continue; }
    if (x.startsWith('--dir=')) { dirWord = { text: x.slice(6), raw: String(args[i].raw).replace(/^--dir=/, '') }; continue; }
    if (x === '--only' && args[i + 1]) { only.push(...String(args[++i].text).split(',').map((s) => s.trim()).filter(Boolean)); continue; }
    if (x === '--session' && args[i + 1]) { i++; continue; }
    if ((x === '-m' || x === '--message') && args[i + 1]) { msgWords.push(args[i], args[i + 1]); i++; continue; }
    if (/^-m./.test(x) || x.startsWith('--message=')) msgWords.push(args[i]);
  }
  const dyn = dirWord && dynamicPath(dirWord) ? String(dirWord.raw) : '';
  const at = dirWord && !dyn ? path.resolve(dir, local(dirWord.text)) : dir;
  const root = dyn ? '' : require('./edited-files').repoOf(at);
  const j = st.j || {};
  let plan = { files: [] };
  if (root && j.transcript_path) {
    const E = require('./edited-files');
    plan = E.commitPlan({ entries: E.entriesOf(j.transcript_path), cwd: j.cwd || st.cwd0 || dir, root, only });
  }
  const word = (s) => ({ text: s, raw: JSON.stringify(s) });
  const files = plan.files.map((f) => f.rel);
  const gCommit = { sub: 'commit', args: msgWords, dir: root || at, dyn, files, tool: 'commit.js' };
  if (root) st.commitTools = (st.commitTools || []).concat({ sid: j.session_id, root, files });
  return files.length ? [{ sub: 'add', args: plan.files.map((f) => word(f.abs)), dir: root, dyn: '', tool: 'commit.js' }, gCommit] : [gCommit];
}
/** 这条命令查完、没拦下（放行或要用户确认）：给里面每次 commit.js 记一张票。拦下的不记 */
function noteCommitTools(st) {
  for (const t of (st && st.commitTools) || []) { try { require('./edited-files').writeTicket(t.sid, t); } catch (e) { /* 记不了票：commit.js 不提交，让它改用 git */ } }
}

module.exports = { parseGit, messageOf, pushAnywhere, publishAnywhere, commitAll, gitIssue, tempIndexOf, newFilesIssue, consentIssue, plainPush, commitToolRun, noteCommitTools, TYPES, FORMAT };
