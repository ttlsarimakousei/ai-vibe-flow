'use strict';
/*
 * 探测：没配权限模式时，Claude Code 是不是进了它自带的"自动模式"（auto mode，2.1.284 起的默认）；
 * 进了的话，分类器的请求经不经网关、哪些命令会触发、答得不合格式会怎样。
 * 假网关把每个请求记下来：主会话的按剧本一步调一个工具；别的请求（分类器、标题……）按 PROBE_CLASSIFIER 回答。
 * 套件默认在 settings.json 里写 permissions.disableAutoMode（install.js 的 applyCcAutoMode）靠的就是这里测出来的行为。
 * 用法：node dev/probes/cc-automode.js <版本号 | claude.exe> [只跑哪几个用例，逗号分开]
 *       PROBE_CLASSIFIER=allow（默认，回 <block>no</block>）| garbage（回一句不合格式的话）
 *       PROBE_KEEP=<目录>  把分类器的请求原文存到这个目录里
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, brief, textOf, systemOf, isMain, reply, fakeGateway, runPrint } = require('./common');

const EXE = exeOf(process.argv[2]);
const ONLY = (process.argv[3] || '').split(',').filter(Boolean);
const KEEP = process.env.PROBE_KEEP ? path.resolve(process.env.PROBE_KEEP) : '';
const MODE = process.env.PROBE_CLASSIFIER || 'allow';

// 主会话的剧本：一步一个工具调用。{proj} 换成项目目录
const STEPS = [
  { name: 'Bash', input: { command: 'echo step1', description: '打印' } },
  { name: 'Bash', input: { command: 'node -e "require(\'fs\').writeFileSync(\'gen.txt\',\'x\')"', description: '用 node 写一个文件' } },
  { name: 'Write', input: { file_path: '{proj}/b.txt', content: 'hello\n' } },
  { name: 'Edit', input: { file_path: '{proj}/b.txt', old_string: 'hello', new_string: 'hello world' } },
  { name: 'Bash', input: { command: 'git status --short', description: '看状态' } },
  { name: 'Bash', input: { command: 'curl -s -m 2 http://127.0.0.1:9/x', description: '连一个本机没开的端口' } },
  { name: 'Read', input: { file_path: '{proj}/README.md' } },
];
let log = []; let mainSeq = 0; let proj = ''; let caseId = ''; let seq = 0; let results = [];

function onMessage(body, res) {
  if (!isMain(body)) {
    const sys = systemOf(body);
    const last = textOf((body.messages || []).slice(-1)[0] || {});
    log.push({ kind: '别的', model: body.model, stream: !!body.stream, max: body.max_tokens, sysLen: sys.length, sys: brief(sys.replace(/^x-anthropic-billing-header:[^\n]*\n?/, ''), 70), last: brief(last, 160), stop: JSON.stringify(body.stop_sequences || []) });
    if (KEEP) { fs.mkdirSync(KEEP, { recursive: true }); fs.writeFileSync(path.join(KEEP, caseId + '-' + String(++seq).padStart(2, '0') + '.json'), JSON.stringify(body, null, 1)); }
    return reply(body, res, { type: 'text', text: MODE === 'garbage' ? '我看了一下，这条命令应该没什么问题。' : '<block>no</block>' }, 'end_turn');
  }
  log.push({ kind: '主会话', model: body.model });
  mainSeq++;
  const step = STEPS[mainSeq - 1];
  if (step) return reply(body, res, { type: 'tool_use', id: 'toolu_a_' + mainSeq, name: step.name, input: JSON.parse(JSON.stringify(step.input).split('{proj}').join(proj.split('\\').join('/'))) }, 'tool_use');
  results = [];
  for (const m of body.messages || []) if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_result') results.push((c.is_error ? '没成 ' : '成了 ') + brief(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 110));
  return reply(body, res, { type: 'text', text: '做完了。' }, 'end_turn');
}

// 套件装的那几条权限（settings.fragment.json）
const KIT = { allow: ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep'], ask: ['Bash(git push:*)'] };
const CASES = [
  { id: 'K', name: '套件的权限，没配权限模式', settings: { permissions: KIT } },
  { id: 'X', name: '套件的权限 + disableAutoMode（套件现在装成这样）', settings: { permissions: Object.assign({ disableAutoMode: 'disable' }, KIT) } },
  { id: 'D', name: '套件的权限 + defaultMode: default', settings: { permissions: Object.assign({ defaultMode: 'default' }, KIT) } },
  { id: 'A', name: '套件的权限 + defaultMode: acceptEdits', settings: { permissions: Object.assign({ defaultMode: 'acceptEdits' }, KIT) } },
  { id: 'B', name: '套件的权限，命令行 --dangerously-skip-permissions', settings: { permissions: KIT }, args: ['--dangerously-skip-permissions'] },
  { id: 'N', name: '什么权限都没配', settings: {} },
  { id: 'Q', name: '套件的权限，没配权限模式，模型名是内网的真名', settings: { permissions: KIT }, env: { ANTHROPIC_MODEL: 'Qwen3-Flash-Next' } },
  { id: 'T', name: '套件的权限，没配权限模式，连不上 Anthropic 的服务（内网的样子）', settings: { permissions: KIT }, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
];

(async () => {
  const gw = await fakeGateway(onMessage, (req) => log.push({ kind: '非对话', url: req.method + ' ' + req.url }));
  console.log('===== ' + EXE + '（分类器的回答：' + MODE + '） =====');
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const h = H.freshHome('pa-' + c.id.toLowerCase());
    fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify(c.settings, null, 2));
    proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
    log = []; mainSeq = 0; caseId = c.id; seq = 0; results = [];
    const r = await runPrint(EXE, h, proj, gw.port, '照我说的一步一步做', c.args, c.env, 240);
    const others = log.filter((x) => x.kind === '别的');
    console.log('\n[' + c.id + '] ' + c.name);
    console.log('    主会话请求 ' + log.filter((x) => x.kind === '主会话').length + ' 次（模型名 ' + ((log.find((x) => x.kind === '主会话') || {}).model || '?') + '）；别的请求 ' + others.length + ' 次；退出码 ' + r.code + (r.killed ? '（超时被结束）' : ''));
    console.log('    顺序：' + log.map((x) => (x.kind === '主会话' ? '主' : x.kind === '别的' ? '别(' + x.model + ' max=' + x.max + ')' : x.url)).join(' → '));
    if (others.length) console.log('    头一个"别的"请求：系统提示 ' + others[0].sysLen + ' 字符，开头"' + others[0].sys + '"；stop_sequences ' + others[0].stop + '\n      最后一条消息：' + others[0].last);
    console.log('    七步的结果：\n' + results.map((s, i) => '      ' + (i + 1) + '. ' + STEPS[i].name + ' ' + brief(STEPS[i].input.command || STEPS[i].input.file_path, 40) + ' → ' + s).join('\n'));
    console.log('    被拒的：' + brief(JSON.stringify((r.json && r.json.permission_denials || []).map((d) => d.tool_name + ' ' + brief(d.tool_input.command || d.tool_input.file_path, 40))), 300));
    if (r.err.trim()) console.log('    stderr：' + brief(r.err, 500));
  }
  gw.close();
  H.done('探测：Claude Code 自带的自动模式');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
