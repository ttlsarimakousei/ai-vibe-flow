'use strict';
/* OpenSpec 仍保存唯一任务清单。显式标签区分自动可执行与需等待的工作，旧任务没有标签仍按原验法处理。 */
const fs = require('fs');
const path = require('path');
function kind(text) {
  const s = String(text).replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').replace(/^\s*\d+(?:\.\d+)*[.)、]?\s*/, '').trim();
  if (require('./session').isDeferredTask(s)) return 'deferred';
  if (/^\[用户验收\]|^(?:用户|人工|手动)(?:自测|验收)/.test(s)) return 'user';
  if (/^\[审查意见处理\]|^(?:处理|核实)(?:代码)?审查意见/.test(s)) return 'review-fix';
  if (/^\[代码审查\]|^(?:完成|执行)?(?:独立)?代码审查/.test(s)) return 'review';
  if (/^\[测试准备\]/.test(s)) return 'prepare';
  if (/^\[(?:测试|联合验证)\]/.test(s)) return 'test';
  return 'work';
}
function parse(text) { return String(text || '').split(/\r?\n/).filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l)).map((l) => ({ text: l.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim(), kind: kind(l), done: /^\s*[-*]\s*\[[xX]\]/.test(l) })); }
function tasks(dir) { try { return parse(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8')); } catch (e) { return []; } }
function readyForReview(dir) { const all = tasks(dir); const work = all.filter((t) => ['work', 'prepare', 'test'].includes(t.kind)); return work.length > 0 && work.every((t) => t.done); }
function automatedLeft(dir) { return tasks(dir).filter((t) => !t.done && !['user', 'deferred'].includes(t.kind)); }
function needs(text) { return []; }
function tickIssue(text, dir, j) {
  const k = kind(text); if (!['review', 'review-fix', 'user'].includes(k)) return null;
  const S = require('./session'); const r = S.reviewRecord('code', dir);
  if (k === 'review') return r && r.done && !r.partial && S.codeReviewed(dir) ? '' : '代码审查任务只在当前输入的完整结果返回后打勾；启动、超时、取消、过期和部分覆盖都不算完成。';
  if (k === 'review-fix') {
    if (!r || !r.done) return '先完成代码审查，再处理审查意见。';
    if (Number(r.issues) === 0 && S.codeReviewed(dir)) return '';
    if (r.resolved && r.resolvedFingerprint === require('./workspace').fingerprint(dir, 'code').hash) return '';
    return '审查意见逐条核实、修复或写明不成立依据，复验通过后用 review.js resolve 登记处理结果，再勾意见处理任务。';
  }
  const entries = j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : [];
  if (!S.userSaid(entries, 'accept').ok && !S.userSaid(entries, 'archive').ok) return '用户验收只能在用户明确说自测通过或同意归档后打勾；模型测试不能代替用户验收。';
  const action = S.userSaid(entries, 'archive').ok ? 'archive' : 'accept';
  const permit = require('./permissions').allow(j, action, dir);
  return permit.ok ? '' : permit.reason;
}
module.exports = { kind, parse, tasks, readyForReview, automatedLeft, needs, tickIssue };
