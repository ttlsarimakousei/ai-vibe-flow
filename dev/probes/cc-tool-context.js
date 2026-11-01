'use strict';
/*
 * 实测（K3，2026-11-01）：
 *   1. 失败的 Bash 走 PostToolUseFailure，顶层 error 是"Exit code N"加换行、再跟命令的全部输出（stdout、stderr 混在一起）——失败摘要靠它
 *   2. PostToolUseFailure、PreToolUse（不拦、只给 additionalContext）的 additionalContext 都送得到模型——失败摘要、提醒靠它
 *   3. Bash 跑起来的进程能不能认出自己是哪个会话：环境变量 CLAUDE_CODE_SESSION_ID；命令执行时，这条 tool_use 已经写进会话记录——commit.js、checkpoint.js 靠它
 * 只在假用户目录里跑假网关，不用真账户。用法：node dev/probes/cc-tool-context.js <版本号，例 2.1.289>
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint, textOf } = require('./common');

(async () => {
  const ver = process.argv[2];
  const exe = exeOf(ver);
  const h = H.makeHome('cc-toolctx');
  const p = H.makeRepo(path.join(h.work, 'p'), { 'fail.js': 'console.log("第一行输出");\nconsole.error("src/Foo.java:12: 错误: 找不到符号");\nprocess.exit(3);\n' });
  const log = path.join(h.root, 'events.jsonl');
  const hook = path.join(h.root, 'hook.js');
  // 记下事件，同时给每个事件回一句带记号的 additionalContext
  H.write(hook, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);require('fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({event:j.hook_event_name,tool:j.tool_name,error:j.error})+'\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:j.hook_event_name,additionalContext:'MARK-'+j.hook_event_name+'-'+j.tool_name}}));});");
  const self = path.join(h.root, 'self.js');
  const out = path.join(h.root, 'self.json');
  H.write(self, [
    "const fs=require('fs'),path=require('path');const found=[];",
    "const walk=(d)=>{let es=[];try{es=fs.readdirSync(d,{withFileTypes:true});}catch(e){return;}for(const e of es){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(/\\.jsonl$/.test(e.name)){const ls=fs.readFileSync(f,'utf8').split('\\n').filter(Boolean).map((l)=>JSON.parse(l));const last=ls[ls.length-1]||{};found.push({pending:!!(last.message&&Array.isArray(last.message.content)&&last.message.content.some((c)=>c.type==='tool_use'&&/self\\.js/.test(String(c.input&&c.input.command)))),cwd:last.cwd||''});}}};",
    "walk(path.join(process.env.CLAUDE_CONFIG_DIR,'projects'));",
    "fs.writeFileSync(" + JSON.stringify(out) + ",JSON.stringify({sid:process.env.CLAUDE_CODE_SESSION_ID||'',found}));",
  ].join('\n'));
  const command = 'node "' + hook.replace(/\\/g, '/') + '"';
  H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }));
  const steps = [{ name: 'Bash', input: { command: 'node fail.js' } }, { name: 'Write', input: { file_path: path.join(p, 'w.txt'), content: 'x\n' } }, { name: 'Bash', input: { command: 'node "' + self.replace(/\\/g, '/') + '"' } }];
  let n = 0;
  const seen = [];
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
    seen.push((body.messages || []).map(textOf).join('\n'));
    const s = steps[n++];
    return s ? reply(body, res, { type: 'tool_use', id: 'toolu_ctx_' + n, name: s.name, input: s.input }, 'tool_use') : reply(body, res, { type: 'text', text: '结束' }, 'end_turn');
  });
  try {
    const r = await runPrint(exe, h, p, gw.port, '按脚本执行', ['--dangerously-skip-permissions'], {}, 120);
    const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const fail = events.find((e) => e.event === 'PostToolUseFailure');
    const me = JSON.parse(H.read(out) || '{}');
    const all = seen.join('\n');
    console.log('版本 ' + ver + '，退出码 ' + r.code + '；失败事件的 error：' + JSON.stringify(fail && fail.error) + '；会话号环境变量：' + (me.sid ? '有' : '没有') + '；会话记录里正在跑的这条：' + JSON.stringify(me.found));
    H.ok('1 失败事件的 error 是"Exit code 3"加命令输出', !!fail && /^Exit code 3\n第一行输出\nsrc\/Foo\.java:12: 错误: 找不到符号/.test(fail.error || ''), fail);
    H.ok('2 PostToolUseFailure 的 additionalContext 送到了模型', /MARK-PostToolUseFailure-Bash/.test(all));
    H.ok('2 PreToolUse 只给 additionalContext：照常写了文件，话也送到了', fs.existsSync(path.join(p, 'w.txt')) && /MARK-PreToolUse-Write/.test(all));
    H.ok('3 执行时会话记录里已经有这条 tool_use', (me.found || []).some((x) => x.pending), me);
    console.log('  CLAUDE_CODE_SESSION_ID：' + (me.sid ? '有（' + (me.sid === (r.json && r.json.session_id) ? '和会话号一样' : '和会话号不一样') + '）' : '没有'));
  } finally { gw.close(); }
  H.done('Claude Code ' + ver + '：失败命令、附加上下文、认出自己的会话');
})().catch((e) => { H.ok('探测异常', false, e.stack); H.done('探测'); });
