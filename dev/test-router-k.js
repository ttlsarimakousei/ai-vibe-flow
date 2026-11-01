'use strict';
/*
 * 11-01 这一批里路由的几项（docs/feedback-20261101.md）：
 *   K1-1 路由拆成几个文件：router.js 留入口，引到的文件都在、都在打包的必备清单里，入口里还认得钩子请求
 *   E1   远程桌面多人共用一台电脑：/version 带本安装的标识，service.js 认出别的安装的路由，不停、不当成自己的、说清端口被占；
 *        老版本的路由（不带标识）照以前的规矩处理，新旧 service.js 和新旧路由互相停得掉、起得来
 *   E3   网关在流式回复传到一半时出事：没收到 message_stop 的一律断开客户端的连接（Claude Code 才知道没成），收到了的照常结束
 * 用法：node dev/test-router-k.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 * 只起本机的假网关、临时端口上的路由，key 是假的；家目录、APPDATA、"启动"文件夹都指假的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? path.resolve(process.argv[2]) : null;
const SRCV = FROM || H.SRC;
// 拆分、E1 之前的那一版：兼容的几项拿它当"老版本"
const OLD = path.join(__dirname, 'baseline', '20261031.1436', 'vibe-kit');

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function getJson(port, url) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: url, timeout: 2000, agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, json: null, text: '' }));
  });
}
/** 一份装了路由的假用户目录：套件、路由程序（从 from 拷）、路由的配置（端口 port，没有模型） */
function install(tag, from, port) {
  const h = H.makeHome(tag, FROM);
  H.copyDir(path.join(from, 'router'), path.join(h.kit, 'router'));
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
  return h;
}
/** 换掉路由程序目录（装新版、装回老版本时 install.js 就是整个换） */
function swapRouter(h, from) {
  fs.rmSync(path.join(h.kit, 'router'), { recursive: true, force: true });
  H.copyDir(path.join(from, 'router'), path.join(h.kit, 'router'));
}
const svc = (h, cmd) => H.node(h, path.join(h.kit, 'router', 'service.js'), [cmd], { cwd: h.root, timeout: 60000 });

