'use strict';
/*
 * PreToolUse 钩子（AskUserQuestion、Skill、SlashCommand）。
 *   AskUserQuestion：始终允许；人工动作、需求疑问、自动审查到限都需要用户选择。
 *   Skill / SlashCommand：模型自己调了 OpenSpec 的技能（用户用大白话让它出提案、接着做）——这个会话从这时起算进了 OpenSpec 流程，
 *     调 propose / explore / new 回到提案阶段；archive / verify 不授予 apply。交接技能需要当前用户明确要求。
 *     调 /opsx:apply 的技能：用户还没说开工（不在流程里，或者还在写提案那一段）就拦下——提案、任务清单要他看过、他说了开工才做
 *     双自动满足探索、逐点审修、定稿提交条件时允许衔接，其余情况需要真人开工许可。
 */
const { readConfigFor, flowState, setFlow, FLOW_SKILL, blockOut, hookLog, cli, confirmApply } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

/** 还没到 apply：提案那一段要用户看过、说了开工才开始做任务 */
function applyGate(j) {
  // 用户说了开工、却没认下来（#214：有几个变更、没点名）：说出原因，不再只说"用户还没说开工"
  let why = '';
  try { why = require('../lib/apply-scope').refusal(j); } catch (e) { why = ''; }
  hookLog('guard-ask block Skill opsx:apply（' + (why ? '开工没认下来：' + why.slice(0, 60) : '用户还没说开工') + '）');
  try { require('../lib/feedback.js').countBlock('guard-apply', '[vibe-kit] 还没到 apply', String((j && j.session_id) || '')); } catch (e) { /* 数不了不影响 */ }
  if (why) return blockOut('PreToolUse', '[vibe-kit] 还没到 apply：用户说了开工，但' + why + '。调 /opsx:apply 时参数写上变更名也行（/opsx:apply <变更名>）。');
  return blockOut('PreToolUse', '[vibe-kit] 还没到 apply：当前尚未满足双自动衔接条件，也没有用户开工许可。现在把要点交代给我：改哪些地方、新加的操作和接口、任务清单；我原话里没提过、你自己加上的，单独列出来。然后用提问框问能不能开工（选项写"开工""还要改""先不做"）。我说开工、或者我自己敲 /vk-go（或 /opsx:apply），再开始。');
}
function handle(j) {
  const manual = require('../lib/flow-policy').actionIssue(j);
  if (manual) return blockOut('PreToolUse', '[vibe-kit] ' + manual);
  if (/^(Skill|SlashCommand)$/.test(String((j && j.tool_name) || ''))) {
    let out = null;
    try {
      const inp = j.tool_input || {};
      const name = String(inp.skill || inp.command || inp.name || '');
      const first = name.trim().split(/\s+/)[0].replace(/^\//, '');
      if (FLOW_SKILL.test(name)) {
        const st = flowState(j);
        const cfg = readConfigFor(j);
        if (/^(opsx:|openspec[-:])apply\b/i.test(first)) {
          // 提问框的答案不触发 UserPromptSubmit，开工许可要在用技能前补读。技能参数里写了变更名的，用它认开哪个
          if (confirmApply(j, { args: name.trim().split(/\s+/).slice(1).join(' ') + ' ' + String(inp.args || '') }) || require('../lib/flow-policy').automaticApply(j)) {
            st.stage = 'apply';
            const now = readConfigFor(j);
            out = { systemMessage: '[vibe-kit] 开始 apply：全自动模式' + (now.autoMode ? '开着，只管实现、验证和审查；提交照你选的提交方式。' : '关着。') };
          }
          if (!st.on || st.stage === 'plan') out = applyGate(j);
        } else if (/^(opsx:|openspec[-:])(archive|bulk-archive|verify|sync)\b/i.test(first)) {
          if (!st.on) setFlow(j, true, '调了 ' + first, 'plan');
        } else {
          // 探索、提案、建变更：进流程，在写提案那一段（已经在做任务的会话里再调 propose，也回到这一段：下一个变更的提案也要用户看）
          setFlow(j, true, '调了 ' + first, 'plan');
        }
        if (cfg.autoSwitch && !out) hookLog('全自动模式 这个会话调了 ' + first.slice(0, 40) + (st.on ? '' : '，进了 OpenSpec 流程') + (/^(opsx:|openspec[-:])(apply|archive|bulk-archive|verify|sync)\b/i.test(first) ? '' : '：在写提案那一段，照有人在的样子来'));
      }
      // 技能和直接写文件共用手动交接判断，不能靠模型自己调用技能获得许可。
      if (/^(ttls-)?handover$/i.test(first)) {
        if (!require('../lib/session').canWriteHandover(j)) return blockOut('PreToolUse', '[vibe-kit] 当前用户没有要求交接。连续工作用自动压缩，接着处理当前任务；不要自行写交接或 clear。用户明确说交接或执行 /ttls-handover 后再写。');
        try { require('../lib/usage.js').bump('handover.write'); } catch (e) { /* 数不了就算了 */ } }
    } catch (e) { out = null; /* 记不了不影响调技能 */ }
    return out;
  }
  // 自动阶段仍允许 Ask 澄清需求本身的疑问。做法上的取舍按用户 2026-10-30 定的自己定、记进 revisions.md（开工、收工的提示里说，这里不拦提问框）。
  return null;
}

module.exports = { handle };
if (require.main === module) cli(handle);
