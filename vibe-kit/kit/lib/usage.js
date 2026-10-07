'use strict';
/*
 * 使用情况：这台电脑上每天用套件用成什么样。只数次数、记版本号，不记内容。用户 2026-10-01 提的：
 * 收集大家用 CLI 的过程信息，看套件哪里能优化。
 *
 *   攒在哪   state/usage.json，按天（本机日期），留最近 14 天。钩子、状态栏顺手 +1（bump），一次读写一个小文件
 *   传到哪   GitLab 上这台电脑的那条议题"[使用情况] 电脑名"下面，一天一条补充（lib/issues.js 的 syncUsage）。
 *            只传过完了的日子（今天的明天传），由后台进程（lib/updater.js 的 run）顺带传；传过哪几天记在 feedback/issues.json
 *   开关     config.json 的 usageReport：on（默认）/ off。off 不传，本机照样数（配置页"更新和上报"那一页能看要传的样子）
 *   给谁看   改套件的人。维护套件的那台电脑导出议题时，各台电脑的汇总在导出文件的最后（lib/issues.js 的 exportIssues）
 *
 * 记的：会话怎么来的（新开、恢复、/clear、压缩后）、开口几次、进 OpenSpec 流程几次、接着交接记录做几次、全自动收工报告几次、
 *       各道检查拦了几次、放行几次（没问人的、问了人的）、上下文到 70% / 90% / 超过上限的会话几个、审查几轮、
 *       写代码前拉代码的结果、钩子出错几次、Claude Code 和套件的版本、开关里和默认不一样的几项、
 *       路由里各个模型当天的请求、失败、切换、token（路由自己记的 usage-daily.json）、钩子在路由里跑的平均耗时
 * 不记：路径、项目名、文件名、分支名、提交信息、提示词、代码、模型的回答、令牌、key
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KIT, DEFAULT_CONFIG, readConfig, readState, updateState } = require('./session');

const KEEP_DAYS = 14;
const MAX_KEYS = 300;
const MARK = 'vibe-kit-usage';
const pad = (n) => String(n).padStart(2, '0');
/** 本机日期 YYYY-MM-DD */
const dayKey = (t) => { const d = t ? new Date(t) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const readJson = (f) => { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } };
const kitVersion = () => { try { return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; } };
/**
 * 名字里别带出内网的地址（模型的名字是用户自己起的）：带协议的网址、IP（v4、v6）、域名都换掉。
 * 域名只认两种：最后一段是常见后缀的（gw.local、llm.corp-qwen），三段以上而且每段都是字母开头的（llm.dept.intranet）。
 * 版本号那样的写法（qwen3.5、gpt-4.1-mini、glm-4.5.flash）不动
 */
