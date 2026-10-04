'use strict';
/*
 * 长上下文实际能用多长：1M 是标称值，这里看几十万 token 时模型还靠不靠得住、要等多久。
 * 每一档造一份像真实项目的长材料（Java 代码加中文注释、配置、文档），开头写一条项目约定，
 * 在 10%、50%、90% 的位置各埋一条事实，然后：
 *   冷请求：问三条事实，再按约定给一个新字段起名 → 多久出结果、实际输入多少 token、答对几项
 *   热请求：同样的前缀换个问法再问一次 → 提示缓存让它快了多少
 * 可选：等一段时间后把中间那档再发一次，看缓存能活多久。
 * 网关拒绝大请求（413）、超出模型上下文（400）都会记下来，更长的档就不再发。
 *
 * 用法：node long-context.js --out 目录 [--model 名称] [--sizes 100000,300000,600000] [--cache-wait 秒]
 * 端点和 key 从环境变量读（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY），两种鉴权头都带。
 * 过程边跑边打印；结果写 long.json、long.md，最后一行打印 LONGCTX {json}。只用 Node 内置模块。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const BASE = String(process.env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';
const APIKEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = String(args.model || process.env.ANTHROPIC_MODEL || 'claude-opus-5');
const OUT = path.resolve(String(args.out || path.join(__dirname, '..', 'results', 'longctx')));
const SIZES = String(args.sizes || '100000,300000,600000').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const CACHE_WAIT = Math.max(0, parseInt(args['cache-wait'] || '0', 10) || 0);
let charsPerToken = 2.6;

const CONSTRAINT = '【项目约定】本项目所有表示金额的字段名一律以 Amt 结尾，例如 orderAmt、feeAmt、taxAmt。回答里只要涉及给金额字段起名，都必须遵守这条约定。';
const REASONS = ['供应商驳回', '库存锁定超时', '签章服务不可用', '达梦主备切换中', '结算周期已关闭', '审批流被撤回', '发票抬头不一致', '仓库盘点冻结'];
const DISTRACT = ['参数缺失', '签名错误', '重复提交', '会话过期', '权限不足', '数据被锁', '网关超时', '格式不对', '版本冲突', '余额不足'];
const NOUNS = ['订单', '客户', '设备', '巡检', '告警', '工单', '结算', '库存', '合同', '发票', '供应商', '仓库', '排班', '审批', '台账'];
const EN = ['Order', 'Customer', 'Device', 'Inspection', 'Alarm', 'Ticket', 'Settle', 'Stock', 'Contract', 'Invoice', 'Supplier', 'Warehouse', 'Shift', 'Approval', 'Ledger'];
const VERBS = ['查询', '保存', '更新', '删除', '导出', '校验', '同步', '汇总', '分配', '归档'];
const VEN = ['query', 'save', 'update', 'remove', 'export', 'check', 'sync', 'summarize', 'assign', 'archive'];

// 固定种子的随机数：同一档每次生成的材料一样，事实的值每档不同
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function javaUnit(r, idx) {
  const k = Math.floor(r() * NOUNS.length);
  const cls = EN[k] + pick(r, ['Service', 'Dao', 'Manager', 'Helper']) + idx;
  let s = '// ==== src/main/java/com/demo/' + EN[k].toLowerCase() + '/' + cls + '.java ====\n';
  s += 'package com.demo.' + EN[k].toLowerCase() + ';\n\n';
  s += '/**\n * ' + NOUNS[k] + '相关的业务处理，第 ' + idx + ' 号模块。\n * 注意：达梦库里的表名都是大写，SQL 里别写小写。\n */\n';
  s += 'public class ' + cls + ' {\n';
  if (r() < 0.3) s += '    private static final double ' + pick(r, ['DISCOUNT_RATE', 'TAX_RATE', 'PENALTY_RATE']) + ' = 0.' + String(10 + Math.floor(r() * 90)) + ';\n\n';
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.floor(r() * VERBS.length);
    const m = VEN[v] + EN[k] + (i + 1);
    s += '    /** ' + VERBS[v] + NOUNS[k] + '：按' + pick(r, ['编号', '日期', '状态', '负责人']) + '处理，失败时记日志并返回空列表 */\n';
    s += '    public java.util.List<java.util.Map<String, Object>> ' + m + '(String key, int limit) {\n';
    s += '        String sql = "SELECT * FROM T_' + EN[k].toUpperCase() + ' WHERE STATUS = ? AND ROWNUM <= " + limit;\n';
    s += '        java.util.List<java.util.Map<String, Object>> rows = jdbc.queryForList(sql, key);\n';
    s += '        if (rows.isEmpty()) {\n            log.warn("' + VERBS[v] + NOUNS[k] + '没有数据：" + key);\n        }\n';
    s += '        return rows;\n    }\n\n';
  }
  return s + '}\n\n';
}

