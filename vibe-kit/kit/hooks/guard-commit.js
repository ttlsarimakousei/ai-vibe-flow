'use strict';
/*
 * PreToolUse 钩子（Bash / PowerShell）：看模型要跑的命令。
 *   1. git push 要用户确认：任何写法（git -C x push、cd x && git push、cmd /c、bash -c、powershell -Command 里的）都检查。
 *      用户说了"推送""push"就直接推（用户 2026-10-25 定的）；合并推送 2026-10-28 取消了（用户定的），"合并推送"也按普通推送走。取消、问句、后台通知不算。
 *      20261030 起 push 只留这一道确认（用户定的）：settings 里的 Bash(git push:*) 确认规则去掉了（它按前缀匹配，git -C sub push 本来就绕得过）。
 *      这一道不看任何开关；钩子走路由时，路由不在由命令钩子 guard-push 兜底，路由里没跑成时带 push 的要确认（lib/hook-host.js）。
 *   2. 提交信息要符合公司规范："类型: 内容"（例：feat: 新增修改页面）。heredoc、here-string、-m"x"、-mx 这些写法都认。
 *   3. 不许把原来就有的改动带进提交：git add -A / --all / . / :/ / -u、git commit -a 一律拦；
 *      仓库下面套着别的 git 仓库（壳子）时，add 子项目目录也拦（会被提交成 gitlink，公司红线）。登记成子模块的不算。
 *      新建的仓库第一次入仓（还没有任何提交、下面没套着别的仓库）整仓 add 不拦。git -C 的目录写在变量里的：
 *      是 for 循环的变量、取值写在命令里，就挨个代进去查；代不出来的不猜是哪个仓库。
 *   4. 归档门槛（开关 specGate）：openspec archive、或者把 openspec/changes/<名字> 挪进 archive，要任务全打勾、代码真的审过，
 *      还要用户自测过、说了归档（会话记录里他最后一句话是"归档"，或者提问框里选了"归档"；用户 2026-10-07 定的。这一条不能放行）。
 *  12. 提交方式（配置页"提交方式"，用户 2026-10-17 定的，人工和自动都用）：关——用户说了"提交"才提交；询问——用户在就交代改动、用提问框问，
 *      自动模式下用户不在就先不提交、记进报告；自动——做完一件完整的事（新勾完任务、审查修复收尾、需求文档定稿）才提交。不能放行。
 *  13. 跑 tools/commit.js（只提交本会话改过的文件，2026-11-01 K3）：按它要提交的文件和提交信息合成 git add、git commit，上面 2、3、8、9、12 条照查；
 *      没拦下的记一张票，commit.js 凭票提交，钩子没跑就不提交（lib/guard-git.js 的 commitToolRun、lib/edited-files.js）。
 *   5. 禁止改套件（开关 kitLock）：命令动到套件的文件、直接调路由的 /api、命令里出现 disableAllHooks，都拦。
 *   6. 装了路由时，不许一把结束所有 node 进程（taskkill /IM node.exe 之类），也不许结束路由自己的进程：路由一停，模型连不上、走 HTTP 的检查全部失效。
 *   7. 起服务自测（mvn spring-boot:run、npm run dev、Tomcat 这类）要经过 tools/devserver.js（固定，不做开关）：同一个服务在跑就不重复起；端口在 30000 到 39999 里挑，离项目配置的端口至少 1000。
 *   8. 过程文件别落在项目里（固定，不做开关）：cp 出来的备份、备份目录、重定向出来的日志这类，放 .vibe/tmp/<事由>/；git add 过程文件也拦。同一个路径只拦一次。
 *      临时查看 JAR、ZIP、TAR、7z 等归档的直接解包命令检查实际目标目录，目录联接也查；不能靠重复执行落到项目根。只读列表和流式读取放行。
 *   9. 提交时它这个会话里新建的文件还没 git add（git 不会自动带上新文件）：点名拦一次，同样的一批只拦一次。
 *      用临时 index 提交的（GIT_INDEX_FILE=…）看那份 index；找不到它就不查。
 *  10. Bash 里 cd 和别的命令串在一条里（cd 子项目 && mvn …）：Claude Code 会停下来要人确认（跳过权限模式也问），拦下并给出不用 cd 的写法
 *      （git -C、mvn -f、npm --prefix、devserver.js --cwd、路径写全）。单独一条 cd 不拦。不看开关。
 *  11. 变更没归档之前，它的过程文件先留着（固定，不做开关）：rm .vibe/tmp/<变更名>/ 这类拦下；全自动模式、在流程里，
 *      .vibe/tmp、.vibe/out 里的都先不删。归档之后套件自己清。
 * 兜底放行（lib/feedback.js）：起服务、过程文件、归档门槛、提交信息格式、新文件没 add 这几类拦下时带〔拦截编号〕，
 *   申请过放行的跳过这一类（按"同一件事"认：归档认变更名，别的认这一类检查）；结束进程、改套件、整仓 add / commit -a / gitlink 不放行。
 * 全自动模式（用户不在）：push、发布不弹确认框（没人点，会一直挂着），直接拦下、记进全自动报告，让它接着做别的。
 * 提交时不再查"像密码的内容"（用户 2026-10-17 定的）；套件自己的令牌文件（secrets.json、router-data）不许提交，那道保护在别处，照留。
 * 命令先按 Bash 或 PowerShell 各自的引号和转义规则拆开：heredoc、here-string 的正文是数据，不当命令拆；注释（# 到行尾）去掉；续行先合并；
 * 按没加引号的 && || ; 换行 分成几组，每组再按 | 分段；cd、Push-Location 会跟着算当前目录。
 * 读不出来的（提交信息在变量里、路径藏在变量里）放行：误拦比漏拦更糟。
 * 2026-11-01 起（K 批）这个文件只留调度（analyze、check、handle）：拆命令在 lib/shell-words.js；各类检查在 lib/guard-git.js（1、2、3、9、12 条）、
 *   lib/guard-kit.js（第 5 条和令牌）、lib/guard-process.js（6、7、8、10、11 条）、lib/guard-archive.js（第 4 条）。导出的名字和以前一样。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const archiveExtract = require('../lib/archive-extract');
const { readConfig, readConfigFor, flowState, setFlow, flowTouch, flowChanges, sessionChanges, userSaid, mentionsChange, sessionHome, allChanges, archivedNames, nestedRepos, blockOut, askOut, changeRoots, readState, writeState, updateState, normKey, KIT, CFG_DIR, realish, isKitPath, isKitSkillScript, expandHome, codeReviewIssue, touchChange, isDeferredTask, tailEntries, toolCalls, toolResults, hookLog, cli } = require('../lib/session');
let tidy = null;
try { tidy = require('../lib/tidy.js'); } catch (e) { /* 老版本没有 */ }
let feedback = null;
try { feedback = require('../lib/feedback.js'); } catch (e) { /* 老版本没有 */ }
let lessons = null;
try { lessons = require('../lib/lessons.js'); } catch (e) { /* 老版本没有 */ }
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }
// 拆出去的检查（2026-11-01，K 批：guard-commit 只留调度）
const { stripComments, preprocess, OPEN, CLOSE, splitCommand, scanRedirects, words, dynamic, dynamicPath, local, headOf, repoRoot, CD, PUSHD, POPD, cdTarget, docOf, innerCommand, expandLoopVars } = require('../lib/shell-words');
const { pushAnywhere, publishAnywhere, parseGit, messageOf, commitAll, gitIssue, tempIndexOf, newFilesIssue, consentIssue, plainPush, commitToolRun, noteCommitTools } = require('../lib/guard-git');
const { archiveTarget, archiveIssue } = require('../lib/guard-archive');
const { easyListing, mayTouchSecret, keyFileIssue, kitIssue, lessonIssue, routerApiIssue, readOnlyCommand, hasReaderIn } = require('../lib/guard-kit');
const { killIssue, killAnywhere, serverStart, serverMsg, WRITE_TO, processTarget, keepIssue, cdCompoundIssue, cdCompoundText } = require('../lib/guard-process');

