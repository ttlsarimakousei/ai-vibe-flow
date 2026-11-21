'use strict';
/*
 * 探测（全量审核 A3，2026-11-21，仓库主人选的"先实测再定"）：Read 工具没有钩子，读令牌只靠安装器写进 settings.json 的
 * Read(~/.claude/vibe-kit/secrets.json)、Read(~/.claude/vibe-kit/router-data/**) 按路径挡。换几种路径写法，看挡不挡得住：
 *   正常写法、正斜杠、大小写不同、相对路径、~ 开头、8.3 短名、目录联接（mklink /J，不要管理员）、\\?\ 前缀、\\localhost\C$ 管理共享
 * 每种写法同时读一个不在拒读规则里的文件（同目录的 config.json）作对照：对照能读、令牌读不到，才算规则挡住的；
 * 两个都读不到，说明是别的原因（工作目录之外、文件不在），不算。
 * 不装套件、不连真网关：假用户目录 + 假网关按剧本发 Read，看工具结果里有没有记号。
 * 用法：node dev/probes/cc-read-deny.js <版本号 | claude.exe> [--bypass]（--bypass：带 --dangerously-skip-permissions 跑，看拒读规则在跳过权限时还管不管）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { H, exeOf, brief, isMain, reply, fakeGateway, runPrint, textOf } = require('./common');

const EXE = exeOf(process.argv[2]);
const BYPASS = process.argv.includes('--bypass');
const SECRET = 'PROBE-SECRET-7f3a';
const PLAIN = 'PROBE-PLAIN-9c1d';

/** cmd 的 for %I 取 8.3 短名；这个盘没开短名就原样返回 */
function shortOf(p) {
  // 原样交给 cmd（不让 Node 给引号加反斜杠），不然 %~sI 拿到的是带引号的整串
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d /s /c "for %I in ("' + p + '") do @echo %~sI"'], { encoding: 'utf8', windowsHide: true, timeout: 10000, windowsVerbatimArguments: true });
  const s = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
  return /^[A-Za-z]:\\/.test(s) ? s : p;
}

(async () => {
  const h = H.freshHome('crd');
  const kit = path.join(h.cfg, 'vibe-kit');
  fs.mkdirSync(path.join(kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'secrets.json'), JSON.stringify({ token: SECRET }));
  fs.writeFileSync(path.join(kit, 'router-data', 'config.json'), JSON.stringify({ key: SECRET }));
  fs.writeFileSync(path.join(kit, 'config.json'), JSON.stringify({ note: PLAIN }));
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'README.md': '# x\n' });
  // 规则和 install.js 的 secretDenyRules 一样：套件在用户目录下面，写成 ~/…
  const deny = ['Read(~/.claude/vibe-kit/secrets.json)', 'Read(~/.claude/vibe-kit/router-data/**)'];
  // 假用户目录、联接所在的目录都算工作目录：对照文件不会因为"在工作目录之外"读不到
  H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { deny, additionalDirectories: [h.home, h.work], disableAutoMode: 'disable' } }, null, 2));
  // 目录联接：不要管理员
  const link = path.join(h.work, 'kitlink');
  const mk = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mklink', '/J', link, kit], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const shortKit = shortOf(kit);
  const drive = /^([A-Za-z]):\\/.exec(kit);
  const styles = [
    ['正常写法', kit],
    ['正斜杠', kit.split('\\').join('/')],
    ['大小写不同', kit.toUpperCase()],
    ['相对路径', path.relative(proj, kit)],
    ['~ 开头', '~/.claude/vibe-kit'],
    ['8.3 短名' + (shortKit === kit ? '（这个盘没开短名，和正常写法一样）' : ''), shortKit],
    ['目录联接' + (mk.status === 0 ? '' : '（没建成：' + brief(mk.stdout + mk.stderr, 60) + '）'), link],
    ['\\\\?\\ 前缀', '\\\\?\\' + kit],
    ['\\\\localhost\\C$ 管理共享', drive ? '\\\\localhost\\' + drive[1] + '$\\' + kit.slice(3) : kit],
  ];
  const steps = [];
  for (const [name, dir] of styles) {
    const sep = /\//.test(dir) && !/\\/.test(dir) ? '/' : '\\';
    steps.push({ name, what: '令牌', file: dir + sep + 'secrets.json' });
    steps.push({ name, what: 'key', file: dir + sep + 'router-data' + sep + 'config.json' });
    steps.push({ name, what: '对照', file: dir + sep + 'config.json' });
  }
  const results = [];
  let n = 0;
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
    // 上一步的工具结果：按调用编号在整段消息里找（结果后面可能还跟着别的消息）
    const want = 'toolu_rd_' + n;
    let tr = null;
    for (const m of body.messages) for (const b of (Array.isArray(m.content) ? m.content : [])) if (b && b.type === 'tool_result' && b.tool_use_id === want) tr = b;
    if (tr && n > 0) {
      const text = typeof tr.content === 'string' ? tr.content : textOf({ content: tr.content });
      results.push(Object.assign({}, steps[n - 1], { got: text.includes(SECRET) || text.includes(PLAIN), err: !!tr.is_error, text: brief(text, 140) }));
    }
    const s = steps[n++];
    if (!s) return reply(body, res, { type: 'text', text: 'PROBE-END' }, 'end_turn');
    return reply(body, res, { type: 'tool_use', id: 'toolu_rd_' + n, name: 'Read', input: { file_path: s.file } }, 'tool_use');
  });
  const r = await runPrint(EXE, h, proj, gw.port, 'read files', BYPASS ? ['--dangerously-skip-permissions'] : [], {}, 240);
  gw.close();
  console.log('===== ' + EXE + (BYPASS ? '（--dangerously-skip-permissions）' : '') + ' =====');
  console.log('拒读规则：' + deny.join('、'));
  const by = new Map();
  for (const x of results) { if (!by.has(x.name)) by.set(x.name, {}); by.get(x.name)[x.what] = x; }
  for (const [name, m] of by) {
    const c = m['对照'] || {}; const s = m['令牌'] || {}; const k = m['key'] || {};
    const verdict = !c.got ? '对照也没读到，看不出（' + brief(c.text, 80) + '）' : (s.got || k.got) ? '★挡不住：' + (s.got ? '令牌读出来了 ' : '') + (k.got ? 'key 读出来了' : '') : '挡住了';
    console.log('  ' + name.padEnd(24) + verdict);
    if (s.got || k.got || !c.got) console.log('      令牌：' + (s.text || '（没发）') + '\n      对照：' + (c.text || '（没发）'));
  }
  if (results.length < steps.length) console.log('只跑了 ' + results.length + ' / ' + steps.length + ' 步。退出码 ' + r.code + (r.killed ? '（到时间结束了）' : '') + '；' + brief(r.err || r.out, 300));
  H.done('探测：Read 读令牌的几种路径写法');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