function propsUnit(r, idx) {
  const pre = pick(r, ['oracle.pool', 'redis.pool', 'mq.consumer', 'mysql.pool', 'http.client']);
  let s = '# ==== conf/module-' + idx + '.properties ====\n# ' + pick(r, NOUNS) + '模块的连接配置\n';
  s += pre + '.minIdle=' + Math.floor(r() * 20) + '\n';
  s += pre + '.maxActive=' + (20 + Math.floor(r() * 200)) + '\n';
  s += pre + '.maxWait=' + (1000 + Math.floor(r() * 9000)) + '\n';
  s += pre + '.timeBetweenEvictionRunsMillis=' + (10000 + Math.floor(r() * 50000)) + '\n';
  s += 'module.' + idx + '.enabled=' + (r() < 0.5 ? 'true' : 'false') + '\n\n';
  return s;
}

function docUnit(r, idx, used) {
  let s = '## ==== docs/module-' + idx + '.md ====\n\n';
  s += pick(r, NOUNS) + '模块说明：这个模块负责' + pick(r, VERBS) + pick(r, NOUNS) + '，每天凌晨两点跑一次批处理，失败会发告警到值班群。';
  s += '上线前要在测试库跑一遍回归，达梦和 Oracle 两套库的语法差异见附录。\n\n';
  s += '| 错误码 | 含义 | 处理方式 |\n|---|---|---|\n';
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    let code;
    do { code = String(1000 + Math.floor(r() * 9000)); } while (used.has(code));
    used.add(code);
    s += '| E-' + code + ' | ' + pick(r, DISTRACT) + ' | ' + pick(r, ['提示用户重试', '转人工处理', '记录日志后忽略', '联系运维']) + ' |\n';
  }
  return s + '\n';
}

function buildMaterial(targetTokens, seed) {
  const r = rng(seed);
  const targetChars = Math.round(targetTokens * charsPerToken);
  const facts = {
    maxWait: 1000 + Math.floor(r() * 9000),
    rebate: '0.0' + String(100 + Math.floor(r() * 900)),
    code: String(1000 + Math.floor(r() * 9000)),
    reason: pick(r, REASONS),
  };
  const used = new Set([facts.code]);
  const units = [];
  let total = 0;
  let idx = 1;
  while (total < targetChars) {
    const t = r();
    const u = t < 0.6 ? javaUnit(r, idx) : (t < 0.8 ? propsUnit(r, idx) : docUnit(r, idx, used));
    units.push(u);
    total += u.length;
    idx++;
  }
  const at = (frac) => { let acc = 0; for (let i = 0; i < units.length; i++) { acc += units[i].length; if (acc >= frac * total) return i + 1; } return units.length; };
  const f1 = '# ==== conf/datasource.properties ====\n# 达梦连接池配置（2026 年 3 月运维调过，别随便改）\ndm.pool.minIdle=5\ndm.pool.maxActive=80\n# 从达梦连接池取连接的最长等待时间，单位毫秒\ndm.pool.maxWait=' + facts.maxWait + '\ndm.pool.validationQuery=SELECT 1 FROM DUAL\n\n';
  const f2 = '// ==== src/main/java/com/demo/settle/RebateCalculator.java ====\npackage com.demo.settle;\n\n/** 返利计算。比例是财务 2026 年定的，改之前先找财务确认 */\npublic class RebateCalculator {\n    private static final double REBATE_RATE = ' + facts.rebate + ';\n\n    public long calcRebate(long orderAmt) {\n        return Math.round(orderAmt * REBATE_RATE);\n    }\n}\n\n';
  const rows = [];
  for (let i = 0; i < 5; i++) {
    let code;
    do { code = String(1000 + Math.floor(r() * 9000)); } while (used.has(code));
    used.add(code);
    rows.push('| E-' + code + ' | ' + pick(r, DISTRACT) + ' | ' + pick(r, ['提示用户重试', '转人工处理', '联系运维']) + ' |');
  }
  rows.splice(Math.floor(r() * rows.length), 0, '| E-' + facts.code + ' | ' + facts.reason + ' | 通知结算组人工处理 |');
  const f3 = '## ==== docs/error-codes.md ====\n\n结算模块对外返回的错误码：\n\n| 错误码 | 含义 | 处理方式 |\n|---|---|---|\n' + rows.join('\n') + '\n\n';
  // 从后往前插，前面的下标才不会被挤乱
  const p3 = at(0.9), p2 = at(0.5), p1 = at(0.1);
  units.splice(p3, 0, f3);
  units.splice(p2, 0, f2);
  units.splice(p1, 0, f1);
  return { text: units.join(''), facts };
}

