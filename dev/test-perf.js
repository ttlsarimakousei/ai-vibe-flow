'use strict';
/*
 * 耗时异常自动发现、上报（问题表第 20 条、审核 M04，2026-10-30 定的；docs/feedback-20261030.md C7）。
 * 只测 lib/perf.js 的判定（devserver 起服务时调它）：签名不带路径和参数值；样本够了、慢到 2 倍且多 60 秒才算慢；
 * 依赖或网络、内存只记本机；开关 local 不上报、off 不记；同一个键 24 小时一次、每天最多 3 条；记下的反馈里没有项目路径、命令参数。
 * 用法：node dev/test-perf.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;

H.section('C7 耗时：签名、日志、判定、上报和防刷屏');
{
  const h = H.makeHome('tpf', FROM, { perfReport: 'on' });
  const file = path.join(h.kit, 'lib', 'perf.js');
  if (!fs.existsSync(file)) H.ok('有 lib/perf.js', false, '旧版没有');
  else {
    const P = require(file);
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const sig = P.signature('mvn -o spring-boot:run -Dmaven.test.skip=true -pl app-secret -am -Dspring.profiles.active=dev');
    H.ok('命令签名：工具、目标、-o、跳测试、-pl、-am；不带模块名和参数值', sig === 'mvn spring-boot:run o skiptest pl am', sig);
    const log = '[INFO] Downloading from nexus: a\n[INFO] Downloading from nexus: b\n[INFO] Compiling 212 source files\nStarted DemoApplication in 12.3 seconds\n';
    const f = P.parseLog(log);
    H.ok('日志：下载 2 条、编译 212 个文件、框架自报 12 秒', f.downloads === 2 && f.compiled === 212 && f.appSec === 12, f);
    const root = path.join(h.work, 'proj-secret');
    const cmd = 'mvn spring-boot:run -pl app-secret';
    const one = (ms, extra) => P.noteStart(Object.assign({ kind: 'first', root, command: cmd, prepMs: 2000, startMs: ms, log: 'Started X in 10 seconds', cfg: S.readConfig(), freemem: 8e9 }, extra || {}));
    const a = [one(60000), one(62000), one(58000)];
    H.ok('样本不够 3 次：不说什么', a.every((x) => x === ''), a);
    const fb = () => (fs.existsSync(path.join(h.kit, 'feedback')) ? fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /\.md$/.test(n)) : []);
    H.ok('不慢（70 秒，平时 60 秒）：不说什么', one(68000) === '');
    const slow = one(200000);
    H.ok('慢（202 秒，平时 62 秒左右）：结果行前说一句，记了反馈', /耗时：这次 202 秒，平时 \d+ 秒，慢在启动；已记 F/.test(slow) && fb().length === 1, slow);
    const rec = fb().map((n) => H.read(path.join(h.kit, 'feedback', n))).join('\n');
    H.ok('反馈：类型耗时、来源耗时自动记录；没有项目路径、模块名', /类型: 耗时/.test(rec) && /来源: 耗时自动记录/.test(rec) && !rec.includes('proj-secret') && !rec.includes('app-secret'), rec.slice(0, 600));
    H.ok('同一个键 24 小时内再慢：不再记', /今天已经记过/.test(one(210000)) && fb().length === 1);
    const net = P.noteStart({ kind: 'restart', root, command: cmd, prepMs: 1000, startMs: 300000, log: Array(6).fill('[INFO] Downloading from nexus: x').join('\n'), cfg: S.readConfig(), freemem: 8e9 });
    H.ok('下载了 6 条：算依赖或网络，只记本机（样本不够时不说）', net === '' && fb().length === 1, net);
    const prep = P.noteStart({ kind: 'first', root: path.join(h.work, 'p2'), command: 'npm run dev', prepMs: 25000, startMs: 3000, log: '', cfg: S.readConfig(), freemem: 8e9 });
    H.ok('devserver 自己的检查超过 20 秒：直接算慢、记一条', /慢在准备/.test(prep) && fb().length === 2, prep);
    H.setConfig(h, { perfReport: 'local' });
    const loc = P.noteStart({ kind: 'first', root: path.join(h.work, 'p3'), command: 'npm run dev', prepMs: 25000, startMs: 3000, log: '', cfg: S.readConfig(), freemem: 8e9 });
    H.ok('开关"只记本机"：说一句、不记反馈', /只记在本机/.test(loc) && fb().length === 2, loc);
    H.setConfig(h, { perfReport: 'off' });
    H.ok('开关"关"：什么都不说', P.noteStart({ kind: 'first', root: path.join(h.work, 'p4'), command: 'npm run dev', prepMs: 25000, startMs: 3000, log: '', cfg: S.readConfig(), freemem: 8e9 }) === '');
    H.setConfig(h, { perfReport: 'on' });
    P.noteStart({ kind: 'restart', root: path.join(h.work, 'p5'), command: 'npm run dev', prepMs: 25000, startMs: 3000, log: '', cfg: S.readConfig(), freemem: 8e9 });
    const fourth = P.noteStart({ kind: 'first', root: path.join(h.work, 'p6'), command: 'npm run dev', prepMs: 25000, startMs: 3000, log: '', cfg: S.readConfig(), freemem: 8e9 });
    H.ok('每台电脑每天最多 3 条（同一类慢并成一条）：第 4 条不记', fb().length === 3 && /今天已经记过/.test(fourth), [fb().length, fourth]);
    // 基线文件写坏了：照样放行，不抛错
    H.write(path.join(h.kit, 'state', 'perf-baseline.json'), '{坏了');
    let threw = false; try { P.noteStart({ kind: 'first', root, command: cmd, prepMs: 1, startMs: 1, log: '', cfg: S.readConfig(), freemem: 8e9 }); } catch (e) { threw = true; }
    H.ok('基线文件写坏了：不抛错', !threw);
  }
}

H.done('耗时异常自动上报（C7）');
