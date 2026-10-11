'use strict';
/* 实测 PostToolUse 和 Failure 的结果形状；只在假用户目录跑假网关与无副作用命令，不使用真实账户。 */
const fs = require('fs'); const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint } = require('./common');
(async () => {
  const exe = exeOf(process.argv[2]); const h = H.makeHome('post-tool'); const p = H.makeRepo(path.join(h.work, 'p'), { 'a.js': 'console.log("通过");\n' });
  const log = path.join(h.root, 'post.jsonl'); const hook = path.join(h.root, 'capture.js');
  H.write(hook, "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const j=JSON.parse(b);require('fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({event:j.hook_event_name,id:!!j.tool_use_id,response:j.tool_response,error:!!j.error})+'\\n');});");
  const command = 'node "' + hook + '"'; H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }));
  let n = 0; const steps = ['node a.js', 'node -e "process.exit(7)"'];
  const gw = await fakeGateway((body, res) => { if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn'); const s = steps[n++]; return s ? reply(body, res, { type: 'tool_use', id: 'toolu_post_' + n, name: 'Bash', input: { command: s } }, 'tool_use') : reply(body, res, { type: 'text', text: '结束' }, 'end_turn'); });
  try {
    const r = await runPrint(exe, h, p, gw.port, '按脚本执行两个测试命令', ['--dangerously-skip-permissions'], {}, 70);
    const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    console.log('版本 ' + process.argv[2] + '，退出码 ' + r.code + '；完成事件：' + JSON.stringify(events));
    H.ok('成功命令有完成事件和工具编号', events.some((x) => x.event === 'PostToolUse' && x.id && x.response && /通过/.test(JSON.stringify(x.response))), r.err);
    H.ok('失败命令不成为成功完成', events.some((x) => x.event === 'PostToolUseFailure' && x.error));
  } finally { gw.close(); }
  H.done('PostToolUse 探测');
})().catch((e) => { H.ok('探测异常', false, e.stack); H.done('PostToolUse 探测'); });