(async () => {
  H.section('K1-1 路由拆成几个文件：引到的文件都在、都在打包的必备清单里，入口还是 router.js');
  {
    const dir = path.join(SRCV, 'router');
    const pack = H.read(path.join(H.REPO, 'dev', 'pack.js')) || '';
    const local = new Set();
    const walk = (f) => { for (const m of (H.read(path.join(dir, f)) || '').matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) { const n = m[1] + '.js'; if (!local.has(n)) { local.add(n); walk(n); } } };
    walk('router.js');
    walk('service.js');
    // 配置页里套件那几页的后端：没有它路由也能单独用（try 着载），不算必备
    local.delete('kit-api.js');
    H.ok('router.js、service.js 引到的文件都在', [...local].every((n) => fs.existsSync(path.join(dir, n))), [...local]);
    H.ok('都在 dev/pack.js 的必备清单里（漏打进包路由就起不来）', [...local].every((n) => pack.includes("'router/" + n + "'")), [...local].filter((n) => !pack.includes("'router/" + n + "'")));
    // install.js 按 router.js 里有没有 /vibe-kit/hook/ 判断这个路由认不认得钩子请求（--no-router 时留着的可能是老版本）
    H.ok('入口 router.js 里还有钩子入口的路径（安装器靠它判断能不能走 HTTP 钩子）', (H.read(path.join(dir, 'router.js')) || '').includes('/vibe-kit/hook/'));
  }

  H.section('E1 远程桌面多人共用一台电脑：端口上是别的安装的路由，不停它、不当成自己的，说清端口被占');
  {
    const port = await freePort();
    const A = install('trk-e1a', SRCV, port);
    const B = install('trk-e1b', SRCV, port);
    try {
      const a1 = svc(A, 'start');
      H.ok('（甲的路由起来了）', a1.code === 0, a1.out + a1.err);
      const v1 = await getJson(port, '/version');
      const id = v1.json && v1.json.install;
      H.ok('/version 带着这份安装的标识（16 位十六进制）', typeof id === 'string' && /^[0-9a-f]{16}$/.test(id), v1.text);
      const user = String((os.userInfo() || {}).username || '').toLowerCase();
      H.ok('/version 里没有用户名、路径原文', !!v1.text && !/vkt-|home|users|\\|\//i.test(v1.text) && !(user.length > 2 && v1.text.toLowerCase().includes(user)), v1.text);
      const b1 = svc(B, 'stop');
      const v2 = await getJson(port, '/version');
      H.ok('乙停路由：甲的路由照常在跑（没被停掉）', v2.status === 200 && !!v2.json && v2.json.install === id, [b1.out, v2.status]);
      H.ok('乙停路由：说清端口被另一个安装的路由占着、没有停它', b1.code === 0 && new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b1.out), [b1.code, b1.out]);
      const b2 = svc(B, 'start');
      H.ok('乙起路由：不当成自己的"本来就在运行"，退出码 1、说清端口被占', b2.code === 1 && new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b2.out), [b2.code, b2.out]);
      const b3 = svc(B, 'status');
      H.ok('乙看状态：说端口被另一个安装的路由占着', new RegExp('端口 ' + port + ' 被另一个安装的路由占着').test(b3.out), b3.out);
      const v3 = await getJson(port, '/version');
      H.ok('乙这几下之后甲的路由还是原来那个', v3.status === 200 && !!v3.json && !!id && v3.json.install === id, v3.text);
      const a2 = svc(A, 'stop');
      const v4 = await getJson(port, '/version');
      H.ok('甲自己停：停得掉', a2.code === 0 && /已停止/.test(a2.out) && v4.status === 0, [a2.out, v4.status]);
    } finally { svc(A, 'stop'); svc(B, 'stop'); }
  }

  H.section('E1 兼容：老版本的路由不带标识，照以前的规矩当成自己的（自动更新时新版的 service.js 要停得掉它）');
  {
    const port = await freePort();
    const C = install('trk-e1c', OLD, port);
    try {
      const s = svc(C, 'start');
      H.ok('（老版本的路由起来了）', s.code === 0, s.out + s.err);
      swapRouter(C, SRCV);
      const st = svc(C, 'stop');
      const v = await getJson(port, '/version');
      H.ok('新版的 service.js 停得掉老版本的路由', st.code === 0 && /已停止/.test(st.out) && v.status === 0, [st.out, v.status]);
    } finally { svc(C, 'stop'); }
  }

  H.section('E1 兼容：装回老版本时老的 service.js 停得掉新路由；老的 service.js 起新的 router.js 也认（入口、参数没变）');
  {
    const port = await freePort();
    const D = install('trk-e1d', SRCV, port);
    try {
      const s = svc(D, 'start');
      H.ok('（新路由起来了）', s.code === 0, s.out + s.err);
      swapRouter(D, OLD);
      const st = svc(D, 'stop');
      const v = await getJson(port, '/version');
      H.ok('老版本的 service.js 停得掉新路由', st.code === 0 && /已停止/.test(st.out) && v.status === 0, [st.out, v.status]);
      // 程序目录是新的，只有 service.js 是老的：自动更新之后还在跑的老进程、老的自启动脚本拉起新路由就是这样
      swapRouter(D, SRCV);
      fs.copyFileSync(path.join(OLD, 'router', 'service.js'), path.join(D.kit, 'router', 'service.js'));
      const s2 = svc(D, 'start');
      const v2 = await getJson(port, '/version');
      H.ok('老的 service.js 起新的 router.js：起得来、认得出', s2.code === 0 && /已在后台启动/.test(s2.out) && v2.status === 200, [s2.out, v2.text]);
      const st2 = svc(D, 'stop');
      H.ok('老的 service.js 再停掉它', st2.code === 0 && /已停止/.test(st2.out), st2.out);
    } finally { svc(D, 'stop'); }
  }

  // E3 的做法照真 Claude Code 探出来的（dev/probes/cc-stream-cut.js，docs/claude-code-facts.md"流式回复断在半截"）：
  // 没有 message_stop 就收尾，照常结束的话 2.1.120、2.1.259 会把一段发完之后的半截当成回完了；断开连接三个版本都知道没成（重发、接着写或报错）。
  // 已经有 message_stop 之后上游才断开，路由也断开的话 2.1.120 会报错停下（回复其实是全的），所以照常结束
  H.section('E3 网关在流式回复传到一半时出事：没收到 message_stop 的一律断开客户端的连接；收到了的照常结束');
  {
    // 假网关按请求里的模型名演一出：claude-e3-<剧本>
    const send = (res, e) => res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    const head = (res, body) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send(res, { type: 'message_start', message: { id: 'msg_e3', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
      send(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HALF-ONE' } });
    };
    const tail = (res) => { send(res, { type: 'content_block_stop', index: 0 }); send(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }); send(res, { type: 'message_stop' }); };
    const plays = {
      // 网关自己把流收了尾（HTTP 正常结束），没有 message_stop
      'clean-cut': (res) => res.end(),
      // 网关直接断开连接（没有 HTTP 的结束块）
      reset: (res) => setTimeout(() => res.socket.destroy(), 100),
      // 一整段文字发完（content_block_stop）才收尾，没有 message_delta、message_stop：2.1.120、2.1.259 会把它当成回完了的那种
      'clean-block': (res) => { send(res, { type: 'content_block_stop', index: 0 }); res.end(); },
      // 最后半个事件没发完（没有空行）就收尾
      'half-frame': (res) => res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"HALF-FRAG'),
      // 已经发完 message_stop 才断开：回复是全的，照常结束
      'stop-reset': (res) => { tail(res); setTimeout(() => res.socket.destroy(), 100); },
      // 对照：完整的回复
      complete: (res) => { tail(res); res.end(); },
      // 对照：网关自己在流里报错（api_error）：原样转、照常结束，Claude Code 自己处理这个错
      'upstream-error': (res) => { res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'gateway said no' } }) + '\n\n'); res.end(); },
    };
    const gw = http.createServer((q, s) => { const c = []; q.on('data', (d) => c.push(d)); q.on('end', () => { let body = {}; try { body = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) { /* 不是 JSON */ } const play = plays[String(body.model || '').replace(/^claude-e3-/, '')]; if (!play) { s.writeHead(404); return s.end(); } head(s, body); play(s); }); });
    const gwPort = await new Promise((r) => gw.listen(0, '127.0.0.1', () => r(gw.address().port)));
    const port = await freePort();
    const h = H.makeHome('trk-e3', FROM);
    H.copyDir(path.join(SRCV, 'router'), path.join(h.kit, 'router'));
    const cfg = path.join(h.root, 'router-data', 'config.json');
    H.write(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:' + gwPort, api_key: 'sk-test-e3-0123456789abcdef' }], routes: [], default: { provider: 'gw' }, failover: [], options: { firstByteTimeoutSec: 30, rateLimitWaitSec: 0 } }, null, 2));
    const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', cfg, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { await H.sleep(200); up = (await getJson(port, '/version')).status === 200; }
      H.ok('（临时路由起来了）', up);
      /** 像 Claude Code 那样发一个流式请求，收全部字节；ended：HTTP 正常收尾（不是被断开） */
      const ask = (play) => new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify({ model: 'claude-e3-' + play, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'ping' }] }));
        const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', agent: false, timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': data.length, 'anthropic-version': '2023-06-01', authorization: 'Bearer claude-code-placeholder', 'x-stainless-timeout': '600' } }, (res) => {
          const chunks = []; let ended = false;
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { ended = res.complete; });
          res.on('error', () => { /* 被断开 */ });
          res.on('close', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const frames = text.split(/\r?\n\r?\n/).filter((f) => f.trim());
            const parsed = frames.map((f) => { const ev = (/^event:\s*(.*)$/m.exec(f) || [])[1] || ''; let d = null; try { d = JSON.parse(f.split(/\r?\n/).filter((l) => /^data:/.test(l)).map((l) => l.slice(5).trim()).join('\n')); } catch (e) { d = null; } return { ev, d }; });
            resolve({ status: res.statusCode, text, ended, frames: parsed, last: parsed[parsed.length - 1] || { ev: '', d: null } });
          });
        });
        q.on('timeout', () => q.destroy(new Error('timeout')));
        q.on('error', (e) => resolve({ status: 0, text: String(e), ended: false, frames: [], last: { ev: '', d: null } }));
        q.end(data);
      });
      // 被断开：HTTP 没有正常收尾（Claude Code 那边是"连接断了"，会重发或接着写）
      const cut = (r) => r.status === 200 && !r.ended && r.text.includes('HALF-ONE') && !/message_stop/.test(r.text);
      const view = (r) => ({ status: r.status, ended: r.ended, frames: r.frames.map((f) => f.ev + (f.d ? '' : '（解析不了）')) });
      const a = await ask('clean-cut');
      H.ok('网关收了尾却没发 message_stop：断开客户端的连接（以前照常结束，像是回完了）', cut(a), view(a));
      const a2 = await ask('clean-block');
      H.ok('一整段发完才收尾、没有 message_stop：同样断开（以前照常结束，2.1.120、2.1.259 把半截当成回完了）', cut(a2) && a2.frames.some((f) => f.ev === 'content_block_stop'), view(a2));
      const c = await ask('half-frame');
      H.ok('最后半个事件没发完就收尾：同样断开', cut(c), view(c));
      const b = await ask('reset');
      H.ok('网关直接断开：照旧把客户端的连接也断开', cut(b), view(b));
      const d = await ask('stop-reset');
      H.ok('已经发完 message_stop 才断开：回复是全的，照常结束（以前也断开，2.1.120 报错停下）', d.ended && d.last.ev === 'message_stop' && d.frames.every((f) => f.ev !== 'error' && f.d), view(d));
      const e = await ask('complete');
      H.ok('对照：完整的回复原样转、照常结束', e.ended && e.last.ev === 'message_stop' && e.frames.every((f) => f.ev !== 'error'), view(e));
      const f = await ask('upstream-error');
      H.ok('对照：网关自己在流里报的错原样转、照常结束', f.ended && f.frames.filter((x) => x.ev === 'error').length === 1 && f.last.d && f.last.d.error && f.last.d.error.type === 'api_error', view(f));
      await H.sleep(300);
      const usage = await new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: '/api/usage', agent: false, headers: { 'x-vibe-router': '1' } }, (res) => { let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (err) { resolve({}); } }); }); r.on('error', () => resolve({})); });
      const recent = (usage.recent || []).filter((x) => /^claude-e3-/.test(x.model));
      const failed = (m) => { const x = recent.find((y) => y.model === 'claude-e3-' + m); return !!x && x.failed === true && /传输中断/.test(x.error || ''); };
      H.ok('用量里半截的几次都记成没成（传输中断），收全了的（含发完才断开的）记成成了', ['clean-cut', 'clean-block', 'half-frame', 'reset'].every(failed) && recent.some((x) => x.model === 'claude-e3-stop-reset' && !x.failed) && recent.some((x) => x.model === 'claude-e3-complete' && !x.failed), recent.map((x) => [x.model, x.failed, x.error]));
    } finally {
      try { router.kill(); } catch (e) { /* 已经退了 */ }
      gw.close();
    }
  }

  H.done('11-01 路由（K1-1 拆分、E1 安装标识、E3 断在半截）');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
