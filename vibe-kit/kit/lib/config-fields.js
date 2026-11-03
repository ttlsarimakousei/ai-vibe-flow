'use strict';
/*
 * 开关字段表（K1-4，2026-11-01）：config.json 里每个开关只在这里定义一次。
 *   lib/session-config.js 的 DEFAULT_CONFIG、ui/kit-api.js 的默认值和 cleanConfig、手册"开关一览"的表都从这里来；
 *   手册的表由 dev/config-doc.js 生成，配置页的说明和控件是手写的，dev/test-config-fields.js 核对（名字、取值范围、在哪一页）。
 *
 * 字段：name 名字；type 类型（bool、enum、int、version）；def 默认；values 取值（enum）；min、max 范围（int）；zero 除了范围还能填 0（int）；
 *       page 在配置页哪一页（按钮写的、没有控件的 noControl: true）；doc、since、defText 手册里的一行；sameRow 和那个字段写在手册同一行；
 *       internal 不是给人调的（配置页、手册都没有）。
 *
 * "快满时怎么办"（J2，用户 2026-10-30 定的）：配置页上 contextAction + contextPercent 两项。
 *   钩子、状态栏照旧读 contextStrategy、handoverAsk、handoverPercent、autoCompactPercent，这四个是文件里实际存的，所以旧配置不用迁移、
 *   自动更新装回旧版也读得懂。两个新项只是这四个的另一种说法：读的时候算出来（contextView），保存时写回去（contextFromView）。
 *
 * 不做开关的（问题表第 29—31 条，用户 2026-11-02 定的，internal）：自动自测、自动验证页面、后台自动探索、提案打勾归档的门槛一直开；
 * 审查次数、文件数不设上限（2026-11-03 取消，用户定的）；到交接线先写交接记录取消（默认 false）。配置页、手册的开关表都没有。升级时清掉文件里以前存的（install.js），文件里手写的还认，给排查和测试用。
 *
 * 只用 Node 自带的模块；不依赖 session。
 */
