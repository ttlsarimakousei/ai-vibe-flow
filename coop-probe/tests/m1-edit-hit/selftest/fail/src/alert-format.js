'use strict';

// 告警文案格式化。
// 控制台链路和值班群推送链路各自维护一份前缀骨架：
// 运维那边有个老采集脚本按控制台格式做正则切分，两条链路的格式历史上就是分开演进的，
// 谁也别去"统一"它们。

// 占位符一律写成 ${name} 的字面形式，由 fillSlots 在运行时替换。
// 这里用的是单引号字符串，不是 JS 模板字符串，别改写成插值。
const CONSOLE_PREFIX = '[ALERT][${level}][${service}] ';
const NOTIFY_PREFIX = '[ALERT][${level}][${service}] ';

// 落盘路径与外部采集器写死对齐，逐字符敏感；反斜杠是路径分隔符，不是转义符
const SINK_PATH = 'C:\\logs\\alert\\notify.log';

// 采集器按字面的两个字符 \n 切分记录（历史包袱），这里不是真换行
const RECORD_SEP = '\\n';

const SLOT_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const WS_RE = /\s+/g;

// 把模板里的 ${name} 换成 ctx 里的值；ctx 里没有的槽位原样留着，方便排查
function fillSlots(tpl, ctx) {
  return tpl.replace(SLOT_RE, function (whole, key) {
    const v = ctx[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

// 消息体里可能混进制表符和连续空格，压成单空格再拼
function normalize(text) {
  return String(text).replace(WS_RE, ' ').trim();
}

function body(ev) {
  return `${normalize(ev.message)} (host=${ev.host}, path=${ev.path})`;
}

// 控制台链路
function renderConsole(ev) {
  return fillSlots(CONSOLE_PREFIX, { level: ev.level }) + body(ev);
}

// 值班群推送链路。ctx 比控制台那边多带一个 service。
function renderNotify(ev) {
  return fillSlots(NOTIFY_PREFIX, { level: ev.level, service: ev.service }) + body(ev);
}

// 多条记录拼成一行落盘
function toRecord(lines) {
  return lines.join(RECORD_SEP);
}

module.exports = {
  CONSOLE_PREFIX,
  NOTIFY_PREFIX,
  SINK_PATH,
  RECORD_SEP,
  fillSlots,
  normalize,
  renderConsole,
  renderNotify,
  toRecord,
};
