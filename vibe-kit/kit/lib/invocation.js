'use strict';
/*
 * 缓存、耗时阶段和总预算只属于一次钩子调用。HTTP 与命令方式共用，下一次调用重新核对输入；预算用完抛给钩子的 fail-open 入口。
 * 预算用完时错误上带着这一次的用时（e.timeline：各阶段从第几秒开始、最慢的几条 git 各用了多久），问题反馈原样带上去（问题表第 83 条，2026-11-11：
 * 以前只写停在哪个阶段，慢在哪要那台电脑上跑 doctor.js 才知道，没人会去跑）。只有阶段名（带仓库的目录名）和秒数
 */
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
function run(fn, options) { const o = options || {}; return scope.run({ values: new Map(), objects: new WeakMap(), started: Date.now(), budget: o.budgetMs || 0, deadline: o.budgetMs ? Date.now() + o.budgetMs : 0, phase: '开始', phases: [['开始', 0]], calls: [], onPhase: o.onPhase }, fn); }
const secs = (ms) => (Math.round(ms / 100) / 10) + ' 秒';
/** 这一次到现在的用时，一段话 */
function timelineOf(s) {
  const total = Date.now() - s.started;
  const ph = s.phases.slice(-25).map(([n, at], i, a) => n + ' ' + secs(((a[i + 1] || [])[1] === undefined ? total : a[i + 1][1]) - at));
  const slow = s.calls.slice().sort((a, b) => b.ms - a.ms).slice(0, 6).map((c) => c.label + ' ' + secs(c.ms) + (c.failed ? '（没跑完）' : ''));
  return '预算 ' + secs(s.budget) + '，用了 ' + secs(total) + '。各阶段：' + ph.join('、') + (s.phases.length > 25 ? '（只列最后 25 段）' : '') + (slow.length ? '。最慢的命令：' + slow.join('、') + '；一共跑了 ' + s.calls.length + ' 条' : '');
}
function overBudget(s) { const e = new Error('钩子本机检查预算用完，阶段：' + s.phase + '；本次放行，诊断已记本机'); e.code = 'VIBE_HOOK_BUDGET'; try { e.timeline = timelineOf(s); } catch (err) { /* 算不了不带 */ } if (!s.budgetNoted) { s.budgetNoted = true; try { require('./diag').note('钩子预算', s.phase, Date.now() - s.started); } catch (err) { /* 老版本没有 */ } } return e; }
function remaining(max) { const s = scope.getStore(); if (!s || !s.deadline) return max; const left = s.deadline - Date.now(); if (left <= 0) throw overBudget(s); return Math.min(max, left); }
/** 子进程按这次调用剩下的预算超时了：返回预算用完的错误（和 remaining 的一样）。不在钩子里（没有预算）返回 null */
function budgetError() { const s = scope.getStore(); return s && s.deadline ? overBudget(s) : null; }
function phase(name) { const s = scope.getStore(); if (!s) return; remaining(12000); if (s.phase === name) return; s.phase = name; if (s.phases.length < 400) s.phases.push([name, Date.now() - s.started]); if (s.onPhase) s.onPhase(name, Date.now() - s.started); }
/** 记一条子进程（git 这些）用了多久，预算用完时报最慢的几条 */
function note(label, ms, failed) { const s = scope.getStore(); if (!s || s.calls.length >= 400) return; s.calls.push({ label: String(label), ms: Math.max(0, Number(ms) || 0), failed: !!failed }); }
function memo(key, fn) { const s = scope.getStore(); if (!s) return fn(); if (!s.values.has(key)) s.values.set(key, fn()); return s.values.get(key); }
function object(input, key, fn) { const s = scope.getStore(); if (!s || !input || typeof input !== 'object') return fn(); let m = s.objects.get(input); if (!m) { m = new Map(); s.objects.set(input, m); } if (!m.has(key)) m.set(key, fn()); return m.get(key); }
/** 作废这次调用里以 prefix 开头的缓存（写了状态文件、改了开关之后） */
function forget(prefix) { const s = scope.getStore(); if (!s) return; for (const k of [...s.values.keys()]) if (String(k).startsWith(prefix)) s.values.delete(k); }
/** 在钩子里（有预算）：命令行工具（review.js 这些）里返回 false */
function inHook() { const s = scope.getStore(); return !!(s && s.deadline); }
module.exports = { run, memo, object, remaining, budgetError, phase, note, forget, inHook };