// 不做开关、升级时从 config.json 里清掉的（问题表第 29—31 条）
const FIXED = ['autoVerify', 'autoSeePage', 'specGate', 'autoOnboard', 'autoHandover'];
// 不再有的开关（审查次数、文件数、方式，用户 2026-11-03 定的）：字段表里没有了，升级时也从 config.json 里清掉
const REMOVED = ['requirementsReviewMaxRounds', 'applyReviewMaxRounds', 'reviewLoop', 'reviewMaxRounds', 'reviewExecutor', 'reviewMaxFiles', 'statusUsage', 'hookTransport'];
const FIELDS = [
  { name: 'autoVerify', type: 'bool', def: true, internal: true },
  { name: 'autoSeePage', type: 'bool', def: true, internal: true },
  { name: 'autoCrossReview', type: 'bool', def: true, internal: true },
  { name: 'commitCheck', type: 'bool', def: true, page: 'kit', doc: '提交不合规范 → 拦下（本版起不再查像密码的内容）', since: '最早就有', defText: '开' },
  { name: 'specGate', type: 'bool', def: true, internal: true },
  { name: 'tmpKeepDays', type: 'int', def: 7, min: 0, max: 90, page: 'kit', doc: '过程文件多少天没动就清', since: '0924 中午', defText: '7 天' },
  { name: 'autoMode', type: 'bool', def: false, internal: true },
  { name: 'autoRequirements', type: 'bool', def: false, internal: true },
  { name: 'autoApply', type: 'bool', def: false, internal: true },
  { name: 'reviewLenses', type: 'int', def: 3, min: 1, max: 3, internal: true },
  { name: 'autoHandover', type: 'bool', def: false, internal: true },
  { name: 'kitLock', type: 'bool', def: true, page: 'kit', doc: '禁止 Claude 自己改套件', since: '0923', defText: '开' },
  { name: 'kitBypass', type: 'enum', def: 'ask', values: ['ask', 'auto', 'off'], page: 'kit', doc: '被检查拦住、它又确信是套件拦错了（自动模式下不用点，选"不许放行"的除外）', since: '0924.1848', defText: '要我点同意' },
  { name: 'contextLimitTokens', type: 'int', def: 1000000, min: 50000, max: 10000000, zero: true, page: 'kit', doc: '上下文上限 contextLimitTokens', since: '0921', defText: '100 万 token' },
  { name: 'handoverPercent', type: 'int', def: 70, min: 30, max: 95, internal: true },
  { name: 'handoverAsk', type: 'enum', def: 'off', values: ['ask', 'off'], internal: true },
  { name: 'contextStrategy', type: 'enum', def: 'compact', values: ['compact', 'handover'], internal: true },
  { name: 'autoCompactPercent', type: 'int', def: 70, min: 50, max: 95, zero: true, internal: true },
  { name: 'commitMode', type: 'enum', def: 'off', values: ['off', 'ask', 'auto'], page: 'kit', doc: '提交方式 commitMode（关 / 询问 / 自动，人工和自动都用；替代以前的"自动提交档位"和"不走 OpenSpec 的改动"）', since: '1017', defText: '关' },
  { name: 'lessons', type: 'enum', def: 'on', values: ['on', 'collect', 'off'], page: 'lessons', doc: '经验规则（开 / 只收集 / 关）', since: '0928', defText: '开' },
  { name: 'lessonThreshold', type: 'int', def: 2, min: 1, max: 5, page: 'lessons', doc: '同一条在几个不同的变更里出现才变成规则；一种文件类型最多几条；一条最多多少字', since: '0928', defText: '2 次、10 条、120 字' },
  { name: 'lessonMaxPerGroup', type: 'int', def: 10, min: 3, max: 30, page: 'lessons', sameRow: 'lessonThreshold' },
  { name: 'lessonMaxChars', type: 'int', def: 120, min: 40, max: 300, page: 'lessons', sameRow: 'lessonThreshold' },
  { name: 'lessonPromote', type: 'enum', def: 'ask', values: ['ask', 'auto'], page: 'lessons', doc: '升成用户级（要我点 / 自动）', since: '0928', defText: '要我点' },
  { name: 'autoMemory', type: 'enum', def: 'off', values: ['off', 'on'], page: 'lessons', doc: 'Claude Code 自带的"自动记忆"（关掉 / 不管它）', since: '0928', defText: '关掉' },
  { name: 'autoUpdate', type: 'enum', def: 'auto', values: ['auto', 'notify', 'off'], page: 'remote', doc: '发现新版之后（自动装上 / 只提醒 / 不检查）；几小时检查一次', since: '0928 晚上', defText: '自动装上、2 小时' },
  { name: 'updateCheckHours', type: 'int', def: 2, min: 1, max: 24, page: 'remote', sameRow: 'autoUpdate' },
  { name: 'updateEarly', type: 'bool', def: false, page: 'remote', doc: '先装新版（尝鲜）updateEarly：勾了一发现新版就装，不勾等发布满 24 小时、尝鲜组没报问题再装', since: '本版', defText: '不勾' },
  { name: 'updatePin', type: 'version', def: '', noControl: true, doc: '固定在这一版 updatePin：什么版本都不自动装；跳过这一版 updateSkip：仓库里是这一版时不自动装（都是配置页的按钮）', since: '本版', defText: '没固定、没跳过' },
  { name: 'updateSkip', type: 'version', def: '', noControl: true, sameRow: 'updatePin' },
  { name: 'issueUpload', type: 'enum', def: 'on', values: ['on', 'off'], page: 'remote', doc: '问题上报（开 / 关）', since: '0928 晚上', defText: '开' },
  { name: 'sshToken', type: 'enum', def: 'auto', values: ['auto', 'off'], page: 'remote', doc: '没填令牌的时候（用 SSH 申请一个 / 不申请）', since: '0928 晚上', defText: '用 SSH 申请' },
  { name: 'autoOnboard', type: 'bool', def: true, internal: true },
  { name: 'lessonAuto', type: 'bool', def: true, page: 'lessons', doc: '审查报的问题自动收', since: '0930', defText: '开' },
  { name: 'dbcrudDaemon', type: 'bool', def: false, page: 'data', doc: '查库的后台执行器；多久没人用就退出', since: '0930', defText: '关、5 分钟' },
  { name: 'dbcrudDaemonIdleMinutes', type: 'int', def: 5, min: 1, max: 60, page: 'data', sameRow: 'dbcrudDaemon' },
  { name: 'usageReport', type: 'enum', def: 'on', values: ['on', 'off'], page: 'remote', doc: '使用情况上报（开 / 关）', since: '1001', defText: '开' },
  { name: 'perfReport', type: 'enum', def: 'on', values: ['on', 'local', 'off'], page: 'remote', doc: '耗时异常上报 perfReport（上报 / 只记本机 / 关）', since: '2026-10-31 那一版', defText: '上报' },
  { name: 'ccAutoMode', type: 'enum', def: 'off', values: ['off', 'on'], page: 'kit', doc: 'Claude Code 自带的"自动模式"（关掉 / 不管它）', since: '1005', defText: '关掉' },
  { name: 'reviewBudgetSeconds', type: 'int', def: 300, min: 10, max: 1800, page: 'kit', doc: '审查预期用时 reviewBudgetSeconds（1028 这一版起不截断，超了自动记问题反馈；以前叫"审查总预算"）', since: '1017', defText: '300 秒' },
];
// 配置页上有、文件里不存的两项（J2）：说明写在手册里，取值在这里
const VIEW_FIELDS = [
  { name: 'contextAction', type: 'enum', def: 'compact', values: ['compact', 'remind', 'ask', 'off'], page: 'kit', doc: '上下文快满时怎么办 contextAction（自动压缩 / 提醒一句 / 问我要不要交接 / 不管）、到百分之多少 contextPercent。替代以前的连续工作的方式、交接线、自动压缩线、到了交接线之后', since: '本版', defText: '自动压缩、70%' },
  { name: 'contextPercent', type: 'int', def: 70, min: 30, max: 95, page: 'kit', sameRow: 'contextAction' },
];
const DEFAULT_CONFIG = {};
for (const f of FIELDS) DEFAULT_CONFIG[f.name] = f.def;