/** 某一道检查自己出错了：照常放行（硬规矩 2），但记一条问题反馈（审核 P13：以前这几处静默跳过，读令牌、改套件、提交许可这几道检查没跑也没人知道） */
function checkFailed(what, j, e) { try { if (feedback && feedback.recordHookError) feedback.recordHookError('guard-commit（' + what + '）', j || {}, e); } catch (err) { /* 记不了就算了 */ } }
// ---------- 主流程 ----------
/**
 * 拦下这条命令。kind 是哪一类检查：server、process、archive、commit-format、new-files 可以申请放行（lib/feedback.js），
 * 这一步申请过、通行证还有效的，这一类就跳过（记下用了哪张），接着查别的；kill、kit、git-scope（整仓 add、commit -a、gitlink）、
 * archive-ok（用户没说归档）、commit-ok（不走 OpenSpec 的提交用户没点头）永远不放行
 */
function setBlock(st, kind, msg, target) {
  if (st.block || !msg) return;
  // 通行证按"同一件事"认：归档认变更名，别的认这一类检查（同一个目录里）
  const t = target || kind + ':' + normKey(st.cwd0);
  let p = null;
  try { p = feedback ? feedback.pickPass(st.passes, kind, st.sig, t, msg) : null; } catch (e) { p = null; }
  if (p) { if (!st.used.includes(p)) st.used.push(p); st.blocked[kind] = msg; return; }
  st.block = msg;
  st.kind = kind;
  st.target = t;
}
function analyze(cmd, ps, st, cfg, depth) {
  // st.securityOnly：check() 开头那一遍，只查读令牌、改套件、经验规则、结束进程（不登记阶段，不受 12 秒预算管；别的检查等正常那一遍）
  if (!st.securityOnly) require('../lib/invocation').phase('分析执行命令');
  const decision = st.securityOnly ? '' : require('../lib/review-runner').decisionIssue(Object.assign({}, st.j, { cwd: st.dir, tool_input: { command: cmd } }));
  if (decision) { setBlock(st, 'review-decision', '[vibe-kit 审查决定] ' + decision); return; }
  // 包装命令换过目录后，相对发布脚本也要按内层的目录检查。
  if (publishAnywhere(cmd, st.dir)) st.publishing = true;
  const { s, docs } = preprocess(cmd, ps);
  if (st.easy === undefined) st.easy = easyListing(cmd, ps);
  if (st.hasReader === undefined) st.hasReader = st.easy ? false : hasReaderIn(cmd, ps, 0, st.dir);
  // 括号里的 cd 只在括号里管用；pushd / popd 按栈来
  const dirs = [];
  for (const group of splitCommand(s, ps, true)) {
    if (group.length === 1 && group[0] === OPEN) { dirs.push({ dir: st.dir, unknown: st.archiveUnknown }); continue; }
    if (group.length === 1 && group[0] === CLOSE) { if (dirs.length) { const d = dirs.pop(); st.dir = d.dir; st.archiveUnknown = d.unknown; } continue; }
    const segs = group.map((seg) => { const r = scanRedirects(seg); const ws = words(r.rest, ps); const doc = docOf(ws, docs); return { redirs: r.list, ws, doc: doc === null ? '' : doc }; });
    // for r in a b c：循环变量的取值记下来，后面 git -C "$r" 的目录就算得出来（取值里还有变量的不记）
    if (!ps && segs.length === 1) {
      const w0 = segs[0].ws;
      if (w0.length >= 4 && w0[0].text === 'for' && w0[2].text === 'in' && /^[A-Za-z_]\w*$/.test(w0[1].text)) {
        const vals = w0.slice(3);
        st.loops = st.loops || {};
        if (vals.length && !vals.some((w) => dynamic(w) || /[*?]/.test(w.raw))) st.loops[w0[1].text] = vals.map((w) => w.text); else delete st.loops[w0[1].text];
      }
    }
    if (!st.block) { const k = killIssue(segs); if (k) setBlock(st, 'kill', k); }
    if (cfg.kitLock !== false && !st.block) { const k = kitIssue(segs, st.dir, docs); if (k) setBlock(st, 'kit', k); }
    if (cfg.kitLock !== false && !st.block) { let k = ''; try { k = lessonIssue(segs, st.dir, docs); } catch (e) { k = ''; checkFailed('改经验规则', st.j, e); } if (k) setBlock(st, 'kit', k); }
    // 令牌和模型的 key：不看"禁止改套件"那个开关，什么时候都不给读
    if (!st.block) { let k = ''; try { k = keyFileIssue(segs, st.dir, st.hasReader, st.easy); } catch (e) { k = ''; checkFailed('读令牌和 key', st.j, e); } if (k) setBlock(st, 'kit', k); }
    const archiveStream = segs.some(x => { const h = headOf(x.ws); return archiveExtract.isArchive(h.name, x.ws.slice(h.i + 1)); });
    for (const x of segs) {
      const ws = x.ws;
      if (!ws.length) continue;
      const head = headOf(ws);
      if (POPD.test(head.name)) { if (st.pushed.length) { const d = st.pushed.pop(); st.dir = d.dir; st.archiveUnknown = d.unknown; } continue; }
      if (CD.test(head.name)) {
        const to = cdTarget(ws.slice(head.i + 1));
        if (PUSHD.test(head.name)) st.pushed.push({ dir: st.dir, unknown: st.archiveUnknown });
        if (!to) continue;
        // cd -：回上一个目录
        if (to.back) { const t = st.dir, u = st.archiveUnknown; st.dir = st.prev || st.dir; st.archiveUnknown = st.prevUnknown; st.prev = t; st.prevUnknown = u; continue; }
        if (!dynamicPath(to)) { st.prev = st.dir; st.prevUnknown = st.archiveUnknown; st.dir = path.resolve(st.dir, local(to.text)); if (path.isAbsolute(local(to.text))) st.archiveUnknown = false; continue; }
        st.prev = st.dir; st.prevUnknown = st.archiveUnknown; st.archiveUnknown = true;
        // 算不出来要去哪、又像是往 ~/.claude 里去：后面的相对路径就没法查了，这种 cd 不放
        if (cfg.kitLock !== false && !st.block && /\.claude|vibe-kit/i.test(String(to.raw))) setBlock(st, 'kit', '[vibe-kit] 这条 cd 要去的目录算不出来（' + to.raw + '），又像是套件在用户目录里的东西。写成确定的路径（~/.claude/… 或者 $HOME/.claude/…），不要用别的变量拼。');
        continue;
      }
      const inner = innerCommand(ws, head, st.dir, docs);
      if (inner && depth < 3) {
        const outer = st.dir, unknown = st.archiveUnknown;
        if (inner.dir) st.dir = inner.dir;
        analyze(inner.cmd, inner.ps, st, cfg, depth + 1);
        if (inner.dir) { st.dir = outer; st.archiveUnknown = unknown; }
        continue;
      }
      // 经过 devserver.js 起的：它自己查重、查端口，这一段里带的启动命令不拦（只免这一段，同一条命令里别的段照查）
      if (st.securityOnly) continue;
      const viaTool = ws.some((w) => /devserver\.js$/i.test(w.text));
      if (!viaTool && !st.block) { const s = serverStart(ws, head, st.dir); if (s) setBlock(st, 'server', serverMsg(s, st.dir)); }
      if (tidy && !st.block) { const p = processTarget(x, head, st.dir); if (p && tidy.blockOnce(st.j.session_id, p.key)) setBlock(st, 'process', tidy.processMsg(p.show)); }
      if (!st.block && !st.archiveUnknown) {
        const outputs = archiveStream ? x.redirs.map(r => ({ text: r.target, raw: r.target })) : [];
        if (archiveStream && WRITE_TO.test(head.name)) {
          const rest = ws.slice(head.i + 1);
          const i = rest.findIndex(w => /^-(?:filepath|path|literalpath)$/i.test(w.text));
          const dest = i >= 0 ? rest[i + 1] : rest.find(w => !w.text.startsWith('-'));
          if (dest) outputs.push(dest);
        }
        const p = archiveExtract.issue(head.name, ws.slice(head.i + 1), st.dir, outputs);
        if (p) setBlock(st, 'process', p.message, 'extract:' + p.key);
      }
      if (tidy && !st.block) { let k = ''; try { k = keepIssue(x, head, st.dir, st, cfg); } catch (e) { k = ''; checkFailed('留过程文件', st.j, e); } if (k) setBlock(st, 'keep', k); }
      if (cfg.specGate !== false && !st.block) { const t = archiveTarget(ws, head, st.dir); if (t) { const a = archiveIssue(t, st.dir, st.j); if (a) setBlock(st, a.noBypass ? 'archive-ok' : 'archive', a.msg, 'archive:' + a.name.toLowerCase()); } }
      // 跑 tools/commit.js（只提交本会话改过的文件，K3）：按它要提交的文件和提交信息合成 git add、git commit，下面照 git 的检查走
      let tool = null;
      try { tool = commitToolRun(ws, head, st.dir, st); } catch (e) { tool = null; checkFailed('commit.js', st.j, e); }
      const g0 = tool ? tool[0] : parseGit(ws, st.dir);
      if (!g0) continue;
      // 目录写在循环变量里（for r in a b c; do git -C "$r" …）：取值挨个代进去查；代不出来的按"算不出是哪个仓库"查
      let gits = tool || [g0];
      if (!tool && g0.dyn) { const ex = expandLoopVars(ws, st.loops); const list = ex ? ex.map((w2) => parseGit(w2, st.dir)).filter(Boolean) : []; if (list.length && !list.some((x) => x.dyn)) gits = list; }
      for (const g of gits) {
      if (g.sub === 'push') { st.pushes.push(g); st.push = st.push || '[vibe-kit] 这是 git push' + (g.dyn ? '' : '（' + path.basename(repoRoot(g.dir) || g.dir) + '）') + '，推到远端要你确认。'; continue; }
      // 同一条命令里前面 git add 过的文件，提交时算已经加进去了
      if (g.sub === 'add' && !g.dyn) {
        for (const a of g.args) {
          if (a.text === '--' || a.text.startsWith('-') || dynamic(a)) continue;
          const abs = path.resolve(g.dir, local(a.text));
          st.added.add(normKey(abs));
          // 过程文件不提交。文件已经不在了的是在记删除，不管；. 和 :/ 这种整仓 add 由下面的提交检查拦
          if (!tidy || st.block || !fs.existsSync(abs) || /^(\.|\.\/|:\/?)$/.test(a.text)) continue;
          let isDir = /[\\/]$/.test(a.text);
          try { isDir = isDir || fs.statSync(abs).isDirectory(); } catch (e) { /* 不存在 */ }
          const p = tidy.processPath(abs, st.dir, isDir);
          if (p) { if (tidy.blockOnce(st.j.session_id, p.key)) setBlock(st, 'process', '[vibe-kit 过程文件] ' + p.show + ' 是过程文件（备份、日志、临时文件），不要提交：从这次 git add 里去掉，删掉或者挪进 .vibe/tmp/<事由>/。确实是项目要用的，原样再执行一次就行。'); continue; }
          if (!isDir) continue;
          const inside = tidy.untrackedProcessIn(abs, st.dir);
          if (inside.length && tidy.blockOnce(st.j.session_id, abs)) setBlock(st, 'process', '[vibe-kit 过程文件] git add ' + a.text + ' 会把里面还没进 git 的过程文件一起带上：' + inside.join('、') + '。先把它们删掉或者挪进 .vibe/tmp/<事由>/，或者只 add 要提交的文件。确实要一起提交，原样再执行一次就行。');
        }
      }
      // 提交信息格式可以申请放行；整仓 add、commit -a、gitlink（公司红线）不行
      if (cfg.commitCheck && !st.block) { const c = gitIssue(g, docs); if (c) setBlock(st, /提交信息不符合公司规范/.test(c) ? 'commit-format' : 'git-scope', c); }
      // 提案在别人电脑上也要能实施：命令写入和已经暂存的产物同样查，不能只守编辑工具。
      if (g.sub === 'commit' && !g.dyn && cfg.specGate !== false && !st.block) {
        try {
          const root = repoRoot(g.dir) || g.dir;
          // commit.js 合成的提交：查它要提交的那几个（g.files），不看真暂存区
          const staged = Array.isArray(g.files) ? g.files : execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\x00').filter(Boolean);
          const check = require('../lib/proposal-files');
          const found = [];
          for (const f of staged) {
            const abs = path.resolve(root, f); const art = require('../lib/session').artifactOf(abs);
            if (!art || art.kind === 'revisions' || /\/changes\/archive\//i.test(normKey(abs))) continue;
            const added = [...st.added].some((p) => normKey(abs) === p || normKey(abs).startsWith(p + '/'));
            const text = added ? fs.readFileSync(abs, 'utf8') : execFileSync('git', ['-C', root, 'show', ':' + f], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
            found.push(...check.issuesIn(text, art));
          }
          const dirs = new Map();
          for (const p of st.added) { const a = require('../lib/session').artifactOf(p); if (a && a.kind !== 'revisions' && !/\/changes\/archive\//i.test(p)) dirs.set(normKey(a.dir), a); }
          // git add 变更目录和逐文件 add 都要查；目录本身不是 artifactOf 能识别的产物。
          for (const c of allChanges(root)) if ([...st.added].some((p) => normKey(c.dir) === p || normKey(c.dir).startsWith(p + '/'))) {
            const a = require('../lib/session').artifactOf(path.join(c.dir, 'proposal.md'));
            if (a) dirs.set(normKey(a.dir), a);
          }
          for (const a of dirs.values()) found.push(...check.changeIssues(a));
          if (found.length) setBlock(st, 'spec', '[vibe-kit] 提案材料不能交付：' + found.slice(0, 3).join('\n'));
        } catch (e) { /* 检查出错照常放行，由收工再次核对 */ }
      }
      // 按提交方式判断能不能提交（consentIssue）。不能放行
      if (g.sub === 'commit' && !st.block && !commitAll(g.args)) { let c = ''; try { c = consentIssue(g, st, cfg, docs); } catch (e) { c = ''; checkFailed('提交许可', st.j, e); } if (c) setBlock(st, 'commit-ok', c); }
      // 下面两道要去那个仓库里看：目录算不出来的不查
      if (g.dyn) continue;
      if (g.sub === 'commit' && cfg.commitCheck && !st.block && !commitAll(g.args)) { const n = newFilesIssue(g, st); if (n) setBlock(st, 'new-files', n); }
      // 提交前看有没有把密码、key 带进去：要用户确认，不拦
      }
    }
  }
}
/** 给查库、查 redis 的工具留的条子：这个目录里的这个会话现在算不算全自动（state/tool-flow.json） */
function noteToolFlow(j, cfg) {
  try {
    const k = normKey(path.resolve(j.cwd || process.cwd()));
    const now = Date.now();
    updateState('tool-flow', (o) => {
      const by = o.byCwd && typeof o.byCwd === 'object' ? o.byCwd : {};
      for (const x of Object.keys(by)) if (now - (Number(by[x] && by[x].at) || 0) > 600000) delete by[x];
      // 只在做任务那一段（apply）按全自动：写需求那一段的"需求自动"不能让查库工具改库不要确认串（审核问题 16）
      by[k] = { auto: cfg.autoMode === true && flowState(j).stage === 'apply', at: now, sid: String(j.session_id || '').slice(0, 8) };
      return { byCwd: by, at: now };
    });
  } catch (e) { /* 留不了：工具按用户不在算，只会更严 */ }
}
/** 只查安全的那一遍：拦下就照正常那一遍的说法返回（带拦截编号、串着 cd 的顺带说），没拦返回 null；自己出错照常放行、记反馈 */
function securityFirst(j, cmd) {
  try {
    const ps = j.tool_name === 'PowerShell';
    const cfg0 = readConfig(j);
    const cwd0 = path.resolve(j.cwd || process.cwd());
    const st = { dir: cwd0, cwd0, pushed: [], pushes: [], block: '', kind: '', target: '', ask: '', push: '', publishing: false, j, added: new Set(), passes: [], used: [], blocked: {}, sig: '', loops: {}, securityOnly: true };
    { const k = killAnywhere(cmd, ps); if (k) setBlock(st, 'kill', k); }
    if (!st.block) analyze(cmd, ps, st, cfg0, 0);
    if (!st.block) return null;
    let tail = '';
    try { if (feedback) tail = feedback.registerBlock(j, st.kind, feedback.sigOf([j.tool_name || 'Bash', cmd.trim()]), st.block, (j.tool_name || 'Bash') + '：' + cmd, st.target); } catch (e) { /* 记不了编号也照样拦 */ }
    // 全自动模式的那句和正常那一遍一样（真拦下时才算流程状态，慢一点没关系）
    let auto = false; try { auto = !!readConfigFor(j).autoMode; } catch (e) { auto = false; }
    if (!tail && auto) {
      tail = '\n全自动模式：我不在，不要停下等我。这条命令不要跑：照上面说的换一个做法；换不了，就把这一步留给我，写进最后的交代，接着做别的。';
      try { if (report) report.note(j, { kind: 'hand', title: '没让它跑：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail: st.block.split(/\r?\n/)[0].replace(/^\[vibe-kit[^\]]*\]\s*/, '') }); } catch (e) { /* 记不了不影响 */ }
    }
    let cdHit = null; try { cdHit = ps ? null : cdCompoundIssue(cmd, j.cwd); } catch (e) { cdHit = null; }
    const cdNote = cdHit ? '\n另外，这条命令里 cd 和别的命令串在一起，Claude Code 会停下来等人点确认：改的时候把 cd 去掉，git 用 git -C <目录>，Maven 用 mvn -f <目录>/pom.xml，npm 用 npm --prefix <目录>，别的写完整路径。' : '';
    return blockOut('PreToolUse', st.block + tail + cdNote);
  } catch (e) { checkFailed('安全检查前置', j, e); return null; }
}
function check(j) {
  // IDEA 的终端、工具路由也走现有检查；认不出是 IDEA 的 MCP 只查路径参数读不读套件令牌（lib/idea-tools.js）。
  if (/^mcp__/.test(String(j.tool_name || ''))) {
    const out = require('../lib/idea-tools').handle(j); if (out) return out;
    const issue = require('../lib/flow-policy').actionIssue(j);
    return issue ? blockOut('PreToolUse', '[vibe-kit] ' + issue) : null;
  }
  const cmd = String((j.tool_input && j.tool_input.command) || '');
  if (!cmd.trim()) return null;
  // 安全检查先跑（审核 P13，2026-11-01 H2）：读令牌、改套件、改经验规则、结束进程这几道不依赖流程状态，放在读开关（可能要算整个仓库的指纹）、
  // 读 3 MB 会话记录之前，也不登记阶段、不受 12 秒预算管。以前排在后面，预算用完时整条命令放行，这几道等于没查
  const early = securityFirst(j, cmd);
  if (early) return early;
  // 前面这几段各记一个阶段名：12 秒预算在第一次登记阶段之前花完时，报错里以前只写"开始"，看不出慢在哪（旧 #181）
  const I = require('../lib/invocation');
  I.phase('命令：读开关');
  let cfg = readConfigFor(j);
  // 建变更：不在流程里要有用户的话才行（用户 2026-11-03 定的：不按模糊的话进流程）
  if (!flowState(j).on && /(^|[\s;&|("'])openspec(\.cmd)?\s+new\s+change\b/i.test(cmd) && !require('../lib/session').entryVoice(j)) return blockOut('PreToolUse', '[vibe-kit] 用户没说要走 OpenSpec，不建变更。改动较大的先用提问框问："要用 /opsx:explore 探索吗（会进入 vk 流程）"，选项写"探索""直接改"；选探索再建。');
  // 查库、查 redis 的工具只看得到开关，看不到这个会话在不在流程里：跑它们之前留一张条子（按当前目录记，工具那头两分钟内认），
  // 说这个会话现在算不算全自动。不留的话，开关开着、用户却在场的会话里，工具会照"用户不在"来
  if (cfg.autoSwitch && /\b(db\.py|redis\.js)\b/i.test(cmd)) noteToolFlow(j, cfg);
  const ps = j.tool_name === 'PowerShell';
  // cd 和别的命令串在一条里。放在改套件、读令牌那几道后面查：那几道的话更要紧（它们拦下时顺带提一句）
  I.phase('命令：串着 cd');
  let cdHit = null;
  try { cdHit = ps ? null : cdCompoundIssue(cmd, j.cwd); } catch (e) { cdHit = null; }
  // 不走拦截编号的几处（串着 cd、关钩子、调路由的接口、全自动下的 push）也数一笔：哪条规矩拦得多，使用情况里要看得到
  const counted = (kind, text) => { try { if (feedback && feedback.countBlock) feedback.countBlock(kind, text, String(j.session_id || '')); } catch (e) { /* 数不了不影响 */ } return blockOut('PreToolUse', text); };
  I.phase('命令：审查决定');
  const decisionIssue = require('../lib/review-runner').decisionIssue(j);
  if (decisionIssue) return counted('review-decision', '[vibe-kit 审查决定] ' + decisionIssue);
  const cdBlock = () => {
    if (!cdHit) return null;
    hookLog('guard-commit 拦下串着 cd 的命令：' + cmd.replace(/\s+/g, ' ').slice(0, 100));
    return counted('cd', cdCompoundText(cdHit, j.cwd));
  };
  I.phase('命令：改套件和路由接口');
  if (cfg.kitLock !== false) {
    // disableAllHooks 会把套件的检查一起关掉：只在命令要写东西的时候拦。只读的命令（grep 排查、cat）、提交信息、文档里提到这个词不拦
    if (/disableAllHooks/i.test(cmd) && !readOnlyCommand(cmd, ps, j.cwd) && (/settings[\w.-]*\.json/i.test(cmd) || /(>|\b(set-content|sc|out-file|add-content|ac|tee|tee-object)\b|sed\s+-i|writefile|write_text|\.write\s*\(|\bnode(\.exe)?\s+-e\b|\bpython3?(\.exe)?\s+-c\b)/i.test(cmd))) return counted('kit', '[vibe-kit] 不许写 disableAllHooks：它会把套件的所有检查一起关掉。钩子拦错了就把原因告诉用户，由用户来定；不要绕过。');
    const api = routerApiIssue(cmd, ps, j.cwd);
    if (api) return counted('kit', api);
  }
  // push 不看任何开关，没有当场授权就确认；拆命令没认出来的写法由 pushAnywhere 兜底
  I.phase('命令：发布和推送');
  const publishing = publishAnywhere(cmd, j.cwd);
  // 推送：用户说了"推送""push"就直接推（用户 2026-10-25 定的）。合并推送（合并预览、计划、合成一条）2026-10-28 取消（用户定的），"合并推送"也算说了推送
  let pushSaid = { ok: false, text: '' };
  try { if (j.transcript_path) pushSaid = userSaid(tailEntries(j.transcript_path, 3000000), 'push'); } catch (e) { pushSaid = { ok: false, text: '' }; }
  const publishNotice = '[vibe-kit] 这条命令会把 vibe-kit 的安装包发布到团队的 GitLab 仓库（里面有 git push，同事的电脑会跟着更新），发布要你确认。';
  const pushAsk = pushAnywhere(cmd, ps) ? '[vibe-kit] 这条命令里有 git push，推到远端要你确认。' : publishing ? publishNotice : '';
  if (cfg.kitLock === false && !pushAsk && !mayTouchSecret(cmd, j.cwd) && !/>/.test(cmd) && !/\.(sh|ps1|bat|cmd)\b/i.test(cmd) && !/commit\.js/i.test(cmd) &&!/\b(git|openspec|mv|move|move-item|mi|rename-item|rni|ren|robocopy|cmd|bash|sh|powershell|pwsh|taskkill|stop-process|spps|kill|pkill|killall|wmic|mvnw?|gradlew?|npm|cnpm|pnpm|yarn|npx|vite|vue-cli-service|webpack|webpack-dev-server|http-server|live-server|nodemon|catalina|startup|java|python3?|py|flask|uvicorn|gunicorn|cp|copy|xcopy|copy-item|cpi|tee|tee-object|out-file|set-content|sc|add-content|ac|xargs|start|start-process|saps|invoke-expression|iex|call|nohup|env|cross-env|rm|rmdir|rd|del|erase|remove-item|ri|unlink|find|jar|tar|gtar|bsdtar|unzip|7z|7za|7zr|7zz|expand-archive)\b/i.test(cmd)) return cdBlock();
  const cwd0 = path.resolve(j.cwd || process.cwd());
  const st = { dir: cwd0, cwd0, pushed: [], pushes: [], block: '', kind: '', target: '', ask: '', push: '', publishing: false, j, added: new Set(), passes: [], used: [], blocked: {}, sig: '', loops: {}, tempIndex: tempIndexOf(cmd) };
  // 先按名字挑出进程再结束的写法（Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process）：拆成组之后认不出来，整条看一遍
  I.phase('命令：结束进程');
  if (!st.block) { const k = killAnywhere(cmd, ps); if (k) setBlock(st, 'kill', k); }
  // 兜底放行：这个会话里申请过、还能用的通行证
  I.phase('命令：放行记录');
  const action = (j.tool_name || 'Bash') + '：' + cmd;
  try { if (feedback) { st.sig = feedback.sigOf([j.tool_name || 'Bash', cmd.trim()]); st.passes = feedback.validPasses(cfg, j); } } catch (e) { st.passes = []; }
  analyze(cmd, ps, st, cfg, 0);
  if (st.publishing) st.push = publishNotice;
  else if (!st.push && pushAsk) st.push = pushAsk;
  if (st.block) {
    let tail = '';
    try { if (feedback && st.sig) tail = feedback.registerBlock(j, st.kind, st.sig, st.block, action, st.target); } catch (e) { /* 记不了编号也照样拦 */ }
    // 不能放行的（改套件、读令牌、结束路由、整仓 add）：全自动模式下不让它停下等人。
    // 过程文件先留着那一道不算：它本来就不用做什么，也没有要留给用户的事
    if (!tail && cfg.autoMode && st.kind !== 'keep') {
      tail = '\n全自动模式：我不在，不要停下等我。这条命令不要跑：照上面说的换一个做法；换不了，就把这一步留给我，写进最后的交代，接着做别的。';
      try { if (report) report.note(j, { kind: 'hand', title: '没让它跑：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail: st.block.split(/\r?\n/)[0].replace(/^\[vibe-kit[^\]]*\]\s*/, '') }); } catch (e) { /* 记不了不影响 */ }
    }
    // 这条命令还串着 cd：一起说，免得改完这一处、再跑又被拦一次
    const cdNote = cdHit ? '\n另外，这条命令里 cd 和别的命令串在一起，Claude Code 会停下来等人点确认：改的时候把 cd 去掉，git 用 git -C <目录>，Maven 用 mvn -f <目录>/pom.xml，npm 用 npm --prefix <目录>，别的写完整路径。' : '';
    return blockOut('PreToolUse', st.block + tail + cdNote);
  }
  const cb = cdBlock();
  if (cb) return cb;
  const actionIssue = require('../lib/flow-policy').actionIssue(j);
  if (actionIssue) return counted('manual-action', '[vibe-kit] ' + actionIssue);
  // 全自动模式：用户不在，确认框没人点，会一直挂着。push、发布直接拦下，记进报告；提交里像有密码的放行，记进报告
  // 推送代码的授权不能用于发布内网安装包，发布仍单独确认。
  // 普通 git push（用户 2026-10-25 定的，问题反馈表第 5 条）：用户说了"推送""push"就直接推，几笔提交都一样，不出推送计划；
  // 壳子里几个仓库各推一次。强推、删远端分支、推到别的分支在确认框里问
  const pushes = st.publishing ? [] : st.pushes;
  let pushConfirm = false;
  if (pushes.length) {
    const noteHand = (detail) => { if (cfg.autoMode) { try { if (report) report.note(j, { kind: 'hand', title: '它想执行 git push，没让做：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail }); } catch (e) { /* 记不了也拦 */ } } };
    if (!pushSaid.ok) { noteHand('用户没说推送'); return counted('auto-push', '[vibe-kit 推送] 这条命令里有 git push，用户没说推送。用户说"推送""push"再推（直接推，不用推送计划）。' + (cfg.autoMode ? '全自动模式也一样：提交留在本地，最后的交代里说一句哪些还没推。' : '')); }
    if (!pushes.every((g) => plainPush(g))) pushConfirm = true;
  }
  if (pushConfirm) st.push = '[vibe-kit] 这条 git push 带了强推、删远端分支这类参数，或者推到的不是当前分支跟踪的那个远端分支，要你确认。';
  const pushRoots = pushes.length ? [...new Set(pushes.map((g) => repoRoot(g.dir) || g.dir))] : [repoRoot(st.dir) || st.dir];
  // 只在引号、命令替换里认出来的 push（拆不出是哪条 git push）：查不了推到哪、是不是强推，用户说过推送也要确认（复审 S1）
  const pushApproved = !!st.push && !st.publishing && pushSaid.ok && !pushConfirm && pushes.length > 0 && pushRoots.every((r) => require('../lib/permissions').allow(j, 'push', r, j.tool_use_id).ok);
  // 没拦下（放行，或者要用户确认）：这条命令里跑 tools/commit.js 的，各记一张票，commit.js 凭票提交（拦下的不记）
  const pass = (out) => { noteCommitTools(st); return out; };
  if (cfg.autoMode) {
    if (st.push && !pushApproved) {
      hookLog('guard-commit 全自动模式不 push：' + cmd.slice(0, 80));
      try { if (report) report.note(j, { kind: 'hand', title: '它想' + (/发布/.test(st.push) ? '发布安装包' : '执行 git push') + '，没让做：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail: '推到远端要你自己来' }); } catch (e) { /* 记不了不影响 */ }
      return counted('auto-push', '[vibe-kit] 全自动模式：' + (/发布/.test(st.push) ? '发布' : 'push') + '留给用户做，已经记进全自动报告。不要再试，也不要等：提交留在本地，接着做别的；最后的交代里说一句哪些提交还没推。');
    }
    if (st.used.length) return pass(feedback.bypassOutcome(st.used, cfg, j, st.blocked, action));
    return pass(null);
  }
  const ask = pushApproved ? '' : st.push;
  if (st.used.length) {
    const out = feedback.bypassOutcome(st.used, cfg, j, st.blocked, action);
    // 放行申请和 push 确认一起问
    if (ask) return pass(askOut(ask + (out ? '\n' + out.hookSpecificOutput.permissionDecisionReason : '')));
    return pass(out);
  }
  if (ask) return pass(askOut(ask));
  return pass(null);
}
/**
 * 检查都过了、照常放行的命令：里面以 openspec 开头的段，改成调用套件自带的那份（lib/openspec.js，用户 2026-10-17 定的集成 OpenSpec）。
 * 用 PreToolUse 的 updatedInput 改写，2.1.120、2.1.259、2.1.289 实测都支持。项目还没初始化 OpenSpec 的先初始化。
 * 检查拦下、要问的照旧（不改写）；自带的用不了（Node 版本不够）、出错，都让原命令照常跑
 */
function handle(j) {
  const out = check(j);
  if (out || /^mcp__/.test(String(j.tool_name || ''))) return out;
  try {
    const O = require('../lib/openspec');
    const next = O.rewrite(String((j.tool_input && j.tool_input.command) || ''), j.tool_name === 'PowerShell');
    if (!next) return out;
    // 只查版本、帮助的（openspec --version、--help、-v）不建 openspec/（审核 P15）
    const cmdText = String((j.tool_input && j.tool_input.command) || '');
    const infoOnly = /\bopenspec(?:\.cmd)?\s+(?:--version|-v|-V|--help|-h|help)\b/i.test(cmdText) && !/\bopenspec(?:\.cmd)?\s+(?!--version|-v\b|-V\b|--help|-h\b|help\b)[\w-]/i.test(cmdText);
    const at = infoOnly ? '' : O.ensureRoot(j.cwd || process.cwd());
    if (at) hookLog('guard-commit 自带的 OpenSpec 在 ' + at + ' 建了 openspec/');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: Object.assign({}, j.tool_input, { command: next }) } };
  } catch (e) { try { feedback.recordHookError('guard-commit OpenSpec 改写', j, e); } catch (x) { /* 记不了也放行 */ } return out; }
}

module.exports = { handle, preprocess, stripComments, splitCommand, words, scanRedirects, parseGit, messageOf };
// 命令方式下出错、超出 12 秒预算：别的检查照旧放行，像推送的不放行（push 只留钩子这一道确认，复审 S3）
if (require.main === module) cli(handle, { onError: (j, e) => require('../lib/session').pushFailOut(j, (e && e.message) || e) });
