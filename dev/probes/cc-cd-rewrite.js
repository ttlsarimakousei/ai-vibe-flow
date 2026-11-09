'use strict';
/*
 * 实测（第 71 条第 1 点，2026-11-09）：Bash 里 cd 和 git 串在一条，Claude Code 停下来要人确认；钩子用 updatedInput 改成不用 cd 的写法
 * （cd 到当前目录的去掉、cd X && git 改成 git -C X）以后，还停不停。-p 模式下要确认的命令直接不执行，看执行没有就知道。
 * 只在假用户目录、假网关里跑 git status。
 * 用法：node dev/probes/cc-cd-rewrite.js <版本号或 claude.exe>
 */
const fs = require('fs'); const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint } = require('./common');
(async () => {
  const exe = exeOf(process.argv[2]);
  const fwd = (p) => p.split(path.sep).join('/');
  const cases = [
    { name: 'cd 别的仓库 && git，不改写', cmd: (p, q) => 'cd "' + fwd(q) + '" && git status --short', rewrite: null },
    { name: 'cd 别的仓库 && git，改成 git -C', cmd: (p, q) => 'cd "' + fwd(q) + '" && git status --short', rewrite: (p, q) => 'git -C "' + fwd(q) + '" status --short' },
    { name: 'cd 当前目录 && git，不改写', cmd: (p) => 'cd "' + fwd(p) + '" && git status --short', rewrite: null },
    { name: 'cd 当前目录 && git，去掉 cd', cmd: (p) => 'cd "' + fwd(p) + '" && git status --short', rewrite: () => 'git status --short' },
  ];
  for (const perm of ['skip', 'allow-git']) {
    for (const c of cases) {
      const h = H.makeHome('cd-rw'); const p = H.makeRepo(path.join(h.work, 'p'), { 'a.txt': 'x\n' }); const q = H.makeRepo(path.join(h.work, 'q'), { 'b.txt': 'y\n' });
      const log = path.join(h.root, 'post.jsonl'); const pre = path.join(h.root, 'pre.js'); const post = path.join(h.root, 'post.js');
      const to = c.rewrite ? c.rewrite(p, q) : '';
      H.write(pre, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);" + (to ? "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:Object.assign({},j.tool_input,{command:" + JSON.stringify(to) + "})}}));" : '') + "});");
      H.write(post, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);require('fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({event:j.hook_event_name,command:(j.tool_input||{}).command,out:JSON.stringify(j.tool_response||j.error||'').slice(0,160)})+'\\n');});");
      const permissions = perm === 'allow-git' ? { allow: ['Bash(git:*)', 'Bash(git *)'], disableAutoMode: 'disable' } : { disableAutoMode: 'disable' };
      H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + pre + '"' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + post + '"' }] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + post + '"' }] }] } }));
      let n = 0; let result = '';
      const gw = await fakeGateway((body, res) => {
        if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
        if (n++ === 0) return reply(body, res, { type: 'tool_use', id: 'toolu_cd_' + n + Date.now(), name: 'Bash', input: { command: c.cmd(p, q), description: '探测' } }, 'tool_use');
        const last = body.messages[body.messages.length - 1]; const tr = Array.isArray(last.content) ? last.content.find((x) => x.type === 'tool_result') : null;
        if (tr) result = (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)).slice(0, 160);
        return reply(body, res, { type: 'text', text: '完成' }, 'end_turn');
      });
      try {
        await runPrint(exe, h, p, gw.port, '看一下状态', perm === 'skip' ? ['--dangerously-skip-permissions'] : [], {}, 70);
        const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
        const ran = events.find((e) => e.event === 'PostToolUse');
        console.log('[' + perm + '] ' + c.name + '：' + (ran ? '执行了 ' + ran.command : '没执行') + '；工具结果：' + result.replace(/\s+/g, ' '));
      } finally { gw.close(); try { fs.rmSync(h.root, { recursive: true, force: true }); } catch (e) { /* 占着 */ } }
    }
  }
})().catch((e) => { console.log('探测异常 ' + e.stack); });
