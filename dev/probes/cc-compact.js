'use strict';
/*
 * 探测：上下文到了多少，Claude Code 自己压缩？设了 autoCompactWindow / CLAUDE_CODE_AUTO_COMPACT_WINDOW 和没设的差别。
 * 假网关每次回复都报一个很大的 input_tokens，看 Claude Code 会不会在下一次请求之前先发一个"总结对话"的请求（那就是自动压缩）。
 * 套件写 settings.json 的 autoCompactWindow 靠的就是这里测出来的行为（kit/lib/session.js 的 autoCompactWindowOf）。
 * 用法：node dev/probes/cc-compact.js <版本号 | claude.exe> [只跑哪几个用例，逗号分开]
 *       PROBE_DETAIL=1 把每个请求列出来
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, brief, textOf, systemOf, isMain, reply, fakeGateway, runPrint } = require('./common');

const EXE = exeOf(process.argv[2]);
const ONLY = (process.argv[3] || '').split(',').filter(Boolean);
let big = 0; let log = []; let mainSeq = 0;

function onMessage(body, res) {
  const sys = systemOf(body);
  const last = textOf((body.messages || []).slice(-1)[0] || {});
  // 新的版本压缩用的是同一套系统提示和工具（为了命中缓存），压缩的指令接在最后一条用户消息里："CRITICAL: Respond with TEXT ONLY…"
  const allText = (body.messages || []).map(textOf).join('\n');
  const compact = /create a detailed summary|summariz|总结/i.test(sys.slice(0, 3000)) || /create a detailed summary of the conversation|Your task is to create a detailed summary|CRITICAL: Respond with TEXT ONLY/i.test(last + '\n' + allText.slice(-20000));
  const kind = compact ? '压缩' : isMain(body) ? '主会话' : '别的';
  log.push({ kind, model: body.model, msgs: (body.messages || []).length, max: body.max_tokens, sys: brief(sys, 90), last: brief(last, 80) });
  if (compact) return reply(body, res, { type: 'text', text: '<summary>\n1. 用户让跑三条命令。\n2. 已经跑了前面的命令。\n</summary>' }, 'end_turn', 2000);
  if (kind === '别的') return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn', 100);
  mainSeq++;
  // 压缩之后历史里的工具调用没了：按主会话请求的次数走，最多让它跑三条命令
  if (mainSeq <= 3) return reply(body, res, { type: 'tool_use', id: 'toolu_p_' + mainSeq, name: 'Bash', input: { command: 'echo step' + mainSeq, description: '第 ' + mainSeq + ' 条' } }, 'tool_use', big);
  const ran = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use') : [])).length;
  return reply(body, res, { type: 'text', text: '做完了（历史里有 ' + ran + ' 次工具调用）。' }, 'end_turn', big);
}

const CASES = [
  { id: 'A', name: '什么都不设，上报 99 万（默认模型）', settings: {}, env: {}, big: 990000 },
  { id: 'B', name: 'settings 里 autoCompactWindow=1000000，上报 99 万', settings: { autoCompactWindow: 1000000 }, env: {}, big: 990000 },
  { id: 'C', name: 'settings 里 autoCompactWindow=500000，上报 48 万', settings: { autoCompactWindow: 500000 }, env: {}, big: 480000 },
  { id: 'D', name: '环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000，上报 48 万', settings: {}, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, big: 480000 },
  { id: 'E', name: 'settings 里 autoCompactWindow=500000，上报 30 万（没到线）', settings: { autoCompactWindow: 500000 }, env: {}, big: 300000 },
  { id: 'F', name: '什么都不设，上报 120 万（超过窗口）', settings: {}, env: {}, big: 1200000 },
  { id: 'G', name: 'settings.json 的 env 里写 CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000，上报 48 万', settings: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }, env: {}, big: 480000 },
  { id: 'H', name: 'settings 里 autoCompactWindow=933000（套件默认写的：上限 100 万的 90%），上报 91 万', settings: { autoCompactWindow: 933000 }, env: {}, big: 910000 },
  { id: 'I', name: 'settings 里 autoCompactWindow=933000，上报 98 万（跳过了压缩线）', settings: { autoCompactWindow: 933000 }, env: {}, big: 980000 },
];

(async () => {
  const gw = await fakeGateway(onMessage);
  console.log('===== ' + EXE + ' =====');
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const h = H.freshHome('pc-' + c.id.toLowerCase());
    // 不进 Claude Code 自带的自动模式（2.1.284 起的默认）：这里只看压缩
    fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify(Object.assign({ permissions: { allow: ['Bash', 'Read', 'Edit', 'Write'], disableAutoMode: 'disable' } }, c.settings), null, 2));
    const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
    big = c.big; log = []; mainSeq = 0;
    const r = await runPrint(EXE, h, proj, gw.port, '依次跑三条命令：echo step1、echo step2、echo step3', [], Object.assign({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, c.env), 120);
    const mains = log.filter((x) => x.kind === '主会话');
    console.log('[' + c.id + '] ' + c.name);
    console.log('    压缩请求 ' + log.filter((x) => x.kind === '压缩').length + ' 次；主会话请求 ' + mains.length + ' 次（模型名 ' + (mains[0] ? mains[0].model : '?') + '）；退出码 ' + r.code + (r.killed ? '（超时被结束）' : ''));
    console.log('    顺序：' + log.map((x) => x.kind + (x.kind === '主会话' ? '(' + x.msgs + '条消息)' : '')).join(' → '));
    console.log('    最后说的：' + brief((r.json && r.json.result) || r.out.slice(-200), 160));
    if (process.env.PROBE_DETAIL) for (const x of log) console.log('      - ' + x.kind + ' 消息 ' + x.msgs + ' max_tokens ' + x.max + ' 系统：' + x.sys);
    if (r.err.trim()) console.log('    stderr：' + brief(r.err, 300));
  }
  gw.close();
  H.done('探测：自动压缩');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });
