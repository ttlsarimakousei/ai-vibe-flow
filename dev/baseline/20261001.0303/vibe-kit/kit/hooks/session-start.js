'use strict';
/*
 * SessionStart 钩子：会话一开始（新开、/clear、压缩之后、恢复）就把这几样东西确定性地交给模型，不指望它自己想起来去读：
 *   1. 项目说明 .vibe/project.md —— /ttls-onboard 查到的"怎么编译、怎么快检、怎么启动、什么编码"。只在本机，不进仓库
 *   2. 交接记录 .vibe/handover.md —— 上一个会话用 /ttls-handover 写的，七天内的才带；只在新开和 /clear 时带
 *   3. 这个目录是不是一层"壳子"（下面套着各个子项目，各是独立的 git 仓库）—— 是的话列出子项目，告诉它在这一层对子项目跑命令怎么写（不 cd：git -C、mvn -f、npm --prefix）；不是壳子也提一句 Bash 里别把 cd 和别的命令串在一条里
 * 本机环境（JDK、Maven 在哪）不在这里：它写在全局约定里，每个会话本来就能看到。
 * 输出用 hookSpecificOutput.additionalContext。任何异常都静默退出。
 *
 * 交接之后自动续上（开关 autoResume，默认关）：刚写好的交接记录（一小时内、还没用过），在 /clear 或重新启动之后，用 initialUserMessage
 * 替用户说第一句话，新会话不用等人开口就接着干。/clear 本身只能用户自己敲，模型和钩子都触发不了。这个字段旧版本不认，所以默认关：
 * 关着时用户说一句"继续"，由 task-anchor 把交接记录接上。
 * 顺带两件事：当前目录和各个子项目里已经有 .vibe/ 的，确保它在 .gitignore 里；给模型路由兜底：
 *   Claude Code 指着本机的路由、路由却没在跑（登录后自动启动被公司策略拦了、进程被杀了），
 * 就悄悄在后台把它拉起来，没有窗口。不等它起好——它不到一秒就能起来，而你打完第一句话要好几秒。
 */
const fs = require('fs');
const path = require('path');
const { noteSessionHome, atHome, subdirs, nestedRepos, isShell, cleanState, KIT, ensureVibeIgnored, readState, writeState, normKey, hookLog, readConfig, handoverStale, changeRoots, allChanges, archivedSince, refreshPlan, planUnlisted, planMissingInfo, recordConvBaseline, kitCodeDrift, cli } = require('../lib/session');