function question(f, warm) {
  const fields = warm
    ? '{"refundField": "按项目约定给\'退款金额\'起的英文字段名", "errorMeaning": "错误码 E-' + f.code + ' 的含义", "rebateRate": RebateCalculator 里 REBATE_RATE 的值, "maxWait": 配置里 dm.pool.maxWait 的数字}'
    : '{"maxWait": 配置里 dm.pool.maxWait 的数字, "rebateRate": RebateCalculator 里 REBATE_RATE 的值, "errorMeaning": "错误码 E-' + f.code + ' 的含义", "refundField": "按项目约定给\'退款金额\'起的英文字段名"}';
  return (warm ? '再确认一遍。' : '以上是一个项目的部分代码、配置和文档。') + '根据材料回答，只输出 JSON，不要解释：' + fields + '。材料里找不到的写 null，不要猜。';
}

function pickJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// 四项：约定（开头）、10% 处的配置、50% 处的常量、90% 处的错误码
function score(text, f) {
  const a = pickJson(text);
  if (!a) return { score: 0, detail: '回答里没有能解析的 JSON：' + String(text || '').slice(0, 100) };
  const d = [];
  let s = 0;
  if (parseInt(String(a.maxWait).replace(/[^0-9]/g, ''), 10) === f.maxWait) s++; else d.push('10% 处的 maxWait 答成 ' + JSON.stringify(a.maxWait));
  if (Math.abs(parseFloat(a.rebateRate) - parseFloat(f.rebate)) < 1e-9) s++; else d.push('50% 处的返利比例答成 ' + JSON.stringify(a.rebateRate));
  if (String(a.errorMeaning || '').indexOf(f.reason) >= 0) s++; else d.push('90% 处的错误码含义答成 ' + JSON.stringify(a.errorMeaning));
  if (/Amt$/.test(String(a.refundField || '').trim())) s++; else d.push('开头约定的字段名答成 ' + JSON.stringify(a.refundField));
  return { score: s, detail: d.join('；') || '全对' };
}

function send(material, q) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try { url = new URL(/\/v1$/i.test(BASE) ? BASE + '/messages' : BASE + '/v1/messages'); } catch (e) { resolve({ status: 0, error: '地址不合法' }); return; }
    const body = JSON.stringify({
      model: MODEL, max_tokens: 600, stream: true,
      system: '你是项目助手，只根据用户给的材料回答。',
      messages: [{ role: 'user', content: [
        { type: 'text', text: CONSTRAINT + '\n\n' + material, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: q },
      ] }],
    });
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body) };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    if (APIKEY) headers['x-api-key'] = APIKEY;
    const lib = url.protocol === 'https:' ? https : http;
    const out = { status: 0, bodyMB: Math.round(Buffer.byteLength(body) / 1048576 * 10) / 10, ttftMs: null, totalMs: null, text: '', inputTokens: null, cacheRead: null, error: '' };
    let buf = '';
    let raw = '';
    const req = lib.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, rejectUnauthorized: false, timeout: 900000,
    }, (res) => {
      out.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const now = Date.now();
        if (raw.length < 4000) raw += chunk;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === 'message_start' && ev.message && ev.message.usage) {
            const u = ev.message.usage;
            out.inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            out.cacheRead = u.cache_read_input_tokens || 0;
          } else if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
            if (out.ttftMs === null) out.ttftMs = now - started;
            out.text += ev.delta.text;
          }
        }
      });
      res.on('end', () => {
        out.totalMs = Date.now() - started;
        if (out.status !== 200) out.error = raw.slice(0, 400);
        resolve(out);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('900 秒没有响应')); });
    req.on('error', (e) => { out.error = String(e && e.message || e); out.totalMs = Date.now() - started; resolve(out); });
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sec = (ms) => (ms === null || ms === undefined ? '-' : (Math.round(ms / 100) / 10) + ' 秒');

