'use strict';
/*
 * 套件的问题反馈，和被拦住走不下去时的兜底放行。
 *
 * 问题反馈：都放在 ~/.claude/vibe-kit/feedback/（一台电脑一处，所有项目的都在这里；装新版、卸载都不删），一条问题一个 .md：
 *   开头是字段（套件版本、Claude Code 版本、模型、涉及哪道检查、项目、会话、来源、次数），后面是正文（现象、当时在做什么、
 *   为什么认为是套件的问题、怎么处理的、建议），再附上拦下时的原话、出错的位置、钩子流水账的最后几行。密码、token 之类遮掉。
 *   三种来源：
 *     模型反馈   用户的 AI 觉得套件有问题（拦错了、漏拦了、报错、提示看不懂、卡住），用 tools/feedback.js add 记
 *     钩子自动记录  钩子抛了异常（出错时按放行处理，用户和模型都看不到，只有这里有）；套件的代码、开关被绕开配置页改了
 *     申请放行   AI 认为被拦错了，申请放行（tools/feedback.js bypass），先记一条
 *   同样的问题（签名一样、30 天内记过）不另起一条，在原来那条里记"又出现一次"。
 *   只记套件的问题。下面这些不是问题，不进这里（导出的汇总里另有两张表）：
 *     同一条理由反复拦下        记次数（state/block-stats.json）。以前拦到第 3 次自动记一条"卡住"，多半是检查拦对了、模型改了几次才改对
 *     全自动模式下的放行        条件现在满足不了（要等用户、环境不具备）先过：记进全自动报告（lib/report.js）；AI 说是套件判断错了（--bug）才记成问题
 *     用户在配置页改了开关      记进 state/config-audit.json，配置页上能看到
 *   维护者不定期收：配置页"问题反馈"一栏点"导出汇总"，或者 node tools/feedback.js export，得到一个汇总的 .md，交给改套件的人；
 *   复制走了在配置页点"清空"（clearRecords：只删导出过、之后没再变的；只有配置页能清，工具里没有清空命令，模型删不了）。
 *
 * 兜底放行：流程类的检查（BYPASSABLE）拦下时，提示末尾带〔拦截编号〕，并记下拦下的原话、操作、会话（state/blocks.json）。
 *   AI 确信是套件拦错了、任务因此走不下去：tools/feedback.js bypass <编号> --why "查证过什么"——先记一条问题反馈，
 *   再开一张通行证（state/bypass.json：30 分钟内，对同一个文件 / 同一件事的这道检查有效）。再做那一步时：
 *     kitBypass = ask（默认）   弹 Claude Code 的确认框，用户点同意才放行
 *     kitBypass = auto          直接放行
 *     kitBypass = off           不许申请（全自动模式下也不许）
 *   有人在的时候：通行证只用一次；每个会话最多申请 5 次，同一类检查最多 3 次。
 *   全自动模式（用户不在）：不弹框、不等用户，哪一类都直接放行，每次用都记进全自动报告；一张通行证 30 分钟内可以用多次
 *   （连着给几项任务打勾，不用每项申请一次）；每个会话最多 60 次，防它转圈。
 *   通行证按"同一个文件 / 同一件事"认，不按"一模一样的操作"认：申请之后中间改过一次验法，再打勾时内容变了，
 *   以前就对不上、等于没放（问题反馈 F20260929-015）。
 *   改套件、关掉钩子、结束路由进程、读令牌、非 UTF-8 文件、整仓 add、gitlink：没有编号，什么模式都不能放行。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { KIT, readState, writeState, updateState, normKey, readConfig, hookLog, tailEntries, askOut } = require('./session');

const DIR = path.join(KIT, 'feedback');
const EXPORT_DIR = path.join(DIR, '导出');
// 能申请放行的检查：流程类的门槛。risk 只在导出的表里标一下轻重；全自动模式下哪一类都不等用户
const BYPASSABLE = {
  'guard-spec': { risk: 'mid', label: 'OpenSpec 产物的门槛（打勾、含糊词、任务写法、先探索再提案等）' },
  'archive': { risk: 'mid', label: '归档门槛（任务没全打勾、代码没审过）' },
  'guard-output': { risk: 'low', label: '代码之外的产出放哪' },
  'guard-vibe': { risk: 'low', label: '.vibe 整理、过程文件' },
  'process': { risk: 'low', label: '过程文件（备份、日志）别落在项目里' },
  'server': { risk: 'low', label: '起服务要经过 devserver.js' },
  'commit-format': { risk: 'low', label: '提交信息格式' },
  'new-files': { risk: 'low', label: '新建的文件没 git add' },
};
const MAX_PER_SESSION = 5;
const MAX_PER_KIND = 3;
const AUTO_MAX_PER_SESSION = 60;
const PASS_MS = 30 * 60000;
const BLOCK_KEEP_MS = 2 * 3600000;
const KEEP_RECORDS = 1000;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…（后面省略 ' + (t.length - n) + ' 字）' : t; };
const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0].slice(0, 200);
/** 拦下的是哪条规矩：第一行去掉引号里的具体内容和数字（提交信息、文件名不同，也算同一条） */
const ruleOf = (s) => firstLine(s).replace(/"[^"]*"|“[^”]*”|「[^」]*」|'[^']*'|`[^`]*`/g, '…').replace(/\d+/g, 'N').slice(0, 120);
const sigOf = (parts) => crypto.createHash('sha1').update(parts.map((p) => String(p == null ? '' : p)).join('\u0000')).digest('hex').slice(0, 16);

