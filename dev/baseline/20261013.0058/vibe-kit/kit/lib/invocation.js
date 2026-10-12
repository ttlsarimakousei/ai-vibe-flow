'use strict';
/* 缓存只属于一次钩子调用。HTTP 工作线程同时处理多会话时也不共享解析结果；下一次调用重新核对输入。 */
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
function run(fn) { return scope.run({ values: new Map(), objects: new WeakMap() }, fn); }
function memo(key, fn) { const s = scope.getStore(); if (!s) return fn(); if (!s.values.has(key)) s.values.set(key, fn()); return s.values.get(key); }
function object(input, key, fn) { const s = scope.getStore(); if (!s || !input || typeof input !== 'object') return fn(); let m = s.objects.get(input); if (!m) { m = new Map(); s.objects.set(input, m); } if (!m.has(key)) m.set(key, fn()); return m.get(key); }
module.exports = { run, memo, object };
