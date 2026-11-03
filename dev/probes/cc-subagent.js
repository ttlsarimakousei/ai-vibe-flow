'use strict';
/*
 * 探测：审查改成子代理之前要知道的（问题表第 45 条）。交互界面，假用户目录，假网关，不装套件。
 * 1. 给模型的工具叫 Agent 还是 Task，有没有 run_in_background 这个参数。
 * 2. 一条回复里 3 个子代理调用：是不是同时跑（第 2、3 个的首请求早于第 1 个回完）。
 * 3. 子代理请求的 model 和主会话一样不一样（代理文件里不写 model）。
 * 4. 前台时主会话的工具结果是不是子代理的全文；PostToolUse 的 tool_response 能不能拿到最终文本。
 * 5. 子代理里 Bash 跑 node 脚本，stdin 带中文 JSON，字节对不对；钩子拦得到子代理的 Bash 吗。
 * 6. 子代理里钩子收到的 session_id、agent_id、transcript_path。
 * 7. 子代理跑着时按 Esc：还有没有新请求、请求断不断；再说一句 UserPromptSubmit 触发不触发。
 * 8. SubagentStop 的 last_assistant_message：长文本全不全；回 decision:block 子代理接着写吗。
 * 用法：node dev/probes/cc-subagent.js <版本号 | claude.exe> [跑多少秒，默认 120]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { H, exeOf, brief, fakeGateway, claudeEnv, killTree } = require('./common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 120;
const WINPTY = 'C:/Program Files/Git/usr/bin/winpty.exe';
const SECOND = '第二句RRR';
const THIRD = '第三句SSS';
const PAYLOAD = JSON.stringify({ 问题: '空列表时返回 500，应该是 200', severity: 'P1', file: 'src/订单.java', 引号: 'a"b\'c' });

function send(body, res, blocks, stop) {
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const usage = { input_tokens: 3000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: blocks, stop_reason: stop, usage })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  blocks.forEach((b, index) => {
    if (b.type === 'text') { ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }); }
    else { ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }); }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } }, { type: 'message_stop' });
  for (const e of ev) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
}
const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
const textOfResult = (b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(''));

(async () => {
  const watch = await H.watchWindows('psa-win');
  const h = H.freshHome('psa');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  H.write(path.join(h.cfg, 'agents', 'pv.md'), '---\nname: pv\ndescription: 探针审查代理\ntools: Bash, Read\n---\n\n你是探针。\n');

  const hookLog = path.join(h.root, 'hooks.log');
  const hookJs = path.join(h.root, 'hook.js');
  fs.writeFileSync(hookJs, "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let j={};try{j=JSON.parse(s)}catch(e){}const r=j.tool_response;fs.appendFileSync(" + JSON.stringify(hookLog) + ",JSON.stringify({ev:process.argv[2],at:Date.now(),sid:j.session_id,agent:j.agent_id,agentType:j.agent_type,tp:j.transcript_path,atp:j.agent_transcript_path,tool:j.tool_name,cmd:j.tool_input&&j.tool_input.command,prompt:j.prompt,last:j.last_assistant_message,lastLen:(j.last_assistant_message||'').length,atp2:j.agent_transcript_path,resp:r===undefined?undefined:(typeof r==='string'?r:JSON.stringify(r)).slice(0,1500)})+'\\n');if(process.argv[2]==='SubagentStop'&&/NEED-BLOCK/.test(j.last_assistant_message||'')&&!/FIXED/.test(j.last_assistant_message||'')){process.stdout.write(JSON.stringify({decision:'block',reason:'JSON 不对，重写一遍'}))}process.exit(0)});");
  const cmd = (ev, matcher) => [Object.assign(matcher ? { matcher } : {}, { hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '" ' + ev }] })];
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Bash', 'Read', 'Agent', 'Task'] }, hooks: { UserPromptSubmit: cmd('UserPromptSubmit'), Stop: cmd('Stop'), SubagentStop: cmd('SubagentStop'), PreToolUse: cmd('PreToolUse', 'Bash|Agent|Task'), PostToolUse: cmd('PostToolUse', 'Bash|Agent|Task') } }, null, 2));
  const submitJs = path.join(h.root, 'submit.js').split(path.sep).join('/');
  const submitted = path.join(h.root, 'submitted');
  fs.mkdirSync(submitted);
  fs.writeFileSync(submitJs, "const fs=require('fs');const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{fs.writeFileSync(" + JSON.stringify(submitted.split(path.sep).join('/')) + "+'/'+process.argv[2],Buffer.concat(c));console.log('收到 '+Buffer.concat(c).length+' 字节')});");

  const t0 = Date.now(); const ms = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const events = []; const note = (s) => events.push(ms() + ' ' + s);
  let child = null; let mainN = 0; let escAt = 0; let afterEsc = 0; let secondQueued = false; let xyDone = false; let escPlanned = false;
  const models = { main: new Set(), sub: new Set() };
  const firstAt = {}; let firstDone = 0;
  const type = (text) => { note('输入：' + JSON.stringify(text)); child.stdin.write(text); if (text !== '\x1b') setTimeout(() => child.stdin.write('\r'), 400); };
  let agentTool = '';
  const gw = await fakeGateway((body, res) => {
    const names = (body.tools || []).map((t) => t.name);
    const allText = JSON.stringify(body.messages);
    const lens = (allText.match(/LENS-[A-Z]/) || [''])[0];
    const isSub = !names.includes('Edit') && !!lens;
    if (isSub) {
      models.sub.add(body.model);
      if (escAt && Date.now() > escAt + 5000) afterEsc++;
      const n = body.messages.length;
      const hasResult = body.messages.some((m) => blocksOf(m).some((b) => b.type === 'tool_result'));
      if (!hasResult) {
        if (!firstAt[lens]) firstAt[lens] = Date.now();
        note('子代理 ' + lens + ' 首请求 model=' + body.model + ' 工具=' + names.join(','));
        res.on('close', () => { if (!res.writableEnded) note('子代理 ' + lens + ' 的请求被断开'); });
        if (lens === 'LENS-X' || lens === 'LENS-Y') { setTimeout(() => { try { send(body, res, [{ type: 'text', text: '结论：问题 0 条' }], 'end_turn'); } catch (e) { /* 已断开 */ } }, 40000); if (!escPlanned) { escPlanned = true; setTimeout(() => { escAt = Date.now(); type('\x1b'); setTimeout(() => type(THIRD), 8000); }, 3000); } return undefined; }
        const go = () => { if (lens === 'LENS-A') firstDone = Date.now(); send(body, res, [{ type: 'tool_use', id: 'toolu_sub_' + lens, name: 'Bash', input: { command: 'node "' + submitJs + '" ' + lens + " <<'EOF'\n" + PAYLOAD + '\nEOF', description: 'submit' } }], 'tool_use'); };
        return lens === 'LENS-A' ? setTimeout(go, 5000) : go();
      }
      note('子代理 ' + lens + ' 第二次请求，工具结果=' + brief(textOfResult(blocksOf(body.messages[n - 1]).find((b) => b.type === 'tool_result') || {}), 80));
      if (lens === 'LENS-B') { const again = /JSON 不对/.test(allText); note('子代理 LENS-B 请求：' + (again ? '看到了拦截的话，回 FIXED' : '回 NEED-BLOCK')); return send(body, res, [{ type: 'text', text: again ? 'NEED-BLOCK FIXED 结论：问题 1 条' : 'NEED-BLOCK 第一版' }], 'end_turn'); }
      if (lens === 'LENS-C') return send(body, res, [{ type: 'text', text: '长文本开始' + 'X'.repeat(60000) + '长文本结束' }], 'end_turn');
      return send(body, res, [{ type: 'text', text: '审完了 ' + lens + '。\n结论：问题 1 条\n```json\n' + PAYLOAD + '\n```' }], 'end_turn');
    }
    if (!names.includes('Edit')) { note('别的请求：工具 ' + names.length); return send(body, res, [{ type: 'text', text: 'ok' }], 'end_turn'); }
    models.main.add(body.model);
    mainN++;
    if (!agentTool) {
      agentTool = names.includes('Agent') ? 'Agent' : names.includes('Task') ? 'Task' : '';
      const def = (body.tools || []).find((t) => t.name === agentTool) || {};
      note('子代理工具：' + agentTool + '；参数：' + Object.keys((def.input_schema || {}).properties || {}).join(','));
    }
    const last = body.messages[body.messages.length - 1];
    const recent = body.messages.slice(-3).filter((m) => m.role === 'user').flatMap(blocksOf);
    const results = recent.filter((b) => b.type === 'tool_result');
    if (results.length) note('主会话工具结果（' + results.length + ' 个）：' + results.map((b) => brief(textOfResult(b), 170)).join(' ｜ '));
    const lastText = recent.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (/task-notification/.test(lastText)) note('主会话收到后台通知：' + brief(lastText, 300));
    if (mainN === 1) {
      note('回：同时开 3 个子代理');
      const call = (l) => ({ type: 'tool_use', id: 'toolu_a_' + l, name: agentTool, input: { description: '探针 ' + l, prompt: 'LENS-' + l + ' 审一下', subagent_type: 'pv' } });
      return send(body, res, ['A', 'B', 'C'].map(call), 'tool_use');
    }
    if (lastText.includes(THIRD)) { note('回：结束语'); setTimeout(() => killTree(child.pid), 5000); return send(body, res, [{ type: 'text', text: 'PROBE-END' }], 'end_turn'); }
    if (lastText.includes(SECOND) && !xyDone) {
      xyDone = true;
      note('回：开 2 个子代理，要按 Esc');
      const call = (l) => ({ type: 'tool_use', id: 'toolu_a_' + l, name: agentTool, input: { description: '探针 ' + l, prompt: 'LENS-' + l + ' 审一下', subagent_type: 'pv' } });
      return send(body, res, ['X', 'Y'].map(call), 'tool_use');
    }
    if (!secondQueued) { secondQueued = true; setTimeout(() => type(SECOND), 12000); }
    note('回：文字');
    return send(body, res, [{ type: 'text', text: 'PROBE-ANSWER' }], 'end_turn');
  });

  console.log('===== ' + EXE + ' =====');
  child = spawn(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '探针第一句'], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color', ANTHROPIC_MODEL: 'vk-probe' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
  const timer = setTimeout(() => { note('到时间，结束'); killTree(child.pid); }, SECONDS * 1000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);

  console.log('过程：\n' + events.map((e) => '  ' + e).join('\n'));
  console.log('并发：A 首请求 ' + ((firstAt['LENS-A'] - t0) / 1000).toFixed(1) + 's，B ' + ((firstAt['LENS-B'] - t0) / 1000).toFixed(1) + 's，C ' + ((firstAt['LENS-C'] - t0) / 1000).toFixed(1) + 's，A 回第一句 ' + ((firstDone - t0) / 1000).toFixed(1) + 's');
  console.log('model：主会话 ' + JSON.stringify([...models.main]) + '，子代理 ' + JSON.stringify([...models.sub]));
  console.log('Esc 后 5 秒以上还有子代理请求：' + afterEsc);
  for (const l of ['LENS-A', 'LENS-B', 'LENS-C']) { const f = path.join(submitted, l); const got = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '（没交）'; console.log('提交 ' + l + '：' + (got === PAYLOAD ? '字节一致' : '不一致 ' + brief(got, 100))); }
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log('钩子：\n' + hooks.map((e) => '  ' + ((e.at - t0) / 1000).toFixed(1) + 's ' + e.ev + (e.tool ? ' tool=' + e.tool : '') + ' sid=' + String(e.sid || '').slice(0, 8) + (e.agent ? ' agent=' + String(e.agent).slice(0, 8) : '') + (e.agentType ? ' type=' + e.agentType : '') + ' tp=' + path.basename(String(e.tp || '')).slice(0, 14) + (e.cmd ? ' cmd=' + brief(e.cmd, 30) : '') + (e.prompt ? ' prompt=' + brief(e.prompt, 20) : '') + (e.last ? ' lastLen=' + e.lastLen + ' last=' + brief(e.last, 40) + (e.lastLen > 1000 ? ' …结尾=' + e.last.slice(-5) : '') : '') + (e.resp ? ' resp=' + brief(e.resp, 260) : '')).join('\n'));
  gw.close();
  const wins = await watch.stop();
  console.log('冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.cleanup();
  process.exit(0);
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
