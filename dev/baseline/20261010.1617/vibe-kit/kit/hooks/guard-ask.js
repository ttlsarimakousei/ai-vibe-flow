'use strict';
/*
 * PreToolUse 钩子（AskUserQuestion、Skill、SlashCommand）。
 *   AskUserQuestion：全自动模式开着、这个会话又正走着 OpenSpec 流程时，不许用提问框问用户。
 *     提问框会一直等人回答，这时 Stop 钩子管不到，全自动挂一夜就停在那里。
 *     不在流程里（另开的窗口做检索、答问题）照常能问：那时候人在。开关每次现读，配置页里一改就生效。
 *   Skill / SlashCommand：模型自己调了 OpenSpec 的技能（用户用大白话让它出提案、接着做）——这个会话从这时起算进了 OpenSpec 流程，
 *     调 propose / explore / new 的算在写提案那一段（plan），调 archive / verify 的算在做任务那一段（apply）。只记一笔，不拦。
 *     调 /opsx:apply 的技能：用户还没说开工（不在流程里，或者还在写提案那一段）就拦下——提案、任务清单要他看过、他说了开工才做
 *     （用户 2026-10-07 定的，规矩见 lib/session.js"流程分两段"）。不能放行。
 */
const { readConfigFor, flowState, setFlow, FLOW_SKILL, blockOut, hookLog, cli, confirmApply } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

/** 还没到 apply：提案那一段要用户看过、说了开工才开始做任务 */
function applyGate(j) {
  hookLog('guard-ask block Skill opsx:apply（用户还没说开工）');
  try { require('../lib/feedback.js').countBlock('guard-apply', '[vibe-kit] 还没到 apply', String((j && j.session_id) || '')); } catch (e) { /* 数不了不影响 */ }
  return blockOut('PreToolUse', '[vibe-kit] 还没到 apply：提案、规格、设计、任务清单要我看过、我说了开工才开始做任务（全自动模式也只管 apply 之后）。现在把要点交代给我：改哪些地方、新加的操作和接口、任务清单；我原话里没提过、你自己加上的，单独列出来。然后用提问框问我能不能开工（选项写"开工"和"还要改"）。我说开工、或者我自己敲 /opsx:apply，再开始。');
}
function handle(j) {
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
          // 提问框的答案不触发 UserPromptSubmit，开工许可要在用技能前补读。
          if (confirmApply(j)) {
            st.stage = 'apply';
            const now = readConfigFor(j);
            out = { systemMessage: '[vibe-kit] 开始 apply：全自动模式' + (now.autoMode ? '开着，只管实现、验证和审查；提交照你选的档位。' : '关着。') };
          }
          if (!st.on || st.stage === 'plan') out = applyGate(j);
        } else if (/^(opsx:|openspec[-:])(archive|bulk-archive|verify|sync)\b/i.test(first)) {
          if (!st.on) setFlow(j, true, '调了 ' + first, 'apply');
        } else {
          // 探索、提案、建变更：进流程，在写提案那一段（已经在做任务的会话里再调 propose，也回到这一段：下一个变更的提案也要用户看）
          setFlow(j, true, '调了 ' + first, 'plan');
        }
        if (cfg.autoSwitch && !out) hookLog('全自动模式 这个会话调了 ' + first.slice(0, 40) + (st.on ? '' : '，进了 OpenSpec 流程') + (/^(opsx:|openspec[-:])(apply|archive|bulk-archive|verify|sync)\b/i.test(first) ? '' : '：在写提案那一段，照有人在的样子来'));
      }
      // 模型自己调交接的技能（提问框里选了"现在交接"、全自动到线自己写）：也数进"写交接记录"。用户自己敲 /ttls-handover 的在 task-anchor 里数
      if (/^(ttls-)?handover$/i.test(first)) { try { require('../lib/usage.js').bump('handover.write'); } catch (e) { /* 数不了就算了 */ } }
    } catch (e) { out = null; /* 记不了不影响调技能 */ }
    return out;
  }
  if (!readConfigFor(j).autoMode) return null;
  hookLog('guard-ask block AskUserQuestion (autoMode)');
  // 它想问什么记下来：进全自动报告，用户回来能看到
  try {
    const qs = (j && j.tool_input && j.tool_input.questions) || [];
    if (report) for (const q of Array.isArray(qs) ? qs : []) {
      const opts = Array.isArray(q && q.options) ? q.options.map((o) => String((o && (o.label || o.description)) || o || '')).filter(Boolean) : [];
      report.note(j, { kind: 'ask', title: String((q && (q.question || q.header)) || '（没写问题）'), detail: opts.join(' / ') });
    }
  } catch (e) { /* 记不了不影响 */ }
  try { require('../lib/feedback.js').countBlock('guard-ask', '[vibe-kit] 全自动模式：提问框没人答', String((j && j.session_id) || '')); } catch (e) { /* 数不了不影响 */ }
  return blockOut('PreToolUse', '[vibe-kit] 全自动模式：我不在，提问框没人答，活会停在这里。你想问的已经记进全自动报告，我回来会看到。现在自己定，然后接着做：能查的先查（代码、库、接口、日志、文档）；查不到的选推荐的、影响面最小的那个，记进 revisions.md（起因：自动模式决定）。要我动手的事（查库的工具不肯执行的改库操作、改 redis 里的数据、改公共配置、动 git 历史、push、要账号密码）：不做也不等，在那项任务后面加上"（留给用户：原因）"，不打勾，接着做不依赖它的。');
}

module.exports = { handle };
if (require.main === module) cli(handle);
