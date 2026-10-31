'use strict';
/*
 * 耗时异常自动发现、上报（问题表第 20 条、审核 M04，用户 2026-10-30 定的：作为"耗时和明细只留本机"的第二个例外，第一个是审查超时上报）。
 *
 * 开关 perfReport：on 上报（默认）/ local 只记本机 / off 不记。上报的只有秒数、分段和原因类别，不带路径、项目名、命令参数。
 * 现在测的是 devserver 起服务（首次起、改了代码重启）：准备（devserver 自己的检查）、启动（命令开始到答 HTTP）两段，
 *   日志里数 Maven 的 Downloading、Compiling 行，认 Spring Boot "Started … in N seconds"、Tomcat "Server startup in [N] milliseconds"。
 * 样本在 state/perf-baseline.json：按"项目 + 种类 + 命令签名"分开（签名只有工具、目标、-o、跳不跳测试、-pl/-am、clean，不含路径和参数值），
 *   各留最近 10 次成功的，中位数作基线。第一次跑、开机不到 10 分钟的算冷启动，不进基线。
 * 判定：已有 3 次以上样本，这次到了中位数的 2 倍、多出 60 秒以上算慢；devserver 自己的准备超过 20 秒直接算慢。
 * 原因（脚本算，不问模型）：Downloading 5 条以上 → 依赖或网络；空闲内存不到 1.5 GB → 内存。这两类只记本机、不上报，
 *   除非同一个键最近 5 次里 3 次都是依赖或网络（"每次都在查远端"，记一条）。别的记成问题反馈（类型"耗时"、来源"耗时自动记录"），
 *   签名按"种类 + 慢的那一段 + 原因"，不含数字和项目，各台电脑的同类问题并成一条；每台电脑每天最多 3 条，同一个键 24 小时内不再记。
 * 出错一律放行，不影响起服务。
 */
const os = require('os');
const crypto = require('crypto');
const S = require('./session');

const BASE = 'perf-baseline';
const DAILY = 'perf-report';
const KEEP = 10;
const hash = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12);
const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
const sec = (ms) => Math.round(ms / 1000);

/** 命令签名：工具、目标、几个影响速度的参数；不含路径和参数值 */
function signature(command) {
  const c = String(command || '');
  const tool = (/(?:^|[\\/\s"])(mvnw?|gradlew?|npm|pnpm|yarn|npx|catalina|startup|java|node|vite|python3?)(?:\.cmd|\.bat|\.sh|\.exe)?(?=[\s"]|$)/i.exec(c) || [])[1] || 'other';
  const goal = (/\b(spring-boot:run|tomcat7?:run|jetty:run|bootRun|run|dev|serve|start|-jar)\b/i.exec(c) || [])[1] || '';
  const flags = [/(?:^|\s)(?:-o|--offline)(?=\s|$)/.test(c) ? 'o' : '', /-DskipTests|-Dmaven\.test\.skip=true|-x\s+test/i.test(c) ? 'skiptest' : '', /\s-pl\s/.test(c) ? 'pl' : '', /\s-am(?=\s|$)/.test(c) ? 'am' : '', /\bclean\b/.test(c) ? 'clean' : ''].filter(Boolean);
  return [tool.toLowerCase(), goal.toLowerCase()].concat(flags).join(' ');
}
/** 日志里认得出的几样：下载了几条、编了多少个文件、框架自己报的启动秒数 */
function parseLog(text) {
  const t = String(text || '');
  const downloads = (t.match(/^\[INFO\] Downloading from|^Downloading from|Downloaded from/gm) || []).length;
  const compiled = (t.match(/Compiling (\d+) source files?/g) || []).reduce((n, l) => n + Number((/(\d+)/.exec(l) || [])[1] || 0), 0);
  const boot = /Started \S+ in ([\d.]+) seconds/.exec(t);
  const tomcat = /Server startup in \[?([\d,.]+)\]? ?(ms|milliseconds)/i.exec(t);
  const appSec = boot ? Number(boot[1]) : tomcat ? Number(String(tomcat[1]).replace(/,/g, '')) / 1000 : 0;
  return { downloads, compiled, appSec: Math.round(appSec) };
}
function mode(cfg) { const v = (cfg || S.readConfig()).perfReport; return ['on', 'local', 'off'].includes(v) ? v : 'on'; }
/**
 * 起完服务记一次。o = { kind: 'first' | 'restart', root, command, prepMs, startMs, log, cfg, now, freemem（测试用，默认取本机的） }
 * 返回要打在结果行前面的一行（没什么可说的返回 ''）
 */
