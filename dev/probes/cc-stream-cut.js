'use strict';
/*
 * 探测：流式回复传到一半出了事，Claude Code 怎么办——会不会重试、隔多久、报什么、半截的文字留不留（E3，2026-11-01）。
 * 链路：claude -p → 本机临时端口上的路由（套件的 router.js，拷进假用户目录，-c 临时配置、-p 临时端口）→ 本机假网关。
 * 假网关对第一个主请求按剧本出事，之后的照常回完整的。每个剧本单独起一份路由、单独跑一次 claude -p：
 *   ok           对照：完整回复
 *   clean-cut    发了 message_start 和两段文字，HTTP 正常收尾，没有 message_stop（网关自己把流收了）
 *   clean-block  一整段文字发完（content_block_stop），HTTP 正常收尾，没有 message_delta、message_stop
 *   error-api    发了两段文字，再发 event: error（api_error），HTTP 正常收尾
 *   error-over   同上，错误类型是 overloaded_error
 *   reset        发了两段文字，直接断开连接（没有 HTTP 的结束块）
 *   error-api-block、error-over-block、reset-block   和上面三个一样，只是出事前那一整段文字已经发完（content_block_stop）
 *   stop-reset   整个回复都发完了（有 message_stop），然后直接断开连接
 * 剧本 error-*、reset* 经过路由是原样转的（路由转出 error 事件、断开连接），等于"路由发 error 事件再结束""路由直接断开"两种做法；
 * clean-cut、clean-block 看的是路由自己怎么收尾（20261031.1436 照常结束；E3 改了之后见 docs/claude-code-facts.md）。
 * 看：主请求一共几次、隔多久、是不是改成不走流式再发，退出码，结果里的 is_error、subtype 和文字，stderr，路由的日志。
 * 用法：node dev/probes/cc-stream-cut.js <版本号 | claude.exe> [路由目录，默认源码的 vibe-kit/router] [剧本，逗号隔开]
 * 和别的探测一样：家目录、APPDATA 指假的，key 是假的，只连本机的假网关。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { H, exeOf, brief, isMain, reply, fakeGateway, runPrint, textOf } = require('./common');

const EXE = exeOf(process.argv[2]);
const ROUTER_DIR = process.argv[3] && process.argv[3] !== '-' ? path.resolve(process.argv[3]) : path.join(H.SRC, 'router');
const ALL = ['ok', 'clean-cut', 'clean-block', 'error-api', 'error-over', 'reset', 'error-api-block', 'error-over-block', 'reset-block', 'stop-reset'];
const PLAYS = process.argv[4] ? process.argv[4].split(',').filter((p) => ALL.includes(p)) : ALL;
const FAKE_KEY = 'probe-fake-key-0001';

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const getStatus = (port, url) => new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: url, timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('timeout', () => r.destroy()); r.on('error', () => resolve(0)); });

/** 第一个主请求：按剧本发半截 */
function broken(body, res, play) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (e) => res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  const usage = { input_tokens: 3000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  send({ type: 'message_start', message: { id: 'msg_cut_' + crypto.randomBytes(4).toString('hex'), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HALF-ONE，' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HALF-TWO' } });
  // -block 结尾的：一整段文字发完（content_block_stop）之后才出事；stop-reset：整个回复发完（message_stop）之后才断开
  if (/-block$/.test(play) || play === 'stop-reset') send({ type: 'content_block_stop', index: 0 });
  if (play === 'stop-reset') { send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }); send({ type: 'message_stop' }); return setTimeout(() => res.socket.destroy(), 300); }
  const how = play.replace(/-block$/, '');
  setTimeout(() => {
    if (how === 'clean' || how === 'clean-cut') return res.end();
    if (how === 'error-api' || how === 'error-over') {
      const type = how === 'error-api' ? 'api_error' : 'overloaded_error';
      res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type, message: 'probe: upstream cut (' + type + ')' } }) + '\n\n');
      return res.end();
    }
    if (how === 'reset') return res.socket.destroy();
    res.end();
  }, 300);
}

