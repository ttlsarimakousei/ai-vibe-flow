'use strict';
/*
 * 实测 PreToolUse 钩子的 updatedInput：能不能在执行前改写 Bash 命令、改写后按哪条命令查权限。
 * 套件集成 OpenSpec 靠它：模型照常敲 openspec …，钩子改成调用套件自带的那份（2026-10-17）。
 * 三种情况：跳过权限；只允许原命令（看改写后的命令还认不认这条规则）；钩子同时给 allow。只在假用户目录、假网关里跑 echo。
 * 用法：node dev/probes/cc-updated-input.js <版本号或 claude.exe>
 */
const fs = require('fs'); const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint } = require('./common');
(async () => {
  const exe = exeOf(process.argv[2]);
  const results = [];
  for (const mode of ['skip', 'allow-original', 'hook-allow']) {
    const h = H.makeHome('updated-input-' + mode); const p = H.makeRepo(path.join(h.work, 'p'), { 'a.txt': 'x\n' });
    const log = path.join(h.root, 'post.jsonl'); const pre = path.join(h.root, 'pre.js'); const post = path.join(h.root, 'post.js');
    const decision = mode === 'hook-allow' ? ", permissionDecision: 'allow'" : '';
    H.write(pre, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);const c=String((j.tool_input||{}).command||'');if(!/^echo ORIGINAL/.test(c))return;process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse'" + decision + ",updatedInput:Object.assign({},j.tool_input,{command:'echo REWRITTEN'})}}));});");
    H.write(post, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);require('fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({event:j.hook_event_name,command:(j.tool_input||{}).command,out:JSON.stringify(j.tool_response||j.error||'').slice(0,200)})+'\\n');});");
    const permissions = mode === 'allow-original' ? { allow: ['Bash(echo ORIGINAL)'], disableAutoMode: 'disable' } : { disableAutoMode: 'disable' };
    H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + pre + '"' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + post + '"' }] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "' + post + '"' }] }] } }));
    let n = 0;
    const gw = await fakeGateway((body, res) => { if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn'); if (n++ === 0) return reply(body, res, { type: 'tool_use', id: 'toolu_upd_' + mode.replace(/-/g, '_'), name: 'Bash', input: { command: 'echo ORIGINAL', description: '探测' } }, 'tool_use'); return reply(body, res, { type: 'text', text: '完成' }, 'end_turn'); });
    try {
      const r = await runPrint(exe, h, p, gw.port, '跑一条 echo', mode === 'skip' ? ['--dangerously-skip-permissions'] : [], {}, 70);
      const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      results.push({ mode, code: r.code, events });
      console.log('[' + mode + '] 退出码 ' + r.code + '；' + (events.length ? events.map((e) => e.event + ' 实际执行：' + e.command + ' 输出：' + e.out).join('；') : '没有执行（多半被权限拦下）'));
    } finally { gw.close(); }
  }
  const ran = (m) => (results.find((x) => x.mode === m) || { events: [] }).events;
  H.ok('跳过权限时改写生效：执行的是 echo REWRITTEN', ran('skip').some((e) => e.command === 'echo REWRITTEN' && /REWRITTEN/.test(e.out)));
  console.log('只允许原命令时：' + (ran('allow-original').some((e) => e.command === 'echo REWRITTEN') ? '改写后的命令也执行了（权限按原命令查，或没查）' : '改写后的命令没执行（权限按改写后的命令查）'));
  console.log('钩子同时给 allow 时：' + (ran('hook-allow').some((e) => e.command === 'echo REWRITTEN') ? '执行了改写后的命令' : '没执行'));
  H.done('updatedInput 探测 ' + process.argv[2]);
})().catch((e) => { H.ok('探测异常', false, e.stack); H.done('updatedInput 探测'); });
