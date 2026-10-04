'use strict';
/*
 * 探测：钩子走 HTTP（在路由里跑）时照不照常。套件带路由装进假用户目录（路由端口换成测试用的），假模型按剧本：
 * 跑一条普通命令、git push（该要确认，-p 下就是不让跑）、新建一个说明文件（该被 pre-edit 里的产出位置检查拦下）、收工（verify-gate）。
 * 看：工具结果里有没有套件的提示、路由的 hook-stats.json 里这几个钩子有没有被调到。
 * 用法：node dev/probes/cc-http-hooks.js <版本号 | claude.exe> [路由端口，默认 18797]
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, brief, isMain, reply, fakeGateway, runPrint } = require('./common');

const EXE = exeOf(process.argv[2]);
const PORT = Number(process.argv[3]) || 18797;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  const watch = await H.watchWindows('phh-win');
  let mainSeq = 0; let steps = []; let results = []; const log = [];
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) { log.push('别(' + body.model + ')'); return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn'); }
    log.push('主');
    results = [];
    for (const m of body.messages || []) if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_result') results.push((c.is_error ? '没成 ' : '成了 ') + brief(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 150));
    const step = steps[mainSeq++];
    if (step) return reply(body, res, { type: 'tool_use', id: 'toolu_h_' + mainSeq, name: step.name, input: step.input }, 'tool_use');
    return reply(body, res, { type: 'text', text: '做完了。' }, 'end_turn');
  });
  const h = H.freshHome('phh');
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-open'], { cwd: h.root, timeout: 300000 });
  const svc = path.join(h.kit, 'router', 'service.js');
  try {
    const st = readJson(path.join(h.cfg, 'settings.json'));
    const kinds = [];
    for (const ev of Object.keys(st.hooks || {})) for (const g of st.hooks[ev]) for (const x of g.hooks || []) kinds.push(ev + (g.matcher ? '(' + g.matcher + ')' : '') + '=' + x.type);
    console.log('===== ' + EXE + ' =====');
    console.log('安装：退出码 ' + inst.code + '；路由' + (/已在后台运行/.test(inst.out) ? '起来了' : '没起来：' + inst.out.slice(-300)));
    console.log('登记的钩子：' + kinds.join('，'));
    const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
    const p = proj.split(path.sep).join('/');
    steps = [
      { name: 'Bash', input: { command: 'echo step-ok', description: '打印' } },
      { name: 'Bash', input: { command: 'git -C "' + p + '" push origin main', description: '推送' } },
      { name: 'Write', input: { file_path: p + '/导出功能说明.md', content: '# 说明\n' } },
    ];
    const r = await runPrint(EXE, h, proj, gw.port, '照我说的一步一步做', [], {}, 150);
    console.log('退出码 ' + r.code + (r.killed ? '（超时被结束）' : '') + '；请求顺序：' + log.join(' → '));
    console.log('三步的结果：\n' + results.map((s, i) => '  ' + (i + 1) + '. ' + s).join('\n'));
    await H.sleep(6000);   // 路由隔几秒才把调用记录写盘
    const stats = readJson(path.join(h.kit, 'state', 'hook-stats.json'));
    console.log('路由记下的钩子调用：' + JSON.stringify(Object.fromEntries(Object.entries(stats.byHook || {}).map(([k, v]) => [k, { 次数: v.n, 拦下: v.blocked, 出错: v.errors, 毫秒: v.ms }]))) + '；会话数 ' + Object.keys(stats.sessions || {}).length);
    if (r.err.trim()) console.log('stderr：' + brief(r.err, 400));
  } finally {
    const stop = H.node(h, svc, ['stop'], { cwd: h.root, timeout: 60000 });
    console.log('路由停掉：退出码 ' + stop.code);
    gw.close();
  }
  const wins = await watch.stop();
  console.log('探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：HTTP 钩子');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