const HOST_TAIL = /^(?:com|cn|net|org|io|ai|dev|gov|edu|local|lan|corp|internal|intranet|intra|home)$/i;
const maskAddr = (t) => String(t || '')
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s|]+/gi, '内网地址')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '内网IP')
  .replace(/(?<![\w:])\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?![\w:])/gi, '内网IP')
  .replace(/(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*(?![\w.])/gi, (m) => {
    const p = m.split('.');
    return HOST_TAIL.test(p[p.length - 1].split('-')[0]) || (p.length >= 3 && p.every((s) => /^[a-z]/i.test(s))) ? '内网域名' : m;
  });
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function dayOf(o, d) {
  const days = o.days && typeof o.days === 'object' && !Array.isArray(o.days) ? o.days : (o.days = {});
  const x = days[d] && typeof days[d] === 'object' ? days[d] : (days[d] = {});
  if (!x.n || typeof x.n !== 'object') x.n = {};
  const ks = Object.keys(days).sort();
  while (ks.length > KEEP_DAYS) delete days[ks.shift()];
  return x;
}
/** 今天的某个数 +n（默认 1）。记不了就算了，不影响干活 */
function bump(key, n) {
  const k = String(key || '').replace(/[^\w.\-]/g, '_').slice(0, 60);
  if (!k) return;
  const add = Number(n) > 0 ? Math.round(Number(n)) : 1;
  try {
    updateState('usage', (o) => {
      const x = dayOf(o, dayKey());
      if (x.n[k] === undefined && Object.keys(x.n).length >= MAX_KEYS) return o;
      x.n[k] = (x.n[k] || 0) + add;
      return o;
    });
  } catch (e) { /* 记不了就算了 */ }
}
/** 今天用到的版本（cc：Claude Code，kit：套件）。已经记过就不写 */
function seen(kind, ver) {
  const kd = kind === 'cc' ? 'cc' : 'kit';
  const v = String(ver || '').trim().slice(0, 40);
  if (!v || !/^[\w.\-+ ()]+$/.test(v)) return;
  try {
    const d = dayKey();
    const cur = ((readState('usage').days || {})[d] || {})[kd];
    if (Array.isArray(cur) && cur.includes(v)) return;
    updateState('usage', (o) => {
      const x = dayOf(o, d);
      const list = Array.isArray(x[kd]) ? x[kd] : [];
      if (!list.includes(v)) x[kd] = list.concat(v).slice(-5);
      return o;
    });
  } catch (e) { /* 记不了就算了 */ }
}
/** 攒着数的那几天（老的在前） */
function days() { const o = readState('usage').days; return o && typeof o === 'object' ? Object.keys(o).sort() : []; }

/** 这一天要传的数（结构化的，导出时拿来汇总） */
function collect(day) {
  const d = day || dayKey();
  const u = (readState('usage').days || {})[d] || {};
  const cfg = readConfig();
  // 开关里和默认不一样的：只写开关名和值（值是开关、数字、短的选项）
  const changed = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    const v = cfg[k];
    if (v === undefined || JSON.stringify(v) === JSON.stringify(DEFAULT_CONFIG[k])) continue;
    changed[k] = typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 16 && /^[\w.\-]*$/.test(v)) ? v : '改过';
  }
  // 路由记的各个模型当天的用量（路由自己的文件，没装路由就没有）
  const daily = readJson(path.join(KIT, 'router-data', 'usage-daily.json')) || {};
  const md = daily && typeof daily === 'object' ? daily[d] : null;
  let models = null;
  if (md && md.byProvider && typeof md.byProvider === 'object') {
    models = { requests: Number(md.requests) || 0, by: {} };
    for (const name of Object.keys(md.byProvider).slice(0, 20)) {
      const x = md.byProvider[name] || {};
      // 遮过以后重名的（两个模型的名字只差在地址上）加在一起，不是后一个盖掉前一个
      const key = maskAddr(name).slice(0, 60);
      const c = models.by[key] || { requests: 0, fail: 0, failover: 0, input: 0, output: 0 };
      models.by[key] = { requests: c.requests + (Number(x.requests) || 0), fail: c.fail + (Number(x.fail) || 0), failover: c.failover + (Number(x.failover) || 0), input: c.input + (Number(x.input) || 0) + (Number(x.cacheRead) || 0) + (Number(x.cacheWrite) || 0), output: c.output + (Number(x.output) || 0) };
    }
  }
  // 钩子在路由里跑的耗时（累计到现在的，路由记的；走命令方式的没有）
  let hooks = [];
  try {
    const hs = readState('hook-stats').byHook || {};
    hooks = Object.keys(hs).map((k) => { const h = hs[k] || {}; return { name: k.slice(0, 40), n: Number(h.n) || 0, avg: h.timed ? Math.round(h.total / h.timed) : 0, errors: Number(h.errors) || 0 }; }).filter((h) => h.n).sort((a, b) => b.avg - a.avg).slice(0, 8);
  } catch (e) { hooks = []; }
  // 查库、查 redis 的工具（累计到现在的，lib/toolstats.js 记的：只有命令名、次数、耗时，没有 SQL 和数据），和从用量里看出来能优化的地方
  let tools = [];
  let hints = [];
  try {
    const ts = require('./toolstats.js');
    tools = ts.stats(10).map((s) => ({ tool: String(s.tool).slice(0, 30), cmd: String(s.cmd).slice(0, 30), n: s.n, fail: s.fail, avg: s.avg }));
    hints = ts.hints().map((h) => maskAddr(h.what).slice(0, 120)).slice(0, 8);
  } catch (e) { tools = []; hints = []; }
  return {
    v: 1, day: d, host: os.hostname().slice(0, 60),
    kit: Array.isArray(u.kit) && u.kit.length ? u.kit : [kitVersion()].filter(Boolean), cc: Array.isArray(u.cc) ? u.cc : [],
    os: process.platform + ' ' + os.release(), node: process.version, hook: String(cfg.hookTransport || 'auto'), autoMode: cfg.autoMode === true,
    changed, n: Object.assign({}, u.n || {}), models, hooks, tools, hints,
  };
}
const num = (x) => Number(x) || 0;
const tok = (n) => (n >= 1e8 ? (n / 1e8).toFixed(1) + ' 亿' : n >= 1e4 ? Math.round(n / 1e4) + ' 万' : String(n));
/** 按前缀汇总：{ 后面的名字: 次数 }，次数多的在前 */
function byPrefix(n, prefix) {
  const out = [];
  for (const k of Object.keys(n || {})) if (k.startsWith(prefix) && num(n[k])) out.push([k.slice(prefix.length), num(n[k])]);
  return out.sort((a, b) => b[1] - a[1]);
}
/** 一张"项 | 数"的表（一天的，或者汇总了好几天、好几台电脑的） */
function rowsOf(n) {
  const g = (k) => num(n[k]);
  const blocks = byPrefix(n, 'block.');
  const blockSum = blocks.reduce((a, x) => a + x[1], 0);
  return [
    ['会话', '新开 ' + g('session.startup') + '，恢复 ' + g('session.resume') + '，/clear ' + g('session.clear') + '，压缩后接着 ' + g('session.compact')],
    ['开口', g('prompt') + ' 次；进 OpenSpec 流程 ' + g('flow.enter') + ' 次；开工 ' + g('flow.apply') + ' 次；接着交接记录做 ' + g('handover.resume') + ' 次；写交接记录 ' + g('handover.write') + ' 次；全自动收工报告 ' + g('auto.report') + ' 次'],
    ['上下文', '到 70% 的会话 ' + g('ctx.70') + ' 个，到 90% 的 ' + g('ctx.90') + ' 个，超过上限的 ' + g('ctx.100') + ' 个'],
    ['审查', '提案 ' + g('review.proposal') + ' 轮，代码 ' + g('review.code') + ' 轮，其中报"问题 0 条"的 ' + g('review.clean') + ' 轮；轮数用完 ' + g('review.exhausted') + ' 次'],
    ['拦下', blockSum ? '共 ' + blockSum + ' 次：' + blocks.slice(0, 12).map((x) => x[0] + ' ' + x[1]).join('，') : '0 次'],
    ['放行', '没问人的 ' + g('bypass.auto') + ' 次，问了人的 ' + g('bypass.ask') + ' 次'],
    ['拉代码', '拉到了新代码 ' + g('pull.updated') + ' 次，本来就是最新 ' + g('pull.latest') + ' 次，没拉成 ' + g('pull.fail') + ' 次'],
    ['钩子出错', g('hook.error') + ' 次'],
  ];
}
function modelTable(by) {
  const names = Object.keys(by || {}).sort((a, b) => num(by[b].requests) - num(by[a].requests));
  if (!names.length) return '';
  return '| 模型 | 请求 | 失败 | 切到别的模型 | 输入 token | 输出 token |\n|---|---|---|---|---|---|\n'
    + names.map((k) => { const x = by[k]; return '| ' + cell(k) + ' | ' + num(x.requests) + ' | ' + num(x.fail) + ' | ' + num(x.failover) + ' | ' + tok(num(x.input)) + ' | ' + tok(num(x.output)) + ' |'; }).join('\n') + '\n';
}
/** 一天的补充：给人看的表，最后一行是给导出汇总用的数（HTML 注释，GitLab 上不显示） */
function render(x) {
  const env = [
    ['版本', '套件 ' + (x.kit.join('、') || '？') + '；Claude Code ' + (x.cc.join('、') || '（状态栏没报）')],
    ['环境', x.os + '，Node ' + x.node + '，检查在' + ({ http: '路由里跑', command: '命令里跑' }[x.hook] || '自动选的地方跑') + '，全自动' + (x.autoMode ? '开着' : '关着')],
    ['和默认不一样的开关', Object.keys(x.changed).map((k) => k + '=' + x.changed[k]).join('，') || '没有'],
  ];
  const rows = rowsOf(x.n).concat(env);
  const hooks = x.hooks && x.hooks.length ? '\n钩子在路由里跑的耗时（累计到现在）：' + x.hooks.map((h) => h.name + ' ' + h.n + ' 次、平均 ' + h.avg + ' 毫秒' + (h.errors ? '、出错 ' + h.errors + ' 次' : '')).join('；') + '\n' : '';
  const sec = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' 秒' : ms + ' 毫秒');
  const tools = x.tools && x.tools.length ? '\n查库、查 redis 的工具（累计到现在）：' + x.tools.map((t) => t.tool + ' ' + t.cmd + ' ' + t.n + ' 次' + (t.fail ? '（出错 ' + t.fail + '）' : '') + '、平均 ' + sec(t.avg)).join('；') + '\n' : '';
  const hints = x.hints && x.hints.length ? '\n从用量里看出来能优化的：' + x.hints.join('；') + '\n' : '';
  const models = x.models ? '\n路由里各个模型（这一天一共 ' + x.models.requests + ' 次请求）：\n\n' + (modelTable(x.models.by) || '没有。\n') : '';
  const data = JSON.stringify(x).replace(/--/g, '-\\u002d');
  return '### ' + x.day + ' 的使用情况\n\n| 项 | 数 |\n|---|---|\n' + rows.map((r) => '| ' + r[0] + ' | ' + cell(r[1]) + ' |').join('\n') + '\n' + models + hooks + tools + hints
    + '\n<!-- ' + MARK + ' ' + data + ' -->\n';
}
function summary(day) { const x = collect(day); return { day: x.day, data: x, text: render(x) }; }
/** 从补充的正文里取回数（导出汇总用）。认不出返回 null */
function parse(body) {
  const m = new RegExp('<!-- ' + MARK + ' (\\{[\\s\\S]*?\\}) -->').exec(String(body || ''));
  if (!m) return null;
  try { const x = JSON.parse(m[1]); return x && x.v === 1 && x.day && x.n ? x : null; } catch (e) { return null; }
}
/**
 * 好几天、好几台电脑的汇总（导出议题时附在最后）。list 是 parse 出来的数。
 * 返回 markdown；一条都没有返回 ''
 */
