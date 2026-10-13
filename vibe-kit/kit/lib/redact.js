'use strict';
/* 诊断脱敏契约：先精确秘密，再敏感字段，最后截断。普通模型正文不走此模块，避免改变正常内容。 */
const { StringDecoder } = require('string_decoder');
function text(value, secrets) {
  let s = String(value == null ? '' : value);
  for (const key of [...new Set((secrets || []).filter((x) => typeof x === 'string' && x.length > 0))].sort((a, b) => b.length - a.length)) s = s.split(key).join('***');
  return s.replace(/\b(Bearer|Basic|Token|Digest)(\s+)[A-Za-z0-9._~+/=-]{3,}/gi, '$1$2***')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***')
    .replace(/(["']?[\w.-]*(?:pass|pwd|secret|token|apikey|api[-_]key|access[-_]?key|private[-_]?key|credential|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;,'"}]+)/gi, '$1***')
    .replace(/((?:密码|口令|秘钥|密钥|令牌)\s*(?:是|为|[:：=])\s*)\S+/g, '$1***')
    .replace(/(\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1***@')
    .replace(/\b(sk|ak|ghp|glpat)([-_])[A-Za-z0-9]{12,}\b/g, '$1$2***')
    .replace(/(\b(?:JSESSIONID|SESSION|SESSIONID|sid)=)[^;\s&]+/gi, '$1***');
}
// 审查材料只遮字面值；支持 JSON 字段与字符串内的转义引号，保留 token = validate(input) 等待审逻辑。
function material(value) {
  return String(value).replace(/(\b(?:password|passwd|pwd|secret|token|api[-_]?key|authorization)\b["']?\s*[:=]\s*)(["'])((?:\\[^\r\n]|(?!\2)[^\\\r\n])*)\2/gi, '$1$2***$2')
    .replace(/\b(sk|ak|ghp|glpat)([-_])[A-Za-z0-9]{12,}\b/g, '$1$2***')
    .replace(/(\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1***@');
}
function clip(value, n, secrets) { const s = text(value, secrets); return s.length > n ? s.slice(0, n) + '…' : s; }
// 仅保留经过模式核验的非秘密元数据；同名字段塞入任意字符串仍遮盖。
function publicOption(key, value) {
  if (key === 'kitBypass') return ['ask', 'auto', 'off'].includes(value);
  if (key === 'sshToken') return ['auto', 'off'].includes(value);
  if (key === 'tokenSource') return ['', 'manual', 'ssh'].includes(value);
  if (key === 'tokenExpires') return value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (key === 'tokenMasked') return value === '' || value === '****' || /^[A-Za-z0-9_-]{6}…[A-Za-z0-9_-]{4}$/.test(value);
  return false;
}
function tree(value, secrets) {
  if (Array.isArray(value)) return value.map((v) => tree(v, secrets));
  if (value && typeof value === 'object') { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = /pass(?:word)?|secret|token|api[-_]?key|authorization|cookie/i.test(k) && !publicOption(k, v) && (typeof v === 'string' || /(?:password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie)$/i.test(k)) ? '***' : tree(v, secrets); return out; }
  return typeof value === 'string' ? text(value, secrets) : value;
}
function errorBody(body, secrets) { try { return JSON.stringify(tree(JSON.parse(String(body)), secrets)); } catch (e) { return text(body, secrets); } }
function sse(secretsOf, write) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const emit = (frame) => {
    const data = frame.split(/\r?\n/).filter((l) => /^data:/.test(l)).map((l) => l.slice(5).trimStart()).join('\n');
    let error = /^event:\s*error\s*$/im.test(frame);
    try { error = error || JSON.parse(data).type === 'error'; } catch (e) { /* 普通事件原样转发 */ }
    if (!error) return write(frame);
    let done = false;
    write(frame.replace(/^data:.*(?:\r?\n|$)/gm, (line) => { if (done) return ''; done = true; return 'data: ' + errorBody(data, secretsOf()) + (line.endsWith('\n') ? '\n' : ''); }));
  };
  const drain = () => { let m; while ((m = /\r?\n\r?\n/.exec(pending))) { const end = m.index + m[0].length; emit(pending.slice(0, end)); pending = pending.slice(end); } if (pending.length > 2 * 1024 * 1024) throw new Error('流事件超过本机处理上限'); };
  return { feed(b) { pending += decoder.write(b); drain(); }, end() { pending += decoder.end(); drain(); if (pending) emit(pending); pending = ''; } };
}
module.exports = { text, material, clip, tree, errorBody, sse };