function brief(res, f) {
  const o = { status: res.status, bodyMB: res.bodyMB, ttftMs: res.ttftMs, totalMs: res.totalMs, inputTokens: res.inputTokens, cacheRead: res.cacheRead };
  if (res.status === 200) Object.assign(o, score(res.text, f), { answer: res.text.slice(0, 300) });
  else o.error = res.error;
  return o;
}

function show(label, b) {
  if (b.status === 200) console.log('  ' + label + '：' + sec(b.ttftMs) + ' 出结果，输入 ' + (b.inputTokens || '?') + ' token，答对 ' + b.score + '/4' + (b.score < 4 ? '（' + b.detail + '）' : ''));
  else console.log('  ' + label + '：失败，状态 ' + b.status + '，' + String(b.error || '').slice(0, 160));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { model: MODEL, sizes: SIZES, rows: [], cache: null, stop: '', notes: [] };
  if (!BASE) { report.stop = '没有端点地址'; finish(report); return; }
  const budget = SIZES.reduce((a, b) => a + b, 0) * 2;
  console.log('模型 ' + MODEL + '，档位 ' + SIZES.join(' / ') + ' token，大约消耗 ' + Math.round(budget / 10000) + ' 万 token' + (CACHE_WAIT ? '，最后再等 ' + CACHE_WAIT + ' 秒测一次缓存' : ''));
  const mid = SIZES[Math.floor((SIZES.length - 1) / 2)];
  let midKeep = null;
  for (let i = 0; i < SIZES.length; i++) {
    const size = SIZES[i];
    if (report.stop) { report.rows.push({ size, skipped: report.stop }); continue; }
    const mat = buildMaterial(size, 1000 + i * 7919);
    const row = { size, chars: mat.text.length, facts: mat.facts };
    console.log('');
    console.log('[' + size + ' token 档] 材料 ' + mat.text.length + ' 字符');
    const cold = await send(mat.text, question(mat.facts, false));
    row.cold = brief(cold, mat.facts);
    show('冷请求', row.cold);
    if (cold.status === 413) report.stop = '网关拒绝了这么大的请求（413，请求体约 ' + cold.bodyMB + ' MB），更长的档没法测';
    else if (cold.status === 400 && /context|too long|maximum|exceed|length|token/i.test(cold.error)) report.stop = '超出了模型的上下文上限（' + String(cold.error).slice(0, 120) + '）';
    if (cold.status === 200) {
      // 用这一档实际的 token 数校准后面各档该造多少字符
      if (cold.inputTokens && cold.inputTokens > 1000) charsPerToken = mat.text.length / cold.inputTokens;
      const warm = await send(mat.text, question(mat.facts, true));
      row.warm = brief(warm, mat.facts);
      show('热请求', row.warm);
      if (size === mid) midKeep = { mat, lastAt: Date.now() };
    }
    report.rows.push(row);
  }
  if (CACHE_WAIT && midKeep && !report.stop) {
    const waitMs = Math.max(0, CACHE_WAIT * 1000 - (Date.now() - midKeep.lastAt));
    console.log('');
    console.log('等 ' + Math.round(waitMs / 1000) + ' 秒后，再发一次 ' + mid + ' token 那档，看缓存还在不在……');
    await sleep(waitMs);
    const again = await send(midKeep.mat.text, question(midKeep.mat.facts, true));
    report.cache = Object.assign({ size: mid, waitSec: CACHE_WAIT }, brief(again, midKeep.mat.facts));
    show('隔了 ' + CACHE_WAIT + ' 秒再问', report.cache);
  }
  report.charsPerToken = Math.round(charsPerToken * 100) / 100;

  // 判读
  const ok = report.rows.filter((r) => r.cold && r.cold.status === 200);
  const perfect = ok.filter((r) => r.cold.score === 4 && (!r.warm || r.warm.score === 4));
  if (!ok.length) report.notes.push('一档都没测成' + (report.stop ? '：' + report.stop : ''));
  else {
    const maxOk = perfect.length ? Math.max.apply(null, perfect.map((r) => r.cold.inputTokens || r.size)) : 0;
    const firstBad = ok.find((r) => r.cold.score < 4 || (r.warm && r.warm.score < 4));
    if (maxOk) report.notes.push('到 ' + Math.round(maxOk / 10000) + ' 万 token 为止，埋在开头、10%、50%、90% 处的信息都答对了。');
    if (firstBad) report.notes.push('从 ' + Math.round((firstBad.cold.inputTokens || firstBad.size) / 10000) + ' 万 token 那档开始丢分：' + (firstBad.cold.score < 4 ? firstBad.cold.detail : firstBad.warm.detail) + '。');
    const biggest = ok[ok.length - 1];
    report.notes.push('最长那档（' + Math.round((biggest.cold.inputTokens || biggest.size) / 10000) + ' 万 token）冷启动要 ' + sec(biggest.cold.ttftMs) + ' 才出结果' + (biggest.warm && biggest.warm.status === 200 ? '，同样前缀第二次 ' + sec(biggest.warm.ttftMs) + '。' : '。'));
    if (report.cache && report.cache.status === 200) {
      const midRow = ok.find((r) => r.size === report.cache.size);
      if (midRow && midRow.warm && midRow.warm.ttftMs && midRow.cold.ttftMs) {
        if (midRow.warm.ttftMs > midRow.cold.ttftMs * 0.7) {
          // 同样前缀第二次并没有明显更快：本来就看不出缓存，谈不上缓存能活多久
          report.notes.push('同样前缀第二次并没有明显更快（' + sec(midRow.cold.ttftMs) + ' → ' + sec(midRow.warm.ttftMs) + '），看不出有提示缓存，也就判断不了缓存能保持多久。');
        } else {
          const alive = report.cache.ttftMs < (midRow.warm.ttftMs + midRow.cold.ttftMs) / 2;
          report.notes.push('隔 ' + report.cache.waitSec + ' 秒再问：' + sec(report.cache.ttftMs) + '（刚问完时 ' + sec(midRow.warm.ttftMs) + '，冷启动 ' + sec(midRow.cold.ttftMs) + '），' + (alive ? '缓存还在。' : '缓存已经没了，歇一会儿再继续长会话要重新等冷启动。'));
        }
      }
    }
  }
  if (report.stop) report.notes.push(report.stop);
  finish(report);
})().catch((e) => { finish({ model: MODEL, rows: [], stop: '脚本出错：' + String(e && e.stack || e).slice(0, 300), notes: [] }); });

