'use strict';
/*
 * 探测：钩子的 if 条件（权限规则的写法，比如 "Bash(*push*)"）在各种藏着 push 的命令上触发不触发。
 * 为什么要测（2026-10-30）：定了 push 的检查单独走命令方式，可每条 Bash 都起一个命令钩子要 0.3—0.9 秒；
 * 用 if 只在命令里像有 push 时才起，就不拖慢别的命令。要知道 $(…)、反引号、bash -c、git -C 这些写法会不会漏。
 * 几种 if 各登记一个钩子，外加一个不带 if 的作对照；钩子被调到就往日志里记一笔（标签 + 命令），什么都不拦。
 * 命令在一个不是 git 仓库的空目录里跑，git push 只会报"不是 git 仓库"。
 * 用法：node dev/probes/cc-hook-if.js <版本号 | claude.exe>
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint } = require('./common');

const EXE = exeOf(process.argv[2]);
const PATTERNS = { star: 'Bash(*push*)', prefix: 'Bash(git push*)', git: 'Bash(git *)' };
const CMDS = [
  'echo hello',
  'git status',
  'git push origin main',
  'git -C sub push',
  'cd sub && git push',
  'echo ok; git push',
  'echo "r $(git push)"',
  'x=`git push`; echo $x',
  'bash -c "git push"',
  "sh -c 'git push'",
  'GIT_DIR=x git push',
  'echo pushing-notes',
];

(async () => {
  const h = H.freshHome('pif');
  const proj = path.join(h.root, 'proj');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  const log = path.join(h.root, 'hit.log');
  const hookJs = path.join(h.root, 'hit.js');
  fs.writeFileSync(hookJs, "const tag=process.argv[2];let s='';process.stdin.on('data',(d)=>{s+=d;}).on('end',()=>{try{const j=JSON.parse(s);require('fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify([tag,(j.tool_input||{}).command])+'\\n');}catch(e){}});\n");
  const cmd = (tag) => 'node "' + hookJs.split(path.sep).join('/') + '" ' + tag;
  const hooks = [{ type: 'command', command: cmd('all') }].concat(Object.entries(PATTERNS).map(([tag, p]) => ({ type: 'command', command: cmd(tag), if: p })));
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks }] } }, null, 2));
  let seq = 0;
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
    const c = CMDS[seq++];
    if (c) return reply(body, res, { type: 'tool_use', id: 'toolu_if_' + seq, name: 'Bash', input: { command: c, description: 'probe' } }, 'tool_use');
    return reply(body, res, { type: 'text', text: '做完了。' }, 'end_turn');
  });
  const r = await runPrint(EXE, h, proj, gw.port, '照剧本跑命令', ['--permission-mode', 'bypassPermissions'], {}, 300);
  gw.close();
  const hits = (H.read(log) || '').split(/\r?\n/).filter(Boolean).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  const hit = (tag, c) => hits.some((x) => x[0] === tag && x[1] === c);
  console.log('Claude Code：' + EXE + '\n退出码 ' + r.code + (r.killed ? '（超时结束）' : '') + '，假模型发了 ' + Math.min(seq, CMDS.length) + ' 条命令\n');
  console.log(['不带if', PATTERNS.star, PATTERNS.prefix, PATTERNS.git, '命令'].join(' | '));
  for (const c of CMDS) console.log([hit('all', c), hit('star', c), hit('prefix', c), hit('git', c)].map((b) => (b ? '触发' : '  - ')).join(' | ') + ' | ' + c);
  H.cleanup();
})();
