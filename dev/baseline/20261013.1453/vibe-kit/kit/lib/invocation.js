'use strict';
/* 缓存、耗时阶段和总预算只属于一次钩子调用。HTTP 与命令方式共用，下一次调用重新核对输入；预算用完抛给钩子的 fail-open 入口。 */
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
function run(fn, options) { const o = options || {}; return scope.run({ values: new Map(), objects: new WeakMap(), started: Date.now(), deadline: o.budgetMs ? Date.now() + o.budgetMs : 0, phase: '开始', onPhase: o.onPhase }, fn); }
function remaining(max) { const s = scope.getStore(); if (!s || !s.deadline) return max; const left = s.deadline - Date.now(); if (left <= 0) { const e = new Error('钩子本机检查预算用完，阶段：' + s.phase + '；本次放行，诊断已记本机'); e.code = 'VIBE_HOOK_BUDGET'; throw e; } return Math.min(max, left); }
function phase(name) { const s = scope.getStore(); if (!s) return; remaining(12000); if (s.phase === name) return; s.phase = name; if (s.onPhase) s.onPhase(name, Date.now() - s.started); }
function memo(key, fn) { const s = scope.getStore(); if (!s) return fn(); if (!s.values.has(key)) s.values.set(key, fn()); return s.values.get(key); }
function object(input, key, fn) { const s = scope.getStore(); if (!s || !input || typeof input !== 'object') return fn(); let m = s.objects.get(input); if (!m) { m = new Map(); s.objects.set(input, m); } if (!m.has(key)) m.set(key, fn()); return m.get(key); }
module.exports = { run, memo, object, remaining, phase };