function aggregate(list, from, to) {
  const xs = (list || []).filter(Boolean);
  if (!xs.length) return '';
  const n = {};
  const models = {};
  const hosts = {};
  for (const x of xs) {
    for (const k of Object.keys(x.n || {})) n[k] = num(n[k]) + num(x.n[k]);
    const by = (x.models && x.models.by) || {};
    for (const k of Object.keys(by)) { const m = models[k] || (models[k] = { requests: 0, fail: 0, failover: 0, input: 0, output: 0 }); for (const f of Object.keys(m)) m[f] += num(by[k][f]); }
    const h = hosts[x.host] || (hosts[x.host] = { days: new Set(), kit: '', cc: '', last: '', prompt: 0, blocks: 0, over: 0, requests: 0, changed: {}, hints: [] });
    h.days.add(x.day);
    if (x.day >= h.last) { h.last = x.day; h.kit = (x.kit || []).slice(-1)[0] || h.kit; h.cc = (x.cc || []).slice(-1)[0] || h.cc; h.changed = x.changed || {}; h.hints = Array.isArray(x.hints) ? x.hints : []; }
    h.prompt += num((x.n || {}).prompt);
    h.blocks += byPrefix(x.n, 'block.').reduce((a, y) => a + y[1], 0);
    h.over += num((x.n || {})['ctx.100']);
    h.requests += num(x.models && x.models.requests);
  }
  const names = Object.keys(hosts).sort();
  const personDays = names.reduce((a, k) => a + hosts[k].days.size, 0);
  // 开关：几台电脑改过哪一项
  const sw = {};
  for (const k of names) for (const c of Object.keys(hosts[k].changed)) sw[c] = (sw[c] || 0) + 1;
  // 能优化的地方：各台电脑最近一天报的，同一句话数几台电脑（数字不同的算不同的话，照原样列）
  const hint = {};
  for (const k of names) for (const w of hosts[k].hints) hint[w] = (hint[w] || 0) + 1;
  const hintList = Object.keys(hint).sort((a, b) => hint[b] - hint[a]).slice(0, 15);
  return '## 使用情况（' + from + ' 到 ' + to + '，' + names.length + ' 台电脑，一共 ' + personDays + ' 个人天）\n\n'
    + '不是问题，是各台电脑每天用套件的次数（每台电脑一条"[使用情况]"议题，一天一条补充，导出时不会被关掉）。给改套件的人看哪里能优化：'
    + '拦得多、放行多的检查，提示可能写得不清楚或者判断错了；超过上限的会话多，自动压缩没起作用；审查轮数多、轮数用完的多，审查提示或者改法有问题；'
    + '拉代码没拉成的多，看是分叉还是连不上；某个模型失败、切换多，看路由配置；钩子平均耗时长的，看那道检查。\n\n'
    + '| 项 | 合计 |\n|---|---|\n' + rowsOf(n).map((r) => '| ' + r[0] + ' | ' + cell(r[1]) + ' |').join('\n') + '\n'
    + (Object.keys(sw).length ? '| 改过的开关（几台电脑） | ' + cell(Object.keys(sw).sort((a, b) => sw[b] - sw[a]).map((k) => k + ' ' + sw[k]).join('，')) + ' |\n' : '')
    + (Object.keys(models).length ? '\n' + modelTable(models) : '')
    + (hintList.length ? '\n从用量里看出来能优化的（各台电脑最近一天报的）：\n\n' + hintList.map((w) => '- ' + w + (hint[w] > 1 ? '（' + hint[w] + ' 台电脑）' : '')).join('\n') + '\n' : '')
    + '\n| 电脑 | 天数 | 套件版本 | Claude Code | 开口 | 拦下 | 超过上限的会话 | 模型请求 |\n|---|---|---|---|---|---|---|---|\n'
    + names.map((k) => { const h = hosts[k]; return '| ' + cell(k) + ' | ' + h.days.size + ' | ' + cell(h.kit) + ' | ' + cell(h.cc) + ' | ' + h.prompt + ' | ' + h.blocks + ' | ' + h.over + ' | ' + h.requests + ' |'; }).join('\n') + '\n';
}

module.exports = { MARK, KEEP_DAYS, dayKey, bump, seen, days, collect, render, summary, parse, aggregate, maskAddr };
