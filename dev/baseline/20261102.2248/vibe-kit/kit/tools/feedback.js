'use strict';
/*
 * 套件的问题反馈（用户的 AI 记，维护者收），和被拦住走不下去时的申请放行。记录都在 ~/.claude/vibe-kit/feedback/，说明见 lib/feedback.js。
 *
 *   node feedback.js help
 *   node feedback.js add --title "一句话" --what "套件原话、当时在做什么" --why "查证过什么、为什么认为是套件的问题"
 *                        [--kind 误拦|漏拦|卡住|出错|提示不清|建议] [--hook 涉及哪道检查或哪个技能] [--did "怎么处理的"] [--suggest "建议怎么改"]
 *   node feedback.js add --file <草稿.md>        长的先按 help 里的模板写成文件（放 .vibe/tmp/ 下），记完草稿自动删掉
 *   node feedback.js add --same <问题编号> --what "补充的情况"      同一个问题又看到了新情况：补在原来那条后面，不另记一条
 *   node feedback.js bypass <拦截编号> --why "查过什么、差在哪" [--bug]     --bug：确信是套件判断错了（会记成一条问题）
 *   node feedback.js list
 */
const fs = require('fs');
const path = require('path');
const fb = require('../lib/feedback');

const argv = process.argv.slice(2);
const sub = argv[0] || 'help';
const opts = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; opts[k] = opts[k] ? opts[k] + '\n' + v : v; }
  else pos.push(a);
}
const KINDS = ['误拦', '漏拦', '卡住', '出错', '提示不清', '建议', '其他'];
const TEMPLATE = [
  '# 一句话说清问题（例：打勾时说提案没审过，但已经审了 6 轮）',
  '类型：误拦 / 漏拦 / 卡住 / 出错 / 提示不清 / 建议（选一个）',
  '涉及：哪道检查、哪个技能或工具（例：guard-spec 打勾检查、verify-gate 收工检查、devserver、ttls-cross-review 技能、ttls-db-crud、ttls-redis）',
  '',
  '## 现象',
  '套件的原话（拦截提示原文照贴）；当时在做什么（哪个文件、哪条命令）。',
  '',
  '## 为什么认为是套件的问题',
  '查证过什么：读了哪段代码、会话记录里的哪一条、实际结果是什么。只写查过的，猜的写明是猜的。',
  '',
  '## 怎么处理的',
  '等用户定 / 申请放行 / 换了做法（换成了什么）。',
  '',
  '## 建议怎么改',
  '（可选）',
].join('\n');

function help() {
  console.log([
    '套件（钩子、技能、工具）有问题：拦错了、漏拦了、报错、提示看不懂、流程卡住——当场记一条，会自动上报给改套件的人。',
    '',
    '短的直接写在命令里：',
    '  node "$HOME/.claude/vibe-kit/tools/feedback.js" add --kind 误拦 --hook guard-spec --title "一句话" --what "套件原话、当时在做什么" --why "查证过什么、为什么认为是套件的问题" [--did "怎么处理的"] [--suggest "建议"]',
    '长的先写成文件（放 .vibe/tmp/ 下），再：node "$HOME/.claude/vibe-kit/tools/feedback.js" add --file <文件>。模板：',
    '',
    TEMPLATE.split('\n').map((l) => '    ' + l).join('\n'),
    '',
    '同一个问题只记一条。又看到了新情况（换了个角度、又出现一次）：补在原来那条后面，',
    '  node "$HOME/.claude/vibe-kit/tools/feedback.js" add --same <问题编号> --what "补充的情况"',
    '不是套件的问题不要记：要用户拿主意的事、环境不具备、任务本身做不了，写进最后的交代。',
    '',
    '被拦下、提示末尾带〔拦截编号〕：',
    '  node "$HOME/.claude/vibe-kit/tools/feedback.js" bypass <编号> --why "查过什么（读了哪段代码、跑了哪条命令、实际结果）、差在哪" [--bug]',
    '  用户在的时候：只有确信是套件拦错了、任务因此走不下去才申请。它先记一条问题，再开一张通行证（30 分钟内、对同一个文件或同一件事的这道检查、只用一次），一般会弹确认框等用户点同意。',
    '  全自动模式（用户不在）：照提示改不了、条件现在满足不了的（要等用户、环境不具备）也可以申请，直接放行，记进全自动报告，不记成问题；确信是套件判断错了，末尾加 --bug，才记成问题。',
    '  没带编号的拦截（改套件、读令牌、关钩子、结束路由、非 UTF-8 文件、整仓 add）不能放行：用户在就停下来告诉用户；全自动模式下这一步不做，换个做法，或者留给用户、写进最后的交代。',
    '',
    '收工交代里单独列一节"套件问题"：逐条写现象、影响了什么、怎么处理的、编号。',
    '',
    '  node "$HOME/.claude/vibe-kit/tools/feedback.js" list      这台电脑上记过的问题',
  ].join('\n'));
}