const MAX_PROJECT_CHARS = 4000;
function findUp(start, rel, levels) {
  let d = start;
  for (let i = 0; i < levels; i++) { const f = path.join(d, rel); if (fs.existsSync(f)) return f; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}
const read = (f) => { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t.trim(); };
/** 本机这个端口有没有程序在听（最多等 400 毫秒） */
function portOpen(port) {
  return new Promise((resolve) => {
    if (!(Number(port) > 0)) return resolve(false);
    const s = require('net').connect({ host: '127.0.0.1', port: Number(port) });
    s.setTimeout(400, () => { s.destroy(); resolve(false); });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

/** 设置里有没有登记走路由的 HTTP 钩子（那时路由必须活着，检查才生效） */
function httpHooksRegistered() {
  try { return require('../lib/hook-health.js').httpRegistered(); } catch (e) { return false; }
}
async function ensureRouter() {
  try {
    const svcFile = path.join(KIT, 'router', 'service.js');
    if (!fs.existsSync(svcFile)) return;
    const svc = require(svcFile);
    // Claude Code 指着这个路由、或者钩子走的是这个路由，才管
    let base = process.env.ANTHROPIC_BASE_URL || '';
    if (!base) { try { base = String((JSON.parse(read(path.join(path.dirname(KIT), 'settings.json'))).env || {}).ANTHROPIC_BASE_URL || ''); } catch (e) { /* 没有 */ } }
    let pointed = false;
    try { const u = new URL(base); pointed = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && String(u.port || 80) === String(svc.portOf()); } catch (e) { /* 没指 */ }
    if (!pointed && !httpHooksRegistered()) return;
    await svc.ensureRunning();
  } catch (e) { /* 兜底失败不能影响会话启动 */ }
}

async function handle(j) {
  let result = null;
  // 记下这个会话在哪个目录、会话记录在哪：记问题反馈的工具（tools/feedback.js）拿不到会话号，靠这个找
  try { require('../lib/feedback.js').noteSession(j); } catch (e) { /* 记不了不影响会话开始 */ }
  // 该检查更新了、或者有还没上报的问题：甩一个后台进程去做（只看一眼状态文件，不等它）
  try { require('../lib/updater.js').kick('会话开始'); } catch (e) { /* 老版本没有，或者甩不出去：不影响会话开始 */ }
  try {
    const source = String(j.source || 'startup');
    // 使用情况：会话怎么来的（新开、恢复、/clear、压缩后）、今天用的套件版本
    try { const U = require('../lib/usage.js'); U.bump('session.' + (/^(startup|resume|clear|compact)$/.test(source) ? source : 'other')); U.seen('kit', fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim()); } catch (e) { /* 数不了不影响会话开始 */ }
    // 这个会话是在哪个目录启动的：压缩、/clear 之后这里收到的是"现在所在的目录"（模型单独 cd 过就不是启动目录了），项目级的事照启动目录来
    if (source !== 'compact') noteSessionHome(j);
    j = atHome(j);
    const cwd = path.resolve(j.cwd || process.cwd());
    // 压缩之后：之前"选了再做一会儿"、全自动"这一段已经提醒过写交接记录"、"快到网关上限说过了"的记录作废，重新到线再说
    if (source === 'compact' && j.session_id) { const k = j.session_id + '-handover'; const h = readState(k); if (h.askedAtPct != null || h.autoAtPct != null || h.gwAsked || h.gwNoted || h.gwStop) writeState(k, Object.assign({}, h, { askedAtPct: null, autoAtPct: null, gwAsked: false, gwNoted: false, gwStop: false, at: Date.now() })); }
    const out = [];

    // 壳子：外面一层放 openspec、文档、.claude，里面是各个子项目，子项目各是独立的 git 仓库。看实际结构认，不依赖标志文件；
    // 普通的单个项目（自己有 pom.xml、package.json、src 这些）就算下面有别的 git 仓库也不算壳子
    const deep = fs.existsSync(path.join(cwd, 'workspace.yaml'));
    const repos = nestedRepos(cwd);
    const shell = isShell(cwd);
    if (shell) {
      const names = repos.slice(0, 12).map((r) => path.relative(cwd, r).split(path.sep).join('/'));
      out.push('这个目录是一层壳子：放 openspec、文档这些过程资产，代码在下面的子项目里' + (names.length ? '（' + names.join('、') + (repos.length > 12 ? ' 等 ' + repos.length + ' 个' : '') + '）' : '') + '。每个子项目是独立的 git 仓库。在这一层对子项目跑命令不要 cd（cd 和别的命令串在一条里，Claude Code 会停下来要人确认）：git 用 git -C <子项目目录>，Maven 用 mvn -f <子项目目录>/pom.xml，npm 用 npm --prefix <子项目目录>，起服务用 devserver.js 加 --cwd <子项目目录>，别的命令、脚本、文件写完整路径；子项目说明里的命令是相对子项目写的，照这个办法换。在壳子这一层提交时显式写文件名，不用 git add -A、git add .（会把子项目提交成 gitlink）。');
    } else {
      // 不是壳子也提一句：内网的模型爱写 cd <项目目录> && …，每条都会停在 Claude Code 的确认框上
      out.push('Bash 里不要把 cd 和别的命令串在一条里（Claude Code 会停下来要人确认，开着跳过权限模式也问）：命令、脚本、文件写完整路径或者相对当前目录的路径；git 用 git -C <目录>，Maven 用 mvn -f <目录>/pom.xml，npm 用 npm --prefix <目录>。');
    }

    // 套件自己的代码和安装时记下的指纹对不上（被改过、删了、多出来的）：告诉它和用户（状态栏也挂红字），记一条问题反馈。重新装一遍就恢复
    try {
      const drift = kitCodeDrift();
      if (drift) {
        writeState('kit-drift', { list: drift.map((x) => x.rel + '（' + x.how + '）'), at: Date.now() });
        if (drift.length) {
          const list = drift.map((x) => x.rel + '（' + x.how + '）');
          out.push('套件自己的代码和安装时不一样：' + list.slice(0, 8).join('、') + (list.length > 8 ? ' 等 ' + list.length + ' 个' : '') + '。这些检查可能已经不可靠了：先告诉我；不是你改的也不要去"修"它。重新运行安装包就能恢复。');
          const fb = require('../lib/feedback.js');
          fb.record({ kind: '篡改', hook: '套件代码', source: '钩子自动记录', title: '套件自己的代码和安装时不一样：' + list.slice(0, 3).join('、') + (list.length > 3 ? ' 等' : ''), what: '会话开始时比对安装时记下的指纹（state/kit-hash.json），这些文件对不上：' + list.join('、') + '。不是安装器装的样子，可能是被程序绕开禁改改过，也可能是手工改的。', sig: fb.sigOf(['kit-drift', list.join(',')]), sid: j.session_id, cwd, transcript: j.transcript_path });
        }
      }
    } catch (e) { /* 比不了不影响会话开始 */ }

    // 全自动模式只在走 OpenSpec 流程时算数：会话刚开始还不知道这个会话要干什么，先把这条界线说清
    if (readConfig().autoMode) out.push('全自动模式开着，只在走 OpenSpec 流程时算数：我敲了 /opsx:…、提了要走提案的需求、让你接着做某个变更。那时我不在，不要问我，探索 → 提案 → 审提案 → apply → 审代码 → 归档一路做完，照约定里"全自动模式（已开）"一节做。别的时候（我问问题、让你检索、跑别的技能）我在，照常来，做完我交代的事就收工：工作区里有没做完的变更，不要自己去接着做。');

    // 后台自动探索：没探索过、依据的文件改了，就甩一个后台进程去查（不用模型）。几秒钟就好，结果在用户开口时带给模型
    let OB = null;
    try { OB = require('../lib/onboard.js'); } catch (e) { OB = null; }
    // 会话开始之前就探索好的，下面会带给它（整份或者路径）：用户开口时只说这之后才探索好、才更新的。
    // 不记的话，壳子下面每个子项目的说明在每个新会话的第一条消息里都会整份再带一遍。
    // 先记、后读：反过来的话，正好在读和记中间探索完的那一次，两头都落空
    try { if (OB) OB.noticeFor(j, true); } catch (e) { /* 记不了就多说一次 */ }
    let exploring = false;
    try { exploring = OB ? OB.kick(cwd, '会话开始') : false; } catch (e) { /* 甩不出去不影响会话开始 */ }
    const project = findUp(cwd, path.join('.vibe', 'project.md'), 4);
    if (project) {
      let text = read(project);
      if (text.length > MAX_PROJECT_CHARS) text = text.slice(0, MAX_PROJECT_CHARS) + '\n…（太长，后面的自己去读 ' + project + '）';
      out.push('项目说明（' + project + '；和实际对不上时以实际为准，并更新这个文件）：\n' + text);
    } else {
      // 没有项目说明：是正在探索、探索过了没认出来、还是自动探索关着，明说，它才知道要不要自己跑 /ttls-onboard
      let note = '';
      try { note = OB ? OB.startNote(cwd, exploring) : ''; } catch (e) { note = ''; }
      if (note) out.push(note);
    }
    // 各个子项目有各自的项目说明：只列路径，用到哪个读哪个。团队共享的那份写在子项目的 CLAUDE.md 里（"项目说明（团队共享）"一节），
    // 当前目录的 CLAUDE.md Claude Code 自己会带，子项目的要读到那个目录里的文件才带，所以也列上
    const nested = [];
    const teamNotes = (dir) => { const f = path.join(dir, 'CLAUDE.md'); try { return /^#{1,3}\s*项目说明（团队共享）/m.test(fs.readFileSync(f, 'utf8')) ? f + '（"项目说明（团队共享）"一节）' : ''; } catch (e) { return ''; } };
    for (const a of subdirs(cwd)) {
      const pa = path.join(a, '.vibe', 'project.md'); if (fs.existsSync(pa)) nested.push(pa);
      const ta = teamNotes(a); if (ta) nested.push(ta);
      if (deep) for (const b of subdirs(a)) { const pb = path.join(b, '.vibe', 'project.md'); if (fs.existsSync(pb)) nested.push(pb); const tb = teamNotes(b); if (tb) nested.push(tb); }
      if (nested.length >= 30) break;
    }
    if (nested.length) out.push('下面这些目录各有项目说明，改它里面的代码之前先读对应的那份：\n' + nested.map((p) => '- ' + p).join('\n'));
    // 项目里还留着并进套件之前的技能（urai-db-crud、redis）：两个都在，模型会看到两个查库的技能
    try { const old = OB ? OB.oldSkillNotice(cwd) : ''; if (old) out.push(old); } catch (e) { /* 查不了不影响会话开始 */ }

    // 刚写好的交接记录（一小时内、还没接过）：给 Claude Code 一句现成的第一句话（initialUserMessage）。这里只"给"，不标记"已接上"：
    // 有的版本、有的路径（比如 /clear）不一定真把这句话发出去，标记的事交给用户开口时的钩子（task-anchor）去做，那条路什么版本都通
    let firstWords = '';
    let handoverNote = 'handover=none';
    if (source === 'startup' || source === 'clear') {
      const handover = findUp(cwd, path.join('.vibe', 'handover.md'), 2);
      if (handover) {
        const m = fs.statSync(handover).mtimeMs;
        const used = readState('handover-consumed');
        // 过期的交接记录：写完它之后那件事已经做完或归档了（比如全自动模式挂了一夜），不能照它接着做
        const stale = handoverStale(handover, cwd);
        const fresh = !stale && Date.now() - m < 60 * 60000 && !(used.file === handover && used.mtime === m);
        // 替用户说第一句话（initialUserMessage）只有较新的 Claude Code 认；开关 autoResume（配置页"/clear 之后自动接着干"），默认关。
        // 关着时新会话等用户开口，说"继续"就由 task-anchor 接上（那条路什么版本都通）
        if (fresh && readConfig().autoResume === true) firstWords = '接着上一个会话的交接记录继续：先读 ' + handover + '，再用 git status、tasks.md 核对一下实际状态，然后按里面的"下一步"接着做。';
        handoverNote = 'handover=' + handover + ' fresh=' + fresh + (stale ? ' stale=' + stale : '');
        if (Date.now() - m < 7 * 86400000) {
          const when = new Date(m).toLocaleString('zh-CN', { hour12: false });
          if (stale) out.push('上一个会话留了交接记录（' + when + '）：' + handover + '，但它已经过期：写完它之后' + stale + '，不要照它的"下一步"接着做。我要是说"继续"，先看 git log、openspec/changes 和 archive 里现在的状态，告诉我做到哪了，再问我接下来做什么。');
          else out.push('上一个会话留了交接记录（' + when + '）：' + handover + '。如果我接下来要继续那件事，先读它，再用 git status、tasks.md 核对一下实际状态，然后按里面的"下一步"接着做；我要做别的事就不用管它。');
        }
      }
    }
    // 大需求的计划（openspec/plan.md）：按实际情况刷新状态列，带上汇总和不在表里的变更；没有计划却有好几个变更的，提醒建一个（三天最多提一次）
    for (const changes of changeRoots(cwd)) {
      const osDir = path.dirname(changes);
      const s = refreshPlan(osDir);
      if (s) {
        const unlisted = planUnlisted(osDir) || [];
        out.push('计划 ' + s.file + '：共 ' + s.total + ' 个变更，已归档 ' + s.archived + (s.active.length ? '，进行中：' + s.active.join('、') : '') + (s.next ? '，下一个未开始：' + s.next : '，都做完了') + '。状态列由钩子按实际情况维护，不用手改；做下一个之前先读它。'
          + (unlisted.length ? '不在计划里的变更：' + unlisted.join('、') + '。属于这个大需求（包括中途加的新功能）就在表里加一行，不属于就不用管。' : ''));
        continue;
      }
      const miss = planMissingInfo(osDir, 60);
      if (!miss) continue;
      const hint = readState('plan-hint');
      const k = normKey(osDir);
      if (hint[k] && Date.now() - hint[k] < 3 * 86400000) continue;
      hint[k] = Date.now();
      writeState('plan-hint', hint);
      out.push(osDir + ' 里有 ' + miss.active.length + ' 个进行中的变更' + (miss.archived.length ? '、' + miss.archived.length + ' 个最近归档的' : '') + '（' + miss.active.concat(miss.archived).slice(0, 8).join('、') + '），但没有 plan.md。如果它们是同一个大需求拆出来的，运行 node "' + path.join(KIT, 'tools', 'plan.js') + '" "' + osDir + '" 生成骨架（已有的变更按时间排好、状态填好），再补上模块、说明和还没开始的模块（问我要清单，或者读 PRD）。不是同一个大需求就不用管。');
    }
    // 记下这个会话开始时模型拿到的约定和技能：之后改了（装新版、配置页改开关），用户开口时由 task-anchor 把变了的送过去，不用 /clear
    recordConvBaseline(j.session_id, cwd, source);
    // "产出位置"：会话开始时就记着的才算用户定过的。把当前目录往上、各个子项目里的项目说明和 CLAUDE.md 现在的记录拍个照
    try {
      const outputs = require('../lib/outputs.js');
      if (j.session_id) {
        const files = outputs.declFiles(path.join(cwd, '_'), cwd);
        for (const r of repos) for (const f of [path.join(r, '.vibe', 'project.md'), path.join(r, 'CLAUDE.md'), path.join(r, '.claude', 'CLAUDE.md')]) if (fs.existsSync(f)) files.push(f);
        for (const f of files) outputs.snapshot(j.session_id, f);
      }
    } catch (e) { /* 老版本没有 */ }
    // .vibe 一出现就进 .gitignore
    for (const d of [cwd].concat(repos)) if (fs.existsSync(path.join(d, '.vibe'))) ensureVibeIgnored(path.join(d, '.vibe'));
    // 经验规则的文件改过名（vibe-lessons-*.md → ttls-lessons-*.md）：项目里还是旧名字的挪一下，收工检查会催提交
    try { const ls = require('../lib/lessons.js'); let n = ls.migrateNames(ls.USER_RULES_DIR, 'user'); for (const d of [cwd].concat(repos)) n += ls.migrateNames(ls.projectRulesDir(d), 'project', d); if (n) hookLog('session-start 经验规则的文件改名 ' + n + ' 个'); } catch (e) { /* 挪不了不影响会话开始 */ }
    // .vibe/tmp、.vibe/out 下做完了的过程文件目录清掉：已归档变更的（归档之后又动过的不算），或者 tmp 里 tmpKeepDays 天没动过的（还没归档的变更的不清）。
    // .vibe 里堆着的零散旧文件提醒一次（七天一次）
    try {
      const cfg = readConfig();
      if (cfg.vibeTidy !== false) {
        const tidy = require('../lib/tidy.js');
        const roots = [cwd].concat(repos);
        const archivedNames = [];
        for (const changes of changeRoots(cwd)) { try { for (const n of fs.readdirSync(path.join(changes, 'archive'))) archivedNames.push(n.replace(/^\d{4}-\d{2}-\d{2}-/, '')); } catch (e) { /* 没有归档 */ } }
        const keep = cfg.tmpKeepDays === undefined ? 7 : Number(cfg.tmpKeepDays);
        let activeNames = [];
        try { activeNames = allChanges(cwd).map((c) => c.name); } catch (e) { activeNames = []; }
        let since = {};
        try { since = archivedSince(cwd); } catch (e) { since = {}; }
        const gone = tidy.cleanTmp(roots, keep, archivedNames, activeNames, since);
        if (gone.length) {
          out.push('清掉了 .vibe 里做完了的过程文件目录：' + gone.map((g) => path.relative(cwd, g.dir).split(path.sep).join('/') + '（' + g.why + '）').join('、') + '。');
          hookLog('session-start tmp cleaned ' + gone.map((g) => g.dir).join(' | '));
        }
        const messy = [];
        for (const r of roots) for (const c of tidy.clutter(r)) messy.push(path.relative(cwd, c.file).split(path.sep).join('/') || c.rel);
        const hint = readState('tidy-hint');
        const hk = normKey(cwd);
        if (messy.length >= 3 && !(hint[hk] && Date.now() - hint[hk] < 7 * 86400000)) {
          hint[hk] = Date.now();
          writeState('tidy-hint', hint);
          out.push('.vibe 里有 ' + messy.length + ' 个零散的旧文件（' + messy.slice(0, 6).join('、') + (messy.length > 6 ? ' 等' : '') + '），多半是以前的临时脚本。手头的事做完之后顺手整理：运行 node "' + path.join(KIT, 'tools', 'vibe-tidy.js') + '" 列出来，确认是用完了的，加 --apply 挪进 .vibe/tmp（不直接删，过几天没人要才清掉），告诉我挪了哪些；拿不准的留着。');
        }
      }
    } catch (e) { /* 清理失败不影响会话开始 */ }
    // 以前用 devserver.js 起了、还没关的服务：告诉它，别再起一个（记录在各个项目的 .vibe/run/ 里）。进程和端口都没了的记录顺手清掉
    try {
      const running = [];
      for (const r of [cwd].concat(repos)) {
        const rd = path.join(r, '.vibe', 'run');
        let files = [];
        try { files = fs.readdirSync(rd).filter((f) => /\.json$/i.test(f)); } catch (e) { continue; }
        for (const f of files) {
          let rec;
          try { rec = JSON.parse(fs.readFileSync(path.join(rd, f), 'utf8')); } catch (e) { continue; }
          let pidAlive = false;
          try { process.kill(rec.pid, 0); pidAlive = true; } catch (e) { pidAlive = !!e && e.code === 'EPERM'; }
          const up = pidAlive && await portOpen(rec.port);
          if (up) running.push((repos.length ? path.basename(r) + ' 的 ' : '') + rec.name + '（端口 ' + rec.port + '，' + new Date(rec.startedAt).toLocaleString('zh-CN', { hour12: false }) + ' 起的）');
          else if (!pidAlive && !(await portOpen(rec.port))) { try { fs.unlinkSync(path.join(rd, f)); } catch (e) { /* 删不掉就算了 */ } }
        }
      }
      if (running.length) out.push('以前起的服务还在跑：' + running.join('、') + '。要测就照样用 node "' + path.join(KIT, 'tools', 'devserver.js') + '" start …（它记着这些服务，跑的不是现在的代码会在同一个端口自动重启），用不着了就 stop --all；不要另起一个、不要换端口。');
    } catch (e) { /* 查不了不影响会话开始 */ }
    cleanState(3);
    hookLog('session-start source=' + source + ' cwd=' + cwd + ' shell=' + shell + ' ' + handoverNote + ' initialUserMessage=' + (firstWords ? 'yes' : 'no'));
    if (out.length || firstWords) {
      const o = { hookEventName: 'SessionStart' };
      if (out.length) o.additionalContext = '[vibe-kit] ' + out.join('\n\n');
      if (firstWords) o.initialUserMessage = firstWords;
      result = { hookSpecificOutput: o };
    }
  } catch (e) { /* 注入失败不能影响会话启动 */ }
  await ensureRouter();
  return result;
}

module.exports = { handle };
if (require.main === module) cli(handle);