const blank = (v) => v === undefined || v === null || v === '';
/** 这个值这个字段收不收。收的话返回规范后的值，不收返回 undefined */
function accept(f, v) {
  if (f.type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (f.type === 'enum') return f.values.includes(v) ? v : undefined;
  if (f.type === 'version') return typeof v === 'string' && (v === '' || /^\d{8}\.\d{4}$/.test(v)) ? v : undefined;
  if (blank(v)) return undefined;
  const n = Number(v);
  return (f.zero && n === 0) || (n >= f.min && n <= f.max) ? Math.round(n) : undefined;
}
/** 把 x 里合规的字段写进 c，乱填的不动 */
function applyFields(c, x) {
  if (!x) return c;
  for (const f of FIELDS) { const v = accept(f, x[f.name]); if (v !== undefined) c[f.name] = v; }
  return c;
}
/** 配置页上的两项：从文件里存的四项算出来 */
function contextView(c) {
  const line = Number(c.handoverPercent) || 70;
  if (c.contextStrategy === 'handover') return { contextAction: c.handoverAsk === 'ask' ? 'ask' : 'remind', contextPercent: line };
  const acp = c.autoCompactPercent === undefined ? 70 : Number(c.autoCompactPercent);
  return acp === 0 ? { contextAction: 'off', contextPercent: line } : { contextAction: 'compact', contextPercent: acp };
}
/**
 * 配置页的两项写回文件里存的四项。自动压缩最低 50（再低 Claude Code 压缩得太勤）；
 * 提醒、问我的时候压缩线比这个百分比高 15（封顶 95），这样先提醒、再压缩
 */
function contextFromView(action, percent) {
  const p = Math.round(Number(percent)) || 70;
  if (action === 'compact') { const a = Math.max(50, p); return { contextStrategy: 'compact', autoCompactPercent: a, handoverPercent: a, handoverAsk: 'off' }; }
  if (action === 'off') return { contextStrategy: 'compact', autoCompactPercent: 0, handoverPercent: p, handoverAsk: 'off' };
  return { contextStrategy: 'handover', handoverPercent: p, handoverAsk: action === 'ask' ? 'ask' : 'off', autoCompactPercent: Math.min(95, Math.max(50, p + 15)) };
}

module.exports = { FIXED, REMOVED, FIELDS, VIEW_FIELDS, DEFAULT_CONFIG, accept, applyFields, contextView, contextFromView };