/** 按模板写的草稿：标题、类型、涉及、几个小节 */
function parseDraft(text) {
  const t = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const out = { title: ((t.match(/^#\s+(.+)$/m) || [])[1] || '').trim(), kind: ((t.match(/^类型\s*[:：]\s*(.+)$/m) || [])[1] || '').trim(), hook: ((t.match(/^涉及\s*[:：]\s*(.+)$/m) || [])[1] || '').trim() };
  const sec = (name) => { const m = t.match(new RegExp('^##\\s*' + name + '[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'm')); return m ? m[1].trim() : ''; };
  out.what = sec('现象'); out.why = sec('为什么'); out.did = sec('怎么处理'); out.suggest = sec('建议');
  return out;
}
const kindOf = (k) => { const s = String(k || ''); return KINDS.find((x) => s.includes(x)) || (s ? '其他' : '其他'); };

/** 同一个问题的新情况：补在原来那条后面 */
function addSame() {
  const id = String(opts.same || '').trim().toUpperCase();
  const old = fb.listRecords().find((r) => String(r.meta.id).toUpperCase() === id);
  if (!old) { console.log('找不到问题 ' + id + '。用 list 看这台电脑上记过的。'); return 1; }
  const more = [opts.what, opts.why, opts.did, opts.suggest].filter((x) => x && x !== 'true').join('；');
  if (!String(more).trim()) { console.log('要写补充的情况：--what "又看到了什么"。'); return 1; }
  const s = fb.sessionForCwd(process.cwd());
  const r = fb.record({ sig: old.meta['签名'] || '', title: old.title, note: more, sid: s ? s.sid : '', cwd: process.cwd(), transcript: s ? s.transcript : '' });
  if (r.id !== old.meta.id) { console.log('原来那条没有签名，补不上，另记了一条：' + r.id + '。'); return 0; }
  console.log('补在 ' + r.id + ' 后面了（现在 ' + r.count + ' 次）。');
  return 0;
}
function add() {
  if (opts.same && opts.same !== 'true') return addSame();
  let d = { title: opts.title, kind: opts.kind, hook: opts.hook, what: opts.what, why: opts.why, did: opts.did, suggest: opts.suggest };
  let draft = '';
  if (opts.file) {
    draft = path.resolve(opts.file);
    let text = '';
    try { text = fs.readFileSync(draft, 'utf8'); } catch (e) { console.log('读不到草稿：' + draft); return 1; }
    const p = parseDraft(text);
    d = { title: d.title || p.title, kind: d.kind || p.kind, hook: d.hook || p.hook, what: d.what || p.what, why: d.why || p.why, did: d.did || p.did, suggest: d.suggest || p.suggest };
  }
  if (!d.title || /^一句话/.test(d.title)) { console.log('要有标题：一句话说清是什么问题（--title，或者草稿第一行"# …"）。'); return 1; }
  if (!String(d.what || '').trim() && !String(d.why || '').trim()) { console.log('要写现象（--what：套件原话、当时在做什么）和为什么认为是套件的问题（--why：查证过什么）。'); return 1; }
  const s = fb.sessionForCwd(process.cwd());
  const r = fb.record({
    kind: kindOf(d.kind), hook: d.hook || '（没说）', source: '模型反馈', title: d.title, what: d.what, why: d.why, did: d.did, suggest: d.suggest,
    sig: fb.sigOf(['model', d.hook || '', d.title]), sid: s ? s.sid : '', cwd: process.cwd(), transcript: s ? s.transcript : '',
  });
  // 草稿是过程文件：在 .vibe 里的记完就删
  if (draft && /[\\/]\.vibe[\\/]/.test(draft)) { try { fs.unlinkSync(draft); } catch (e) { /* 删不了就留着 */ } }
  console.log('已记下：' + r.id + (r.repeated ? '（以前记过同样的，次数 +1，现在 ' + r.count + ' 次）' : '') + '。收工交代里单独列"套件问题"时写上这个编号。');
  // 这个会话已经记过的：同一个问题换个角度又记一条，收的人要看好几遍
  if (s && !r.repeated) {
    const mine = fb.sessionRecords(s.sid).filter((x) => x.meta.id !== r.id && /模型反馈|申请放行/.test(x.meta['来源'] || '')).slice(0, 6);
    if (mine.length) console.log('这个会话还记过：' + mine.map((x) => x.meta.id + ' ' + x.title.slice(0, 40)).join('；') + '。刚记的和其中哪条是同一个问题，以后有新情况就补在那一条后面（add --same <编号> --what "…"），不要再另记。');
  }
  return 0;
}

function bypass() {
  const id = pos[0];
  if (!id) { console.log('要写拦截编号：node feedback.js bypass <编号> --why "查过什么、差在哪"（确信是套件判断错了，末尾加 --bug）'); return 1; }
  const r = fb.requestBypass(id, opts.why, { title: opts.title, what: opts.what, suggest: opts.suggest, bug: opts.bug !== undefined });
  console.log(r.msg);
  return r.ok ? 0 : 1;
}

function list() {
  const recs = fb.listRecords();
  if (!recs.length) { console.log('这台电脑上还没有记过问题（' + fb.DIR + '）。'); return 0; }
  console.log('这台电脑上记过 ' + recs.length + ' 条问题（' + fb.DIR + '）：');
  for (const r of recs.slice(0, 50)) console.log('  ' + r.meta.id + '  ' + (r.meta['更新'] || r.meta['时间']) + '  ' + r.meta['类型'] + '  ' + r.meta['涉及'] + '  ' + r.title + (Number(r.meta['次数']) > 1 ? '（' + r.meta['次数'] + ' 次）' : '') + (/已申请|已放行|等确认/.test(r.meta['放行'] || '') ? '  放行：' + r.meta['放行'] : ''));
  return 0;
}

let code = 0;
try {
  if (sub === 'add') code = add();
  else if (sub === 'bypass') code = bypass();
  else if (sub === 'list') code = list();
  // 2026-10-01 起没有 export：问题自动上报成团队 GitLab 的议题，维护套件的人在配置页导出议题
  else if (sub === 'export') { console.log('没有这个命令了：记下的问题会自动上报，不用导出。'); code = 1; }
  else if (sub === 'template') console.log(TEMPLATE);
  else help();
} catch (e) { console.log('出错了：' + ((e && e.stack) || e)); code = 1; }
process.exit(code);
