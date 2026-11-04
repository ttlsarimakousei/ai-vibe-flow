'use strict';
/*
 * 经验规则的命令行：审查确认成立的问题里，"换个任务还会再犯"的，记成一句话。规则怎么沉淀、放在哪、怎么控制条数，见 lib/lessons.js。
 *
 *   node lesson.js help
 *   node lesson.js add --file <出问题的文件> --when "<什么情况下>" --do "<要怎么做>" --from "<变更名> <任务号>" [--kind <类别>] [--same <编号> | --new]
 *   node lesson.js add … --checkable "<怎么用脚本查出来>"      能用脚本查的不写规则：记一条问题反馈，交给改套件的人做成检查
 *   node lesson.js none --from "<变更名>"                       这次审查确认的问题都是一次性的疏忽，没有要沉淀的
 *   node lesson.js list                                          这个项目现在生效的规则、候选，和用户级规则
 *   node lesson.js retire <编号> --why "<为什么>"                 项目规则写错了、过时了：退役
 *   node lesson.js tidy [--apply]                                查过时的规则（提到的类、文件、表已经不在了）
 * 升成用户级、删用户级规则只能由用户在配置页里做，这里没有。
 */
const path = require('path');
const L = require('../lib/lessons');

const argv = process.argv.slice(2);
const sub = argv[0] || 'help';
const opts = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; opts[k] = v; }
  else pos.push(a);
}
const SELF = 'node "$HOME/.claude/vibe-kit/tools/lesson.js"';

function help() {
  const st = L.settings();
  console.log([
    '经验规则：审查确认成立、你也改了的问题里，"换个任务还会再犯"的，各记一句话。同一条在不同的变更里出现 ' + st.threshold + ' 次，就会变成项目的规则，',
    '以后读到这类文件时 Claude Code 自动带上。平时不占上下文。',
    '',
    '记一条（一条一句话，最多 ' + st.maxChars + ' 字）：',
    '  ' + SELF + ' add --file <出问题的文件> --when "<什么情况下>" --do "<要怎么做>" --from "<变更名> <任务号>"',
    '  例：' + SELF + ' add --file src/main/java/com/x/OrderService.java --when "调 OrderMapper.selectByIds 之前" --do "先判空列表，传空列表会拼出 in () 报错" --from "add-export 2.3"',
    '  可以加 --kind <类别>：' + L.KINDS.join('、'),
    '',
    '什么样的值得记：换一个任务、换一个人来做，还会踩进去的。和这个项目有关的（某张表没有某个字段、某个公共方法的坑），或者和技术栈有关的。',
    '什么样的不记：笔误、漏看了一个字段这类一次性的疏忽；约定里已经写着的；"注意边界""仔细检查"这种照着做不了的话。',
    '能用脚本查出来的（格式、命名、某个写法不许出现）：不写规则，加 --checkable "<怎么查>"，会转给改套件的人做成检查。',
    '工具说"已有相近的"：是同一件事就原样再执行一次、末尾加 --same <编号>；不是就加 --new。',
    '',
    '都是一次性的疏忽、没有要沉淀的：' + SELF + ' none --from "<变更名>"（或者在交代里写一句"没有需要沉淀的经验"）。',
    '',
    '  ' + SELF + ' list                       这个项目现在的规则和候选',
    '  ' + SELF + ' retire <编号> --why "…"     项目规则写错了、过时了',
    '  ' + SELF + ' tidy [--apply]              查过时的规则',
    '规则文件（.claude/rules/ttls-lessons-*.md）不要直接改，用上面的命令；升成用户级由用户在配置页里点。',
  ].join('\n'));
}