/** 把密码、token、内网地址之类遮掉：记录会被收走、给别人看 */
function redact(s) {
  return String(s == null ? '' : s)
    // 认证头：Bearer / Basic / Token / Digest 后面的整段（放最前，免得只遮掉 "Bearer" 这个词）
    .replace(/\b(Bearer|Basic|Token|Digest)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1$2***')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***')
    // 键名里带这些字的：值遮掉（键、值都可以带引号，JSON、yml、properties、命令行参数都认）
    .replace(/(["']?[\w.-]*(?:pass|pwd|secret|token|apikey|api[-_]key|access[-_]?key|private[-_]?key|credential|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;,'"}]+)/gi, '$1***')
    // 中文：密码是 xxx、密码：xxx、口令、密钥
    .replace(/((?:密码|口令|秘钥|密钥|令牌)\s*(?:是|为|[:：=])\s*)(\S+)/g, '$1***')
    // curl -u 用户:密码、--user 用户:密码
    .replace(/((?:^|\s)(?:-u|--user)\s+["']?[^\s:"']+:)([^\s"']+)/g, '$1***')
    // mysql、mysqldump、mysqladmin 的 -p密码；redis-cli -a 密码
    .replace(/(\bmysql\w*(?:\.exe)?\b[^\n]*?\s-p)(\S+)/g, '$1***')
    .replace(/(\bredis-cli(?:\.exe)?\b[^\n]*?\s-a\s+)(\S+)/g, '$1***')
    // 地址里的 用户:密码@、Oracle 的 用户/密码@
    .replace(/(\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1***@')
    .replace(/(\b[A-Za-z][\w$]*\/)[^@\s/"']+(@[\w.-]+)/g, '$1***$2')
    // Cookie 里的会话号、PowerShell 的 ConvertTo-SecureString '明文'
    .replace(/\b(JSESSIONID|SESSION|SESSIONID|sid)=([^;\s&]+)/gi, '$1=***')
    .replace(/(ConvertTo-SecureString\s+(?:-String\s+)?)(["'])[^"']*\2/gi, '$1$2***$2')
    // 常见 key 格式
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(sk|ak|ghp|glpat)([-_])[A-Za-z0-9]{12,}\b/g, '$1$2***')
    // 内网地址（10.x、172.16-31.x、192.168.x），本机地址 127.x 留着
    .replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, '内网IP');
}

// ---------- 会话 ----------
/** 用户开口、会话开始时记一下这个会话在哪个目录、会话记录在哪：tools/feedback.js 自己拿不到会话号，按当前目录找最近的那个 */
function noteSession(j) {
  if (!j || !j.session_id) return;
  updateState('active-sessions', (o) => {
    o[j.session_id] = { cwd: path.resolve(j.cwd || process.cwd()), transcript: String(j.transcript_path || ''), at: Date.now() };
    for (const k of Object.keys(o).sort((a, b) => (o[b].at || 0) - (o[a].at || 0)).slice(30)) delete o[k];
    return o;
  });
}
function sessionForCwd(cwd) {
  const o = readState('active-sessions');
  const c = normKey(path.resolve(cwd || process.cwd()));
  const list = Object.keys(o).map((sid) => Object.assign({ sid }, o[sid])).sort((a, b) => (b.at || 0) - (a.at || 0));
  const near = (a, b) => !!b && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'));
  return list.find((s) => near(c, normKey(s.cwd || ''))) || list.find((s) => Date.now() - (s.at || 0) < 2 * 3600000) || null;
}
/** 会话记录里看是哪个版本的 Claude Code、用的什么模型 */
function transcriptInfo(file) {
  const out = { claudeCode: '', model: '' };
  if (!file) return out;
  try {
    const es = tailEntries(file, 400000);
    for (let i = es.length - 1; i >= 0 && (!out.claudeCode || !out.model); i--) {
      const e = es[i];
      if (!e) continue;
      if (!out.claudeCode && e.version) out.claudeCode = String(e.version);
      if (!out.model && e.type === 'assistant' && e.message && e.message.model && !/synthetic/.test(e.message.model)) out.model = String(e.message.model);
    }
  } catch (e) { /* 读不了就空着 */ }
  return out;
}
const kitVersion = () => { try { return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim() || '（没有版本号）'; } catch (e) { return '（没有版本号）'; } };
function hookLogTail(n) {
  try { return fs.readFileSync(path.join(KIT, 'state', 'hooks.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-(n || 20)); } catch (e) { return []; }
}

// ---------- 问题记录 ----------
function parseRecord(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const title = ((m[2].match(/^#\s+(.+)$/m) || [])[1] || '').trim();
  return { file, meta, title, text };
}
/** 这台电脑上记过的问题，新的在前 */
function listRecords() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => /^F\d{8}-\d+.*\.md$/.test(f)); } catch (e) { return []; }
  return names.map((f) => parseRecord(path.join(DIR, f))).filter(Boolean).sort((a, b) => String(b.meta['更新'] || b.meta['时间']).localeCompare(String(a.meta['更新'] || a.meta['时间'])) || String(b.meta.id).localeCompare(String(a.meta.id)));
}
/** 新编号：当天的序号接着往下编。清空之后也不重用（记在 feedback/.seq.json 里），免得没用完的放行通行证回写到新的那条上 */
function nextId() {
  const d = new Date();
  const day = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  const seqFile = path.join(DIR, '.seq.json');
  let seq = {};
  try { seq = JSON.parse(fs.readFileSync(seqFile, 'utf8')) || {}; } catch (e) { seq = {}; }
  let n = Number(seq[day]) || 0;
  try { for (const f of fs.readdirSync(DIR)) { const m = f.match(new RegExp('^F' + day + '-(\\d+)')); if (m) n = Math.max(n, Number(m[1])); } } catch (e) { /* 还没有目录 */ }
  n += 1;
  try { fs.writeFileSync(seqFile, JSON.stringify({ [day]: n })); } catch (e) { /* 记不了下次按文件算 */ }
  return 'F' + day + '-' + String(n).padStart(3, '0');
}
const fileSlug = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t〔〕]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || '问题';
function setMeta(text, updates) {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (all, body) => {
    const lines = body.split(/\r?\n/);
    for (const [k, v] of Object.entries(updates)) {
      const i = lines.findIndex((l) => l.startsWith(k + ':'));
      const line = k + ': ' + String(v).replace(/\r?\n/g, ' ');
      if (i >= 0) lines[i] = line; else lines.push(line);
    }
    return '---\n' + lines.join('\n') + '\n---';
  });
}
/** 改一条记录的字段，同时刷新"更新"时间（清空时靠它认出"导出之后又变过"） */
function markRecord(id, updates) {
  const r = listRecords().find((x) => x.meta.id === id);
  if (r) fs.writeFileSync(r.file, setMeta(r.text, Object.assign({}, updates, { '更新': stamp() })));
}
/** 有新的、变了的记录：记个时间。后台进程（lib/updater.js）看到它比上次上报的时间新，就把没传的建成议题（lib/issues.js） */
function markDirty() { try { writeState('issues-dirty', { at: Date.now() }); } catch (e) { /* 记不了就等下次 */ } }
/**
 * 记一条问题。r = { kind 类型, hook 涉及, source 来源, title, what 现象, action 当时在做什么, why, did 怎么处理的, suggest,
 *   blocked 拦下时的原话, stack 出错的位置, sig 签名（同样的问题认得出来）, sid, cwd, transcript, bypass 放行情况, note 又出现时记的一句 }
 * 返回 { id, file, repeated, count }
 */
function record(r) {
  fs.mkdirSync(DIR, { recursive: true });
  const now = Date.now();
  const sid = String(r.sid || '');
  const cwd = String(r.cwd || '');
  if (r.sig) {
    const since = stamp(now - 30 * 86400000);
    const old = listRecords().find((x) => x.meta['签名'] === r.sig && String(x.meta['时间'] || '') >= since);
    if (old) {
      const count = Number(old.meta['次数'] || 1) + 1;
      let t = setMeta(old.text, { '次数': count, '更新': stamp(now) });
      if (!/\n## 又出现了\n/.test(t)) t = t.replace(/\s*$/, '\n\n## 又出现了\n');
      t = t.replace(/\s*$/, '\n- ' + stamp(now) + '　项目 ' + (cwd || '？') + '　会话 ' + sid.slice(0, 8) + (r.note ? '　' + redact(clip(r.note, 200)).replace(/\r?\n/g, ' ') : '') + '\n');
      fs.writeFileSync(old.file, t);
      markDirty();
      return { id: old.meta.id, file: old.file, repeated: true, count };
    }
  }
  const id = nextId();
  const info = transcriptInfo(r.transcript);
  const meta = {
    id, '时间': stamp(now), '更新': stamp(now), '次数': 1, '类型': r.kind || '其他', '涉及': r.hook || '（没说）', '来源': r.source || '模型反馈',
    '放行': r.bypass || '没有申请', '套件版本': kitVersion(), 'Claude Code': info.claudeCode || '（不知道）', '模型': info.model || '（不知道）',
    '电脑': os.hostname(), '项目': cwd || '（不知道）', '会话': sid, '签名': r.sig || '',
  };
  const sec = (h, v) => (v && String(v).trim() ? '\n## ' + h + '\n' + redact(clip(v, 6000)).trim() + '\n' : '');
  const code = (h, v) => (v && String(v).trim() ? '\n## ' + h + '\n```\n' + redact(clip(v, 6000)).trim() + '\n```\n' : '');
  const body = '# ' + redact(clip(r.title || '（没写标题）', 120)).replace(/\r?\n/g, ' ') + '\n'
    + sec('现象', r.what) + sec('当时在做什么', r.action) + sec('为什么认为是套件的问题', r.why) + sec('怎么处理的', r.did) + sec('建议怎么改', r.suggest)
    + code('附：拦下时的原话', r.blocked) + code('附：出错的位置', r.stack) + code('附：钩子流水账（最后 20 行）', hookLogTail(20).join('\n'));
  const text = '---\n' + Object.keys(meta).map((k) => k + ': ' + String(meta[k]).replace(/\r?\n/g, ' ')).join('\n') + '\n---\n' + body;
  const file = path.join(DIR, id + '-' + fileSlug(r.title) + '.md');
  fs.writeFileSync(file, text);
  try { const all = listRecords(); for (const x of all.slice(KEEP_RECORDS)) fs.unlinkSync(x.file); } catch (e) { /* 删不了下次再说 */ }
  markDirty();
  return { id, file, repeated: false, count: 1 };
}
/** 这个会话记下的问题（头一次在这个会话里记的，或者在这个会话里又出现过的） */
function sessionRecords(sid) {
  if (!sid) return [];
  const short = String(sid).slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const again = new RegExp('会话 ' + short + '(?![\\w-])');
  return listRecords().filter((r) => r.meta['会话'] === sid || again.test(r.text));
}
/**
 * 出错的指纹：同一个错在哪台电脑、哪个项目里出都得算出一样的，上报之后才并得成一条。
 * 所以出错的位置只留"文件名:行号"（完整路径里有用户名）；错误的话里的路径换成文件名、数字抹掉（进程号、临时文件名里的数）
 */
function errorSig(hook, msg, stack) {
  const at = /([\w.-]+\.(?:js|py|java)):(\d+)/.exec((String(stack || '').split('\n').find((l) => /\.(?:js|py|java):\d+/.test(l)) || ''));
  const where = at ? at[1] + ':' + at[2] : '';
  const said = firstLine(msg).replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s'"()<>|:*?]+)+/g, (p) => p.split(/[\\/]/).pop()).replace(/\d+/g, '#');
  return sigOf(['error', hook, said, where]);
}
/** 钩子抛了异常：出错时那道检查按放行处理，用户和模型都看不到，记一条 */
function recordHookError(hook, j, err) {
  try {
    const msg = String((err && err.message) || err || '（没有错误信息）');
    const stack = String((err && err.stack) || msg).split('\n').slice(0, 8).join('\n');
    const inp = (j && j.tool_input) || {};
    const action = j && j.tool_name ? j.tool_name + '：' + (inp.command || inp.file_path || inp.notebook_path || inp.pattern || '') : String((j && j.hook_event_name) || '');
    record({
      kind: '出错', hook, source: '钩子自动记录', title: hook + ' 出错：' + firstLine(msg).slice(0, 80),
      what: '钩子运行时抛了异常。出错时这道检查按放行处理（没有拦），用户和模型都看不到，只有这里有记录。',
      action: clip(action, 500), stack, sig: errorSig(hook, msg, stack),
      sid: (j && j.session_id) || '', cwd: (j && j.cwd) || '', transcript: (j && j.transcript_path) || '',
    });
    hookLog(hook + ' 出错（记进了问题反馈）：' + firstLine(msg));
  } catch (e) { /* 记不了就算了 */ }
}

// ---------- 拦截编号和通行证 ----------
function newBlockId(taken) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 50; i++) { let s = ''; for (let k = 0; k < 4; k++) s += A[crypto.randomInt(A.length)]; if (!taken.has(s)) return s; }
  return String(Date.now() % 1000000);
}
/**
 * 同一条规矩拦了多少次（state/block-stats.json）：导出的汇总里列成一张表，给改套件的人看哪条规矩拦得多。不记成问题
 */
function countBlock(hook, reason, sid) {
  try {
    updateState('block-stats', (o) => {
      const rule = ruleOf(reason);
      const k = hook + '|' + sigOf([rule]);
      const x = o[k] && typeof o[k] === 'object' ? o[k] : { hook, rule, count: 0, sessions: [] };
      x.count += 1;
      x.at = Date.now();
      x.example = clip(redact(firstLine(reason)), 200);
      if (sid && !x.sessions.includes(sid.slice(0, 8))) x.sessions = x.sessions.concat(sid.slice(0, 8)).slice(-20);
      o[k] = x;
      const keys = Object.keys(o);
      if (keys.length > 200) for (const d of keys.sort((a, b) => (o[a].at || 0) - (o[b].at || 0)).slice(0, keys.length - 200)) delete o[d];
      return o;
    });
  } catch (e) { /* 数不了不影响 */ }
}
/**
 * 流程类的检查拦下时调：记下拦截（编号、原话、操作、会话、是对着哪个文件 / 哪件事），返回接在提示后面的一句（带编号）；
 * 不能放行的检查返回空串。target：这一步是对着什么做的（改文件是文件路径，归档是变更名），通行证按它认
 */
function registerBlock(j, hook, sig, reason, action, target) {
  if (!BYPASSABLE[hook]) return '';
  const sid = String((j && j.session_id) || '');
  const now = Date.now();
  let id = ''; let times = 0;
  updateState('blocks', (o) => {
    const list = (Array.isArray(o.list) ? o.list : []).filter((b) => now - (b.at || 0) < BLOCK_KEEP_MS);
    let b = list.find((x) => x.sig === sig && x.hook === hook && x.sid === sid);
    if (!b) { b = { id: newBlockId(new Set(list.map((x) => x.id))), hook, sig, sid, cwd: String((j && j.cwd) || ''), transcript: String((j && j.transcript_path) || '') }; list.push(b); }
    b.at = now; b.reason = clip(redact(reason), 3000); b.action = clip(redact(action), 600); b.target = String(target || '');
    const reasons = o.reasons && typeof o.reasons === 'object' ? o.reasons : {};
    const rk = sid + '|' + hook + '|' + sigOf([ruleOf(reason)]);
    times = (reasons[rk] = (reasons[rk] || 0) + 1);
    for (const k of Object.keys(reasons).slice(0, Math.max(0, Object.keys(reasons).length - 300))) delete reasons[k];
    id = b.id;
    return { list: list.slice(-300), reasons };
  });
  countBlock(hook, reason, sid);
  if (!id) return '';
  const cfg = readConfig();
  const cmd = 'node "$HOME/.claude/vibe-kit/tools/feedback.js" bypass ' + id + ' --why "<原因>"';
  if (cfg.autoMode && cfg.kitBypass !== 'off') {
    return '\n〔拦截编号 ' + id + '。全自动模式：照提示能改的先改。改不了、条件现在满足不了的，不要停下等我，申请放行再做一次这一步：' + cmd
      + '。原因写清查过什么、差在哪；确信是套件判断错了，末尾加 --bug。放行会记进全自动报告。' + (times >= 3 ? '同一条理由已经拦了 ' + times + ' 次，不要再原样重试。' : '') + '〕';
  }
  return '\n〔拦截编号 ' + id + '：确信是套件拦错了、任务因此走不下去，才按约定申请放行：node "$HOME/.claude/vibe-kit/tools/feedback.js" help〕';
}
/**
 * 这个会话里还能用的通行证：配置没关放行、同一个会话、没过期、没用掉（全自动模式下开的可以用多次），
 * 而且会话记录里确实成功跑过 feedback.js bypass <编号>（通行证文件是明文，只看它自己不够）
 */
function validPasses(cfg, j) {
  if ((cfg || readConfig()).kitBypass === 'off') return [];
  const now = Date.now();
  const sid = String((j && j.session_id) || '');
  const cand = (readState('bypass').passes || []).filter((p) => p && (!p.used || p.multi) && p.expires > now && (!p.sid || p.sid === sid));
  if (!cand.length) return [];
  const ran = bypassCallsIn(j && j.transcript_path);
  return cand.filter((p) => ran.has(String(p.id).toUpperCase()));
}
/**
 * 这道检查、这一步能用哪张通行证：一模一样的操作；或者对着同一个文件 / 同一件事、拦下的又是同一条规矩。没有返回 null。
 * reason 是这一次拦下的原话。为"验法要人工看"申请的通行证，不能拿去过"任务里有含糊词"：
 * 同一个文件上同一道检查管着好几条规矩，申请的时候说的只是其中一条
 */
function pickPass(passes, hook, sig, target, reason) {
  const t = String(target || '');
  const rule = reason ? sigOf([ruleOf(reason)]) : '';
  return (passes || []).find((p) => p.hook === hook && ((sig && p.sig === sig) || (t && p.target === t && (!rule || !p.reason || sigOf([ruleOf(p.reason)]) === rule)))) || null;
}
/** 这个操作能用的通行证：{ 检查名: 通行证 }。target 是这一步对着的文件 / 事（所有检查共用一个的时候用这个） */
function passesFor(sig, cfg, j, target) {
  const out = {};
  if (!sig && !target) return out;
  for (const p of validPasses(cfg, j)) if (!out[p.hook] && pickPass([p], p.hook, sig, target)) out[p.hook] = p;
  return out;
}
/** 会话记录里成功跑过的 feedback.js bypass <编号>：返回编号的集合 */
function bypassCallsIn(file) {
  const out = new Set();
  if (!file) return out;
  try {
    const { toolCalls, toolResults } = require('./session');
    const es = tailEntries(file, 3000000).filter((e) => e && !e.isSidechain);
    const res = toolResults(es);
    for (const c of toolCalls(es)) {
      const cmd = String((c.input && c.input.command) || '');
      const m = cmd.match(/feedback\.js["']?\s+bypass\s+["']?([A-Za-z0-9]{3,8})/i);
      const r = res.get(c.id);
      if (m && r && !r.error && /放行申请登记好了/.test(r.text)) out.add(m[1].toUpperCase());
    }
  } catch (e) { /* 读不了会话记录：一张都不认 */ }
  return out;
}
/**
 * 这一步用了通行证：记下"用掉了"，返回钩子该回什么——按现在的配置判断（不看通行证文件里写的）：kitBypass=auto、
 * 或者全自动模式（用户不在，弹框没人点）就放行（null）；否则弹 Claude Code 的确认框，用户点同意才放行。
 * 全自动模式下每用一次记进报告：blocked 是这一步本来被拦下的原话（按检查名给），action 是这一步在做什么
 */
function bypassOutcome(used, cfg, j, blocked, action) {
  const c = cfg || readConfig();
  const ids = new Set(used.map((p) => p.id + '|' + p.hook));
  updateState('bypass', (o) => { for (const p of (o.passes || [])) if (ids.has(p.id + '|' + p.hook)) { p.used = true; p.usedAt = Date.now(); p.uses = (p.uses || 0) + 1; } return o; });
  const auto = c.kitBypass === 'auto' || !!c.autoMode;
  for (const p of used) { if (!p.fid) continue; try { markRecord(p.fid, { '放行': auto ? '已放行（没问用户）' : '已申请，弹框问了用户' }); } catch (e) { /* 改不了记录不影响放行 */ } }
  hookLog('放行 ' + used.map((p) => p.hook + ' ' + p.id + (p.fid ? '（' + p.fid + '）' : '')).join('、') + (auto ? '，没问用户' : '，弹框问用户'));
  if (c.autoMode && j) {
    try {
      const report = require('./report.js');
      for (const p of used) {
        const said = String((blocked && blocked[p.hook]) || p.reason || '').split(/\r?\n/).filter((l) => l.trim() && !/^〔/.test(l.trim())).slice(0, 3).join(' ');
        report.note(j, { kind: 'bypass', title: ((BYPASSABLE[p.hook] || {}).label || p.hook).replace(/（.*$/, '') + '：' + clip(redact(action || p.action || ''), 120), detail: clip(p.why, 200) + (said ? '。本来拦下的原话：' + clip(redact(said), 240) : '') + (p.fid ? '（' + p.fid + '）' : '') });
      }
    } catch (e) { /* 记不了报告不影响放行 */ }
  }
  if (auto) return null;
  const label = used.map((p) => (BYPASSABLE[p.hook] || {}).label || p.hook).join('、');
  return askOut('[vibe-kit 放行申请] 这一步本来会被套件的检查拦下：' + label + '。AI 认为是套件拦错了：' + used.map((p) => clip(p.why, 200)).join('；')
    + '（问题反馈 ' + used.map((p) => p.fid).join('、') + ' 已记下，拦下的原话和它的理由都在 ~/.claude/vibe-kit/feedback/ 里）。同意就放行这一次；拒绝的话它会停下来等你。');
}
/**
 * tools/feedback.js bypass 用：先记问题，再开通行证。返回 { ok, msg, fid }
 */
function requestBypass(blockId, why, extra) {
  const cfg = readConfig();
  const id = String(blockId || '').trim().toUpperCase().replace(/[〔〕\s]/g, '');
  if (/^F\d{8}-\d+$/i.test(id)) return { ok: false, msg: id + ' 是问题反馈的编号，不是拦截编号。再做一次被拦的那一步，提示末尾〔拦截编号 XXXX〕里的四位编号才是。' };
  const b = ((readState('blocks').list) || []).find((x) => x.id === id && Date.now() - (x.at || 0) < BLOCK_KEEP_MS);
  if (!b) return { ok: false, msg: '找不到拦截编号 ' + id + '（编号只在拦下之后 2 小时内有效）。再做一次被拦的那一步，用新拦下时给的编号。' };
  const k = BYPASSABLE[b.hook];
  if (!k) return { ok: false, msg: '这道检查不能申请放行。' + (cfg.autoMode ? '这一步不做，写进最后的交代，接着做别的。' : '停下来，把情况告诉用户。') };
  const w = String(why || '').trim();
  if (w.replace(/\s/g, '').length < 20) return { ok: false, msg: '--why 要写清楚：查过什么（读了哪段代码、跑了哪条命令、实际的结果是什么），差在哪。至少 20 个字。' };
  const x = extra || {};
  // 全自动模式、没说是套件判断错了：条件现在满足不了，先过。不是套件的问题，不记成问题，只进全自动报告
  if (cfg.autoMode && cfg.kitBypass !== 'off' && !x.bug) {
    const mine = (readState('bypass').passes || []).filter((p) => p && p.sid === b.sid && p.id !== b.id);
    if (mine.length >= AUTO_MAX_PER_SESSION) return { ok: false, msg: '这个会话申请放行已经 ' + AUTO_MAX_PER_SESSION + ' 次了，不再放行。这一步不做，写进最后的交代，接着做别的。' };
    updateState('bypass', (o) => {
      const list = (Array.isArray(o.passes) ? o.passes : []).filter((p) => p && Date.now() - (p.at || 0) < 7 * 86400000 && !(p.id === b.id && p.hook === b.hook));
      list.push({ id: b.id, hook: b.hook, sig: b.sig, target: b.target || '', sid: b.sid, fid: '', why: w, auto: true, multi: true, at: Date.now(), expires: Date.now() + PASS_MS, used: false, action: b.action, reason: clip(b.reason, 600), cwd: b.cwd });
      return { passes: list.slice(-300) };
    });
    hookLog('申请放行 ' + b.hook + ' ' + b.id + '，全自动模式，不问用户，不记成问题');
    return { ok: true, fid: '', msg: '放行申请登记好了（30 分钟内，对同一个文件、同一件事的这道检查有效）。现在再做一次那一步，会直接放行，并记进全自动报告。' };
  }
  const base = {
    kind: '误拦', hook: b.hook, source: '申请放行', title: x.title || '被"' + k.label + '"拦下，AI 认为拦错了', what: x.what || '拦下时的原话见"附：拦下时的原话"。',
    action: b.action, why: w, suggest: x.suggest, blocked: b.reason, sig: sigOf(['bypass', b.hook, ruleOf(b.reason)]),
    sid: b.sid, cwd: b.cwd, transcript: b.transcript, note: '拦截编号 ' + b.id + '：' + w,
  };
  const passes = (readState('bypass').passes || []).filter((p) => p && p.sid === b.sid && p.id !== b.id);
  if (cfg.kitBypass === 'off') {
    const r = record(Object.assign(base, { did: '想申请放行，配置里关掉了放行，没放', bypass: '配置里关了，没放' }));
    return { ok: false, fid: r.id, msg: '已记下问题 ' + r.id + '。配置里关掉了申请放行：' + (cfg.autoMode ? '这一步不做，写进最后的交代，接着做别的不依赖它的事。' : '停下来，把卡在哪、为什么认为是套件的问题告诉用户，等用户定。') };
  }
  const max = cfg.autoMode ? AUTO_MAX_PER_SESSION : MAX_PER_SESSION;
  if (passes.length >= max || (!cfg.autoMode && passes.filter((p) => p.hook === b.hook).length >= MAX_PER_KIND)) {
    const r = record(Object.assign(base, { did: '想申请放行，这个会话申请的次数到上限了，没放', bypass: '次数到上限，没放' }));
    return { ok: false, fid: r.id, msg: '已记下问题 ' + r.id + '。这个会话申请放行的次数到上限了' + (cfg.autoMode ? '（' + max + ' 次）：这一步不做，写进最后的交代，接着做别的。' : '（一共 ' + MAX_PER_SESSION + ' 次、同一类检查 ' + MAX_PER_KIND + ' 次）：停下来，把情况告诉用户。') };
  }
  const auto = cfg.kitBypass === 'auto' || !!cfg.autoMode;
  const r = record(Object.assign(base, { did: auto ? '申请放行，没问用户就放行了' : '申请放行，再做那一步时弹框问用户', bypass: auto ? '已申请（不问用户）' : '已申请（要用户确认）' }));
  updateState('bypass', (o) => {
    const list = (Array.isArray(o.passes) ? o.passes : []).filter((p) => p && Date.now() - (p.at || 0) < 7 * 86400000 && !(p.id === b.id && p.hook === b.hook && !p.used));
    list.push({ id: b.id, hook: b.hook, sig: b.sig, target: b.target || '', sid: b.sid, fid: r.id, why: w, auto, multi: !!cfg.autoMode, at: Date.now(), expires: Date.now() + PASS_MS, used: false, action: b.action, reason: clip(b.reason, 600), cwd: b.cwd });
    return { passes: list.slice(-300) };
  });
  hookLog('申请放行 ' + b.hook + ' ' + b.id + '（' + r.id + '）' + (auto ? '，不问用户' : '，要用户确认'));
  return { ok: true, fid: r.id, msg: '已记下问题 ' + r.id + (r.repeated ? '（以前记过同样的，次数 +1）' : '') + '，放行申请登记好了（30 分钟内，对同一个文件、同一件事的这道检查有效' + (cfg.autoMode ? '' : '，只用一次') + '）。现在再做一次那一步：' + (auto ? '会直接放行' + (cfg.autoMode ? '，并记进全自动报告。' : '。') : '会弹确认框，等用户点同意。') };
}
/** 配置页上改了放松保护的开关：记一笔（state/config-audit.json，留最近 50 条），配置页上能看到。不算套件的问题 */
function audit(title, detail) {
  try {
    updateState('config-audit', (o) => { const list = Array.isArray(o.list) ? o.list : []; list.push({ at: Date.now(), title: clip(title, 200), detail: clip(detail, 400) }); return { list: list.slice(-50) }; });
    hookLog('开关变更 ' + firstLine(title));
  } catch (e) { /* 记不了不影响保存 */ }
}
const auditList = () => { const l = readState('config-audit').list; return Array.isArray(l) ? l.slice().reverse() : []; };

// ---------- 导出 ----------
/** 不算套件问题的记录：老版本自动记的"同一条理由拦了 3 次"、配置页上改开关 */
const isNoise = (r) => r.meta['类型'] === '开关变更' || (r.meta['来源'] === '钩子自动记录' && r.meta['类型'] === '卡住');
const cell = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '｜');
/** 拦得最多的规矩（state/block-stats.json），多的在前 */
function blockStats(n) {
  const o = readState('block-stats');
  return Object.keys(o).map((k) => o[k]).filter((x) => x && x.hook && x.count).sort((a, b) => b.count - a.count).slice(0, n || 20);
}
/** 最近 7 天的放行（state/bypass.json），新的在前 */
function bypassLog(n) {
  return (readState('bypass').passes || []).filter((p) => p && p.at).sort((a, b) => b.at - a.at).slice(0, n || 50);
}
function exportText() {
  const all = listRecords();
  const recs = all.filter((r) => !isNoise(r));
  const n = recs.reduce((a, r) => a + (Number(r.meta['次数']) || 1), 0);
  const tally = (key) => { const m = {}; for (const r of recs) { const k = r.meta[key] || '（没说）'; m[k] = (m[k] || 0) + (Number(r.meta['次数']) || 1); } return Object.keys(m).sort((a, b) => m[b] - m[a]).map((k) => '| ' + k + ' | ' + m[k] + ' |').join('\n'); };
  const stats = blockStats(20);
  const passes = bypassLog(50);
  // 工具（ttls-db-crud、ttls-redis）的用量和从用量里看出来的能优化的地方。先把工具新写的行读进来
  let tools = [];
  let tips = [];
  try { const ts = require('./toolstats.js'); ts.ingest(null); tools = ts.stats(40); tips = ts.hints(); } catch (e) { tools = []; tips = []; }
  const sec = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' 秒' : ms + ' 毫秒');
  return '# vibe-kit 问题反馈汇总\n\n'
    + '- 电脑：' + os.hostname() + '\n- 导出时间：' + stamp() + '\n- 套件版本：' + kitVersion() + '\n- 问题 ' + recs.length + ' 条，按出现次数算 ' + n + ' 次\n\n'
    + '给改套件的人：先看"问题"。每条开头是字段：来源是"模型反馈"的，是用户的 AI 自己报的；"钩子自动记录"是钩子出错、套件被绕开改了；"申请放行"是 AI 认为被拦错了、申请过放行（"放行"一栏是结果）。'
    + '正文里"附：拦下时的原话"是钩子当时的原文，"附：钩子流水账"是记录时 state/hooks.log 的最后几行。同样的问题只记一条，"次数"和"又出现了"是重复的情况。\n'
    + '后面两张表不是问题，是旁证："拦得最多的规矩"里次数高的，要么提示写得不清楚，要么检查判断错了；"放行记录"是全自动模式下条件满足不了先过的、和有人点了同意的。\n\n'
    + (recs.length ? '| 涉及 | 次数 |\n|---|---|\n' + tally('涉及') + '\n\n| 类型 | 次数 |\n|---|---|\n' + tally('类型') + '\n\n' : '')
    + '## 问题\n\n' + (recs.length ? '' : '没有。\n\n')
    + recs.map((r) => '---\n\n' + r.text.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (x, fm) => '```\n' + fm + '\n```\n\n')).join('\n')
    + '\n\n---\n\n## 拦得最多的规矩\n\n' + (stats.length ? '| 检查 | 次数 | 会话数 | 最近一次 | 拦下时的第一句 |\n|---|---|---|---|---|\n' + stats.map((x) => '| ' + cell(x.hook) + ' | ' + x.count + ' | ' + (x.sessions || []).length + ' | ' + stamp(x.at) + ' | ' + cell(x.example) + ' |').join('\n') : '没有。') + '\n\n'
    + '## 放行记录（最近 7 天）\n\n' + (passes.length ? '| 时间 | 检查 | 这一步 | 理由 | 用了几次 | 问题编号 |\n|---|---|---|---|---|---|\n' + passes.map((p) => '| ' + stamp(p.at) + ' | ' + cell(p.hook) + ' | ' + cell(clip(p.action, 80)) + ' | ' + cell(clip(redact(p.why), 160)) + ' | ' + (p.uses || 0) + ' | ' + (p.fid || '') + ' |').join('\n') : '没有。') + '\n'
    + '\n## 工具用量\n\n查库、查 redis 的工具每条命令跑了多少次、多慢、哪种错多。只记工具的事，不记 SQL 和数据。\n\n'
    + (tools.length ? '| 工具 | 命令 | 次数 | 出错 | 平均 | 最慢 | 平均起几次 java | 走缓存 | 出得最多的错 |\n|---|---|---|---|---|---|---|---|---|\n' + tools.map((t) => '| ' + cell(t.tool) + ' | ' + cell(t.cmd) + ' | ' + t.n + ' | ' + t.fail + ' | ' + sec(t.avg) + ' | ' + sec(t.max) + ' | ' + (t.tool === 'ttls-db-crud' ? t.java : '') + ' | ' + (t.cached || '') + ' | ' + cell(t.errors.map((e) => e[0] + ' ×' + e[1]).join('，')) + ' |').join('\n') : '还没用过。') + '\n'
    + '\n## 能优化的地方\n\n从用量里数出来的，不是谁报的问题。\n\n' + (tips.length ? tips.map((t) => '- **' + cell(t.what) + '**。' + cell(t.detail)).join('\n') : '没有。') + '\n';
}
function exportToFile(outDir) {
  const dir = outDir ? path.resolve(outDir) : EXPORT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const file = path.join(dir, 'vibe-kit问题汇总-' + os.hostname().replace(/[\\/:*?"<>|]/g, '_') + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.md');
  fs.writeFileSync(file, exportText());
  return file;
}

/** 列表里每条的样子：清空时拿它对照，导出（或者看列表）之后又变了的不删 */
const itemOf = (r) => ({ id: r.meta.id, updated: r.meta['更新'] || r.meta['时间'] || '', count: Number(r.meta['次数']) || 1, h: crypto.createHash('sha1').update(r.text).digest('hex').slice(0, 12) });
/**
 * 清空（只给配置页用：维护者导出、复制走之后清掉，下次收的时候没有旧的）。只删给定的这些条，而且要跟给定时一模一样
 * （更新时间、次数都没变）：导出之后又记的新问题、又出现过的老问题留着，下次一起导出。导出目录里的旧汇总也删掉。返回 { cleared, kept }
 */
function clearRecords(items) {
  const want = new Map((items || []).map((x) => [String(x.id), x]));
  let cleared = 0; let kept = 0;
  for (const r of listRecords()) {
    const w = want.get(r.meta.id);
    if (!w) continue;
    const now = itemOf(r);
    if (String(w.updated || '') !== String(now.updated) || Number(w.count || 0) !== now.count || (w.h && w.h !== now.h)) { kept++; continue; }
    try { fs.unlinkSync(r.file); cleared++; } catch (e) { kept++; }
  }
  try { for (const f of fs.readdirSync(EXPORT_DIR)) fs.rmSync(path.join(EXPORT_DIR, f), { recursive: true, force: true }); } catch (e) { /* 没有导出目录 */ }
  hookLog('问题反馈：配置页清空了 ' + cleared + ' 条' + (kept ? '，' + kept + ' 条之后又有更新，留着' : ''));
  return { cleared, kept };
}

module.exports = { DIR, BYPASSABLE, sigOf, redact, noteSession, sessionForCwd, record, listRecords, sessionRecords, recordHookError, registerBlock, passesFor, validPasses, pickPass, bypassOutcome, requestBypass, exportText, exportToFile, markRecord, itemOf, clearRecords, audit, auditList, blockStats, bypassLog, isNoise };