function finish(report) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'long.json'), JSON.stringify(report, null, 1));
  const L = ['| 档位 | 实际输入 token | 冷：出结果 | 冷：答对 | 热：出结果 | 热：答对 | 丢分 |', '|---|---|---|---|---|---|---|'];
  for (const r of report.rows || []) {
    if (r.skipped) { L.push('| ' + r.size + ' | - | - | - | - | - | 没测：' + r.skipped + ' |'); continue; }
    const c = r.cold || {}, w = r.warm || {};
    const cs = c.status === 200 ? c.score + '/4' : '失败 ' + c.status;
    const ws = w.status === 200 ? w.score + '/4' : (r.warm ? '失败 ' + w.status : '-');
    const lost = [c.status === 200 && c.score < 4 ? '冷：' + c.detail : '', w.status === 200 && w.score < 4 ? '热：' + w.detail : '', c.status !== 200 ? String(c.error || '').slice(0, 80) : ''].filter(Boolean).join('；');
    L.push('| ' + r.size + ' | ' + (c.inputTokens || '-') + ' | ' + sec(c.ttftMs) + ' | ' + cs + ' | ' + sec(w.ttftMs) + ' | ' + ws + ' | ' + (lost || '-').replace(/\|/g, '/') + ' |');
  }
  L.push('');
  for (const n of report.notes || []) L.push('- ' + n);
  fs.writeFileSync(path.join(OUT, 'long.md'), L.join('\n'));
  const rows = (report.rows || []).map((r) => ({ size: r.size, skipped: r.skipped, tokens: r.cold && r.cold.inputTokens, coldMs: r.cold && r.cold.ttftMs, coldScore: r.cold && r.cold.score, warmMs: r.warm && r.warm.ttftMs, warmScore: r.warm && r.warm.score }));
  console.log('');
  (report.notes || []).forEach((n) => console.log('  ' + n));
  console.log('LONGCTX ' + JSON.stringify({ model: report.model, stop: report.stop, notes: report.notes, rows, cache: report.cache ? { waitSec: report.cache.waitSec, ttftMs: report.cache.ttftMs, status: report.cache.status } : null }));
}
