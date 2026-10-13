'use strict';
/*
 * 用户动作的确定性判断。操作词只是话题，不等于许可；否定、延后、问题讨论和引用先排除。
 * 所有入口复用这里，解析不清时保持原阶段。只处理用户文本，不用模型推断用户是否同意。
 */
function plain(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => !/^\s*(>|\[vibe-kit)/.test(l)).join('\n').replace(/`[^`]*`/g, '').trim();
}
const TOPIC = {
  apply: '(?:apply\\b|开工|开干|开搞|开始(?:做|实现|开发|执行|写代码)|(?:按(?:照)?|照|依)(?:提案|任务|清单|方案)(?:做|实现|开发)|做吧|干吧|实现吧|执行吧)',
  commit: '(?:提交|commit\\b)', archive: '(?:归档|archive\\b)', push: '(?:推送|push\\b|推到远端)',
  reviewBudget: '(?:(?:重新开启|重开|重置|新开|再开|开启新的)[^，,。；;!?？\\n]{0,20}审查预算|重新审查)',
  handover: '(?:交接(?!记录|文档|说明)|handover\\b|(?:写|生成|更新|整理)(?:一份|个)?\\s*交接(?:记录|文档|说明))',
  accept: '(?:自测(?:通过|没问题|满意|好了)|验收(?:通过|没问题|满意))',
};
const PREFIX = '(?:(?:请|帮我|现在|直接|立即|及时|继续|顺便|可以|同意|确认|执行|开始|进行|再|然后|最后|接着)\\s*)*';
const NOUN = '(?:策略|机制|时机|规则|规范|逻辑|检查|权限|功能|提示|失败|报错|问题|日志|脚本|命令|配置|结果|状态|记录|成功|完成|被|测试|的|的时候|时|过|了|是不是|怎么样)';
function denied(text, action) {
  const op = TOPIC[action];
  if (!op) return true;
  const s = plain(text);
  const no = new RegExp('(?:先别|不要|不用|不能|不准|不必|无需|先不|暂不|暂时不|不急着|不着急|还不能|还不要|不可以|不让|不要再|取消)[^，,。；;！!\\n]{0,10}' + op + '|' + op + '[^，,。；;！!\\n]{0,12}(?:先缓缓|先别|不要|暂缓|先等|等一下|晚点|稍后|以后再说|等等|还没|之前|以前)|(?:是否|要不要|能不能|可不可以)[^，,。；;！!\\n]{0,6}' + op + '|' + op + '[^，,。；;！!\\n]{0,20}(?:[？?]|怎么|怎样|如何|什么|为什么|会不会|我自己|我来|留给我)', 'i');
  return no.test(s) || /^(?:暂停|先停|等等|等一下|取消)[\s，,。！!]/.test(s);
}
function explicit(text, action) {
  const s = plain(text);
  const op = TOPIC[action];
  if (!s || !op || denied(s, action)) return false;
  const direct = new RegExp('(?:^|[，,。；;\\n])\\s*(?:\\d+[.、]\\s*)?' + PREFIX + op + '(?!\\s*' + NOUN + ')', 'i');
  if (direct.test(s)) return true;
  if (action !== 'apply' && new RegExp('^(?:请)?(?:把|将)[^，,。；;！!?？\\n]{1,48}' + op + '(?:吧|一下|一次)?[\\s。！!]*$', 'i').test(s)) return true;
  if (action === 'push' && /(?:^|[，,。；;\n])\s*(?:请|帮我|现在|直接|可以|同意|确认|及时)*\s*提交\s*(?:并|和|后|然后|再)\s*(?:push\b|推送)(?!\s*(?:策略|机制|规则|功能|问题))/i.test(s)) return true;
  if (action === 'push' && /^(?:(?:请|现在|确认|同意|可以)\s*)*(?:合并\s*(?:push|推送)|(?:按(?:照)?|照)(?:这个|刚才的|上面的)?计划\s*(?:合并\s*)?(?:push|推送))[\s。！!]*$/i.test(s)) return true;
  // 常见收尾："改好了，提交"；"自测没问题，归档吧"；带前置修改的明确执行指令。
  const then = new RegExp('(?:然后|之后|以后|再|后|并且|并|和)\\s*' + op + '(?!\\s*' + NOUN + ')', 'i');
  if (then.test(s) && !/(?:解释|讲解|举例|讨论|听说|他说|你说|之前说|之前会)/.test(s)) return true;
  if (action === 'apply') {
    if (/\bapply\b.*(?:功能|流程|命令|机制|时候|阶段|怎么|是否)|(?:提案|需求|规格|设计|任务清单|验法).*(?:修改|调整|改一下|不对|讨论)/i.test(s)) return false;
    return /(?:把|将)?\s*(?:任务\s*)?(?:\d+\.\d+|第\s*\d+\s*项)[^，,。！!?？\n]{0,12}(?:做了|做完|实现|开发|打勾)|^(?:按照现在的方案修改|开始吧|可以开始了|可以(?:做|开工|实现)了)[\s。！!]*$/i.test(s);
  }
  return false;
}
module.exports = { plain, explicit, denied };