function add() {
  if (opts.checkable && opts.checkable !== 'true') {
    const text = [opts.when, opts.do].filter(Boolean).join('：') || opts.text || '';
    if (!text) { console.log('要写清是什么问题（--when、--do）。'); return 1; }
    try {
      const fb = require('../lib/feedback');
      const s = fb.sessionForCwd(process.cwd());
      const r = fb.record({ kind: '建议', hook: '经验规则', source: '模型反馈', title: '建议加一道检查：' + text.slice(0, 80), what: '审查里发现的问题：' + text + '\n出处：' + (opts.from || '（没写）') + '\n文件：' + (opts.file || '（没写）'), why: '能用脚本查出来，不该靠规则提醒。', suggest: '怎么查：' + opts.checkable,
        sig: fb.sigOf(['lesson-check', text]), sid: s ? s.sid : '', cwd: process.cwd(), transcript: s ? s.transcript : '' });
      console.log('能用脚本查的不写规则：已记成一条问题反馈（' + r.id + '），会交给改套件的人做成检查。交代里"套件问题"一节写上这个编号。');
      return 0;
    } catch (e) { console.log('没记上：' + ((e && e.message) || e)); return 1; }
  }
  const r = L.add({ file: opts.file, when: opts.when, do: opts.do, text: opts.text, from: opts.from, kind: opts.kind, same: opts.same && opts.same !== 'true' ? opts.same : '', isNew: !!opts.new, cwd: process.cwd() });
  console.log(r.msg);
  // near：还没记上，要模型认一下再来一次。用 0 退出，免得被当成命令失败
  return r.status === 'rejected' ? 1 : 0;
}

function none() {
  console.log('好，这次没有需要沉淀的经验' + (opts.from && opts.from !== 'true' ? '（' + opts.from + '）' : '') + '。');
  return 0;
}

function list() {
  const root = L.repoRootOf(path.join(process.cwd(), '_'), process.cwd());
  const st = L.settings();
  const out = [];
  if (root) {
    const v = L.projectView(root);
    out.push('项目 ' + v.name + '（' + root + '）：');
    if (!v.files.length) out.push('  还没有规则。');
    for (const f of v.files) {
      out.push('  ' + f.title + '（读到 ' + f.paths.slice(0, 3).join('、') + (f.paths.length > 3 ? ' 等' : '') + ' 时带上，' + (f.rules.length + f.manual.length) + '/' + st.maxPerGroup + ' 条）');
      for (const r of f.rules) out.push('    ' + r.id + '  ' + r.text + '（' + r.count + ' 次' + (r.miss ? '，写了之后又犯 ' + r.miss + ' 次' : '') + '）');
      for (const m of f.manual) out.push('    手写    ' + m);
    }
    const cs = v.candidates.filter((c) => c.state === 'candidate' || c.state === 'evicted');
    if (cs.length) { out.push('  候选（还没到 ' + st.threshold + ' 次，不进上下文）：'); for (const c of cs.slice(0, 30)) out.push('    ' + c.id + '  ' + c.text + '（' + c.count + ' 次' + (c.state === 'evicted' ? '，被挤出来的' : '') + '）'); }
  } else out.push('当前目录不在任何项目里，只列用户级规则。');
  const o = L.overview();
  out.push('用户级（所有项目生效，' + o.userDir + '）：');
  if (!o.user.length) out.push('  还没有。');
  for (const f of o.user) { out.push('  ' + f.title); for (const r of f.rules) out.push('    ' + r.id + '  ' + r.text); for (const m of f.manual) out.push('    手写    ' + m); }
  if (o.pending.length) out.push('等用户在配置页确认升成用户级的：' + o.pending.length + ' 条。');
  console.log(out.join('\n'));
  return 0;
}

function retire() {
  const id = pos[0];
  if (!id) { console.log('要写编号：' + SELF + ' retire <编号> --why "<为什么>"'); return 1; }
  if (!opts.why || opts.why === 'true' || String(opts.why).trim().length < 6) { console.log('要写原因（--why）：规则哪里不对、还是已经过时了。'); return 1; }
  const r = L.retire(id, opts.why, process.cwd());
  console.log(r.msg);
  return r.ok ? 0 : 1;
}

function tidy() {
  const r = L.tidy(process.cwd(), !!opts.apply);
  if (!r.ok) { console.log(r.msg); return 1; }
  if (!r.stale.length) { console.log('没有过时的规则。'); return 0; }
  console.log((r.applied ? '已退掉 ' : '发现 ') + r.stale.length + ' 条过时的规则（提到的类、文件、表在项目里找不到了）：');
  for (const s of r.stale) console.log('  ' + s.id + '  ' + s.text + '（' + s.names.join('、') + '）');
  if (!r.applied) console.log('确认是过时了的，加 --apply 退掉。');
  return 0;
}

let code = 0;
try {
  if (sub === 'add') code = add();
  else if (sub === 'none') code = none();
  else if (sub === 'list') code = list();
  else if (sub === 'retire') code = retire();
  else if (sub === 'tidy') code = tidy();
  else help();
} catch (e) { console.log('出错了：' + ((e && e.stack) || e)); code = 1; }
process.exit(code);