function noteStart(o) {
  try {
    const cfg = o.cfg || S.readConfig();
    const m = mode(cfg);
    if (m === 'off') return '';
    const now = Number(o.now) || Date.now();
    const total = Math.max(0, Number(o.prepMs || 0) + Number(o.startMs || 0));
    const key = hash(S.normKey(o.root || '')) + '|devserver-' + (o.kind || 'first') + '|' + signature(o.command);
    const facts = parseLog(o.log);
    const free = Number(o.freemem) > 0 ? Number(o.freemem) : os.freemem();
    const lowMem = free < 1.5 * 1024 * 1024 * 1024;
    const reason = facts.downloads >= 5 ? '依赖或网络' : lowMem ? '内存' : '';
    const cold = (Number(o.uptimeSec) > 0 ? Number(o.uptimeSec) : os.uptime()) < 600;
    let base = 0; let n = 0; let recent = [];
    S.updateState(BASE, (s) => {
      const r = s[key] || (s[key] = { samples: [], reasons: [] });
      base = r.samples.length ? median(r.samples) : 0; n = r.samples.length;
      if (!cold && !reason) { r.samples.push(total); r.samples = r.samples.slice(-KEEP); }
      r.reasons = (r.reasons || []).concat([reason || '-']).slice(-5); recent = r.reasons;
      r.at = now;
    });
    // 开机不到 10 分钟：磁盘、杀毒都在忙，不进基线，也不拿来比（复审 D-R12）
    const prepSlow = !cold && Number(o.prepMs || 0) > 20000;
    const slow = prepSlow || (!cold && n >= 3 && total >= 2 * base && total - base >= 60000);
    const remote = recent.filter((x) => x === '依赖或网络').length >= 3;
    if (!slow && !remote) return '';
    const part = prepSlow ? '准备' : '启动';
    const head = '耗时：这次 ' + sec(total) + ' 秒' + (n >= 3 ? '，平时 ' + sec(base) + ' 秒' : '') + (prepSlow ? '（devserver 自己的检查用了 ' + sec(o.prepMs) + ' 秒）' : '');
    try { require('./usage').bump('perf.slow.devserver'); if (reason) require('./usage').bump('perf.env.' + (reason === '内存' ? 'memory' : 'network')); } catch (e) { /* 数不了就算了 */ }
    // 依赖或网络、内存：只记本机（除非每次都在查远端）
    if ((reason && !remote) || m === 'local') return head + (reason ? '，多半是' + reason + '（下载了 ' + facts.downloads + ' 条' + (lowMem ? '，空闲内存 ' + (free / 1073741824).toFixed(1) + ' GB' : '') + '），只记在本机' : '，只记在本机') + '，不用处理。';
    // 上报：每台电脑每天最多 3 条，同一个键 24 小时内一次
    let allowed = false;
    S.updateState(DAILY, (s) => {
      const day = new Date(now).toISOString().slice(0, 10);
      if (s.day !== day) { s.day = day; s.count = 0; }
      s.keys = s.keys || {};
      if ((s.count || 0) >= 3 || (s.keys[key] && now - s.keys[key] < 86400000)) return;
      s.count = (s.count || 0) + 1; s.keys[key] = now; allowed = true;
    });
    if (!allowed) return head + '，今天已经记过，不用处理。';
    const why = remote ? '每次都在查远端' : prepSlow ? 'devserver 自己的检查慢' : '启动比平时慢';
    const table = ['| 段 | 这次 | 平时 |', '|---|---|---|', '| 准备（devserver 的检查） | ' + sec(o.prepMs || 0) + ' 秒 | — |', '| 启动（命令开始到答 HTTP） | ' + sec(o.startMs || 0) + ' 秒 | ' + (n >= 3 ? sec(base) + ' 秒（合计）' : '样本不够') + ' |'];
    const env = '空闲内存 ' + (free / 1073741824).toFixed(1) + ' / ' + (os.totalmem() / 1073741824).toFixed(1) + ' GB，CPU ' + os.cpus().length + ' 核，开机 ' + Math.round(os.uptime() / 60) + ' 分钟；日志里下载 ' + facts.downloads + ' 条、编译 ' + facts.compiled + ' 个文件' + (facts.appSec ? '、框架自报启动 ' + facts.appSec + ' 秒' : '');
    const fb = require('./feedback');
    const r = fb.record({
      kind: '耗时', hook: 'devserver', source: '耗时自动记录', cwd: '', bare: true,
      title: (slow ? '起服务慢在' + part : '起服务每次都在查远端（依赖、私服）') + '：' + sec(total) + ' 秒' + (n >= 3 ? '，平时 ' + sec(base) + ' 秒' : ''),
      what: '种类：' + (o.kind === 'restart' ? '改了代码重启' : '首次起') + '；命令签名：' + signature(o.command) + '\n' + table.join('\n') + '\n环境：' + env + '\n原因：' + why,
      sig: 'perf|devserver-' + (o.kind || 'first') + '|' + part + '|' + why,
      note: sec(total) + ' 秒' + (n >= 3 ? '，平时 ' + sec(base) + ' 秒' : ''),
    });
    return head + '，慢在' + part + '；已记 ' + r.id + '，不用处理。';
  } catch (e) { return ''; }
}
module.exports = { signature, parseLog, noteStart, mode };
