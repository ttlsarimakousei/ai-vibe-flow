'use strict';
/*
 * 探测（第 64、71 条，2026-11-05）：内网报告看到审查慢在子代理每一步想太多（等模型时间和输出 token 相关系数 0.98），要知道手上有哪些手段。
 * 只在假用户目录里跑假网关，不用真账户，不装套件。用 -p 跑，一次一个配置。
 * 1. 代理文件写 effort：子代理的请求里 thinking、output_config 怎么变；模型名是 sonnet 别名、设了 ANTHROPIC_DEFAULT_SONNET_MODEL 时一样不一样；主会话变不变。
 * 2. SubagentStart 钩子的 additionalContext 能不能进子代理的第一个请求（材料不用子代理再读一次）。
 * 3. 代理文件里的 hooks：只对这个子代理生效吗；Read 拦得到吗；deny 的理由、additionalContext 送不送得到模型。
 * 用法：node dev/probes/cc-reviewer-opts.js <版本号，例 2.1.289>
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, runPrint, systemOf } = require('./common');

const EXE = exeOf(process.argv[2]);
const START = 'MARK-SUBAGENT-START';
const SOFT = 'MARK-SOFT-NOTE';
const DENY = 'MARK-DENY-REASON';
const fwd = (p) => p.split(path.sep).join('/');

async function once(name, effort, env) {
  const h = H.freshHome('pro');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n', 'OUTSIDE.md': '# y\n' });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [fwd(proj)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const hookLog = path.join(h.root, 'hooks.log');
  const log = "const fs=require('fs');const log=(j,ev)=>fs.appendFileSync(" + JSON.stringify(hookLog) + ",JSON.stringify({ev,tool:j.tool_name,agent:j.agent_id||'',type:j.agent_type||'',file:j.tool_input&&j.tool_input.file_path||''})+'\\n');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let j={};try{j=JSON.parse(s)}catch(e){}";
  const fm = path.join(h.root, 'fm.js');
  fs.writeFileSync(fm, log + "log(j,'代理文件的钩子');if(j.tool_name==='Read'&&/OUTSIDE/.test((j.tool_input||{}).file_path||''))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:" + JSON.stringify(DENY) + "}}));else if(j.tool_name==='Bash')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:" + JSON.stringify(SOFT) + "}}));process.exit(0)});");
  const st = path.join(h.root, 'start.js');
  fs.writeFileSync(st, log + "log(j,'SubagentStart');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:" + JSON.stringify(START) + "}}));process.exit(0)});");
  H.write(path.join(h.cfg, 'agents', 'r1.md'), ['---', 'name: r1', 'description: 探针审查代理', 'tools: Read, Bash', 'model: sonnet'].concat(effort ? ['effort: ' + effort] : []).concat(['hooks:', '  PreToolUse:', '    - matcher: "Read|Bash"', '      hooks:', '        - type: command', "          command: 'node \"" + fwd(fm) + "\"'", '---', '', '你是探针。', '']).join('\n'));
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Bash', 'Read', 'Agent', 'Task'] }, hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: 'node "' + fwd(st) + '"' }] }] } }, null, 2));
  const reqs = { main: [], sub: [] };
  let n = 0;
  const gw = await fakeGateway((body, res) => {
    const names = (body.tools || []).map((t) => t.name);
    if (!names.length) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
    const main = isMain(body);
    const results = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
    const all = JSON.stringify(body.messages) + systemOf(body);
    (main ? reqs.main : reqs.sub).push({ model: body.model, thinking: body.thinking ? JSON.stringify(body.thinking) : '无', oc: body.output_config ? JSON.stringify(body.output_config) : '无', max: body.max_tokens, start: all.includes(START), soft: all.includes(SOFT), deny: all.includes(DENY) });
    const id = 'toolu_' + (++n);
    if (main) {
      if (results.length === 0) return reply(body, res, { type: 'tool_use', id, name: 'Bash', input: { command: 'echo main', description: 'x' } }, 'tool_use');
      if (results.length === 1) return reply(body, res, { type: 'tool_use', id, name: names.includes('Agent') ? 'Agent' : 'Task', input: { subagent_type: 'r1', description: '探针', prompt: '探针任务', run_in_background: false } }, 'tool_use');
      return reply(body, res, { type: 'text', text: '主会话结束' }, 'end_turn');
    }
    if (results.length === 0) return reply(body, res, { type: 'tool_use', id, name: 'Read', input: { file_path: fwd(path.join(proj, 'OUTSIDE.md')) } }, 'tool_use');
    if (results.length === 1) return reply(body, res, { type: 'tool_use', id, name: 'Read', input: { file_path: fwd(path.join(proj, 'README.md')) } }, 'tool_use');
    if (results.length === 2) return reply(body, res, { type: 'tool_use', id, name: 'Bash', input: { command: 'echo sub', description: 'x' } }, 'tool_use');
    return reply(body, res, { type: 'text', text: '子代理结束' }, 'end_turn');
  });
  const r = await runPrint(EXE, h, proj, gw.port, '开始', [], env, 90);
  gw.close();
  let hooks = []; try { hooks = fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { /* 没有 */ }
  const fmHooks = hooks.filter((x) => x.ev === '代理文件的钩子');
  const first = (l) => l[0] || {};
  const lastSub = reqs.sub[reqs.sub.length - 1] || {};
  console.log('\n## ' + name + '（代理文件 effort：' + (effort || '不写') + '）' + (r.killed ? ' 【超时被结束】' : ''));
  console.log('  主会话：model=' + first(reqs.main).model + ' thinking=' + first(reqs.main).thinking + ' output_config=' + first(reqs.main).oc + ' max_tokens=' + first(reqs.main).max);
  console.log('  子代理：model=' + first(reqs.sub).model + ' thinking=' + first(reqs.sub).thinking + ' output_config=' + first(reqs.sub).oc + ' max_tokens=' + first(reqs.sub).max + ' 请求 ' + reqs.sub.length + ' 个');
  console.log('  SubagentStart 触发 ' + hooks.filter((x) => x.ev === 'SubagentStart').length + ' 次，注入进子代理第一个请求：' + !!first(reqs.sub).start);
  console.log('  代理文件的钩子：' + fmHooks.map((x) => x.tool + (x.agent ? '(子代理)' : '(主会话)')).join('、') + '；主会话的 Bash 触发了：' + fmHooks.some((x) => !x.agent) + '；Read 拦得到：' + fmHooks.some((x) => x.tool === 'Read'));
  console.log('  deny 的理由送到模型：' + !!lastSub.deny + '；Bash 的 additionalContext 送到模型：' + !!lastSub.soft);
  fs.rmSync(h.root, { recursive: true, force: true });
}

(async () => {
  console.log('版本 ' + process.argv[2]);
  const custom = { ANTHROPIC_MODEL: 'deepseek-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' };
  await once('网关自己映射模型（Claude Code 以为是 sonnet）', '', {});
  await once('网关自己映射模型（Claude Code 以为是 sonnet）', 'low', {});
  await once('环境变量指定模型名', '', custom);
  await once('环境变量指定模型名', 'low', custom);
  await once('环境变量指定模型名，声明支持 effort', 'low', Object.assign({ ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'effort,thinking,adaptive_thinking,interleaved_thinking' }, custom));
})().catch((e) => { console.log(e.stack); process.exitCode = 1; });