async function runPlay(h, proj, play) {
  const mains = [];
  const others = [];
  const t0 = Date.now();
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) { others.push((body.model || '') + (body.stream ? ' 流式' : ' 不流式')); return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn'); }
    const n = mains.length + 1;
    const msgs = body.messages || [];
    // 每条消息：角色 + 开头几个字（看半截的回复有没有被当成一轮放进历史、后面跟了什么）
    const shape = msgs.map((m) => m.role + ':' + brief(textOf(m).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() || (Array.isArray(m.content) ? m.content.map((c) => c.type).join('+') : ''), 40));
    mains.push({ n, at: Date.now() - t0, stream: !!body.stream, msgs: msgs.length, shape });
    if (n === 1 && play !== 'ok') return broken(body, res, play);
    return reply(body, res, { type: 'text', text: 'FULL-REPLY-' + n }, 'end_turn');
  }, (req) => others.push(req.method + ' ' + req.url));
  const rport = await freePort();
  const dir = path.join(h.root, 'router-data-' + play);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port: rport }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:' + gw.port, api_key: FAKE_KEY }], routes: [], default: { provider: 'gw' }, failover: [], options: { firstByteTimeoutSec: 60 } }, null, 2));
  const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', cfg, '-p', String(rport)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let rlog = '';
  router.stdout.on('data', (d) => { rlog += d; });
  router.stderr.on('data', (d) => { rlog += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await H.sleep(150); up = (await getStatus(rport, '/version')) === 200; }
  let r = null;
  try {
    if (!up) { console.log('[' + play + '] 路由没起来：' + brief(rlog, 400)); return; }
    // 不发遥测、错误报告（只连本机）；重试相关的行为不受它影响
    r = await runPrint(EXE, h, proj, rport, '用一句话打个招呼', [], { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, 180);
  } finally {
    try { router.kill(); } catch (e) { /* 已经退了 */ }
    gw.close();
  }
  const j = r.json || {};
  console.log('\n----- 剧本 ' + play + ' -----');
  console.log('退出码 ' + r.code + (r.killed ? '（180 秒没结束，被结束）' : '') + '，用了 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  console.log('主请求 ' + mains.length + ' 次：' + mains.map((m) => '#' + m.n + ' ' + (m.at / 1000).toFixed(1) + 's ' + (m.stream ? '流式' : '不流式') + ' 消息' + m.msgs + '条').join('；'));
  for (const m of mains) console.log('    #' + m.n + ' 的消息：' + m.shape.join(' | '));
  if (others.length) console.log('别的请求：' + others.join('；'));
  console.log('结果：is_error=' + j.is_error + ' subtype=' + j.subtype + ' 文字="' + brief(j.result, 200) + '"');
  if (!r.json) console.log('标准输出（不是 JSON）：' + brief(r.out, 400));
  if (r.err.trim()) console.log('stderr：' + brief(r.err, 600));
  const lines = rlog.split(/\r?\n/).filter((l) => /->|失败|断|message_stop|流里/.test(l)).map((l) => '    | ' + brief(l.replace(/^\[[^\]]*\]\s*/, ''), 220));
  if (lines.length) console.log('路由日志：\n' + lines.join('\n'));
}

(async () => {
  const watch = await H.watchWindows('pcut-win');
  const h = H.makeHome('pcut', null);
  // 路由拷进假用户目录：它按自己的位置找套件目录（state、lib/redact.js），不碰源码目录
  fs.rmSync(path.join(h.kit, 'router'), { recursive: true, force: true });
  H.copyDir(ROUTER_DIR, path.join(h.kit, 'router'));
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'README.md': '# x\n' });
  console.log('===== ' + EXE + ' =====');
  console.log('路由：' + ROUTER_DIR);
  for (const play of PLAYS) await runPlay(h, proj, play);
  const wins = await watch.stop();
  console.log('\n探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：流式回复断在半截');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
