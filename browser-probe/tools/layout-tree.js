'use strict';
/*
 * 布局树：把页面上可见元素压成紧凑的文本（路径 / 文本 / 坐标尺寸 / 几项关键样式）。
 * 这是给"不能看图"的模型准备的眼睛：它读不了截图，但能读这份树，并且能和设计稿版本的树逐节点比对。
 */

/** 在页面内执行（会被 Playwright 序列化后注入页面，必须自包含，不能引用外部变量） */
function collectLayout(opts) {
  opts = opts || {};
  var maxNodes = opts.maxNodes || 200;
  var minArea = opts.minArea || 64;
  var root = opts.root ? document.querySelector(opts.root) : document.body;
  var out = [];
  if (!root) return out;
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1 };

  function pathOf(el) {
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      var tag = cur.tagName.toLowerCase();
      var seg = tag;
      if (cur.id) { parts.unshift(seg + '#' + cur.id); break; }
      var cls = (cur.className && typeof cur.className === 'string') ? cur.className.trim().split(/\s+/)[0] : '';
      if (cls) seg += '.' + cls;
      var parent = cur.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) if (parent.children[i].tagName === cur.tagName) same.push(parent.children[i]);
        if (same.length > 1) seg += ':nth(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join('>');
  }

  // 归因到组件：Vue 3 开发版在元素上挂了 __vueParentComponent，可以一路往上拿组件名；
  // 生产版没有这个引用，退而找祖先元素的 data-comp 属性。返回形如 "UsersView>UserTable>StatusTag[ElTag]"
  var SKIP_COMP = { RouterView: 1, RouterLink: 0, BaseTransition: 1, Transition: 1, TransitionGroup: 1, KeepAlive: 1, Suspense: 1, Teleport: 1, AsyncComponentWrapper: 1 };
  function compChain(el) {
    var customs = [];
    var nearestLib = '';
    var inst = el.__vueParentComponent;
    var guard = 0;
    while (inst && guard++ < 40) {
      var t = inst.type || {};
      var n = t.name || t.__name || t.displayName || '';
      if (n && !SKIP_COMP[n]) {
        if (/^El[A-Z]/.test(n)) { if (!nearestLib && !customs.length) nearestLib = n; }
        else if (customs.indexOf(n) < 0) customs.push(n);
      }
      if (customs.length >= 3) break;
      inst = inst.parent;
    }
    if (!customs.length) {
      var cur = el;
      while (cur && cur.nodeType === 1 && customs.length < 3) {
        var dc = cur.getAttribute && cur.getAttribute('data-comp');
        if (dc && customs.indexOf(dc) < 0) customs.push(dc);
        cur = cur.parentElement;
      }
    }
    if (!customs.length) return nearestLib ? '[' + nearestLib + ']' : '';
    return customs.reverse().join('>') + (nearestLib ? '[' + nearestLib + ']' : '');
  }

  function ownText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) t += n.nodeValue;
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && el.tagName === 'INPUT') t = el.value || el.placeholder || '';
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  var all = root.querySelectorAll('*');
  var list = [];
  if (root !== document.body) list.push(root);
  for (var k = 0; k < all.length; k++) list.push(all[k]);

  for (var i = 0; i < list.length && out.length < maxNodes; i++) {
    var el = list[i];
    if (SKIP[el.tagName]) continue;
    if (el.ownerSVGElement) continue; // svg 内部子元素不展开
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width * r.height < minArea) continue;
    var comp = '';
    try { comp = compChain(el); } catch (e) { comp = ''; }
    out.push({
      p: pathOf(el),
      pp: (el.parentElement && el.parentElement !== document.body) ? pathOf(el.parentElement) : '',
      tag: el.tagName.toLowerCase(),
      comp: comp,
      txt: ownText(el),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      st: { color: cs.color, bg: cs.backgroundColor, fs: cs.fontSize, pad: cs.padding }
    });
  }
  return out;
}

/** 两棵树按路径逐节点比对：位置尺寸差 > tol 像素、样式不同、缺失、多余 */
function layoutDiff(actual, ref, tol) {
  tol = tol == null ? 1 : tol;
  const byPath = {};
  ref.forEach((n) => { byPath[n.p] = n; });
  const seen = {};
  const rectDiffs = [];
  const styleDiffs = [];
  const extraInActual = [];
  actual.forEach((a) => {
    const b = byPath[a.p];
    if (!b) { extraInActual.push(a.p); return; }
    seen[a.p] = true;
    const d = [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h];
    if (d.some((v) => Math.abs(v) > tol)) {
      rectDiffs.push({ p: a.p, txt: a.txt, actual: [a.x, a.y, a.w, a.h], ref: [b.x, b.y, b.w, b.h], delta: d });
    }
    ['color', 'bg', 'fs', 'pad'].forEach((k) => {
      if (a.st[k] !== b.st[k]) styleDiffs.push({ p: a.p, comp: a.comp || '', txt: a.txt, prop: k, actual: a.st[k], ref: b.st[k] });
    });
  });
  const missingInActual = ref.filter((n) => !seen[n.p]).map((n) => n.p);
  const rectGroups = groupRectDiffs(rectDiffs, actual);
  const styleGroups = groupStyleDiffs(styleDiffs);
  return {
    summary: { compared: Object.keys(seen).length, rectDiffs: rectDiffs.length, rectGroups: rectGroups.length, styleDiffs: styleDiffs.length, styleGroups: styleGroups.length, missing: missingInActual.length, extra: extraInActual.length },
    rectGroups, styleGroups, rectDiffs, styleDiffs, missingInActual, extraInActual,
  };
}

function generalize(p) { return p.replace(/:nth\(\d+\)/g, ''); }

/**
 * 位置尺寸差异去噪 + 归组：
 *  1) 偏移量与父节点完全相同的节点 = 跟着父节点动，不是根因，去掉；
 *  2) 剩下的按"去掉序号的路径"归组（25 个单元格 = 1 组），每组记录各分量的取值范围。
 */
function groupRectDiffs(rectDiffs, actual) {
  const deltaByPath = {};
  rectDiffs.forEach((r) => { deltaByPath[r.p] = r.delta.join(','); });
  const ppByPath = {};
  (actual || []).forEach((n) => { ppByPath[n.p] = n.pp; });
  const groups = new Map();
  rectDiffs.forEach((r) => {
    const parentDelta = deltaByPath[ppByPath[r.p]];
    if (parentDelta && parentDelta === r.delta.join(',')) return;
    const key = generalize(r.p);
    if (!groups.has(key)) groups.set(key, { p: key, comp: (actual || []).filter((n) => n.p === r.p).map((n) => n.comp)[0] || '', count: 0, example: r, min: r.delta.slice(), max: r.delta.slice() });
    const g = groups.get(key);
    g.count++;
    for (let i = 0; i < 4; i++) { if (r.delta[i] < g.min[i]) g.min[i] = r.delta[i]; if (r.delta[i] > g.max[i]) g.max[i] = r.delta[i]; }
  });
  return Array.from(groups.values()).map((g) => Object.assign(g, { range: g.min.map((v, i) => (v === g.max[i] ? String(v) : v + '..' + g.max[i])) }));
}

/** 样式差异按"属性 + 实际值 + 设计值"归组 */
function groupStyleDiffs(styleDiffs) {
  const groups = new Map();
  styleDiffs.forEach((s) => {
    const key = s.prop + '|' + s.actual + '|' + s.ref;
    if (!groups.has(key)) groups.set(key, { prop: s.prop, actual: s.actual, ref: s.ref, count: 0, examples: [] });
    const g = groups.get(key);
    g.count++;
    if (g.examples.length < 2) g.examples.push(s.p + (s.comp ? ' 〔' + s.comp + '〕' : '') + (s.txt ? ' "' + s.txt + '"' : ''));
  });
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

function layoutToText(tree, maxLines) {
  maxLines = maxLines || 200;
  const hasComp = tree.some((n) => n.comp);
  const lines = tree.slice(0, maxLines).map((n) =>
    [n.p].concat(hasComp ? [n.comp || '-'] : []).concat([n.txt ? JSON.stringify(n.txt) : '-', n.x + ',' + n.y + ' ' + n.w + 'x' + n.h, n.st.color, n.st.bg, n.st.fs, 'pad ' + n.st.pad]).join(' | '));
  lines.unshift('路径 | ' + (hasComp ? '组件 | ' : '') + '自有文本 | x,y 宽x高 | 文字色 | 背景色 | 字号 | 内边距');
  if (tree.length > maxLines) lines.push('… 共 ' + tree.length + ' 个节点，已截断');
  return lines.join('\n');
}

const PROP_NAME = { color: '文字色', bg: '背景色', fs: '字号', pad: '内边距' };

function diffToText(d, limit) {
  limit = limit || 12;
  const lines = [];
  lines.push('比对节点 ' + d.summary.compared + ' 个：位置尺寸差异 ' + d.summary.rectDiffs + ' 处（去掉跟随父节点的偏移并归组后 ' + d.summary.rectGroups + ' 组），样式差异 ' + d.summary.styleDiffs + ' 处（归组后 ' + d.summary.styleGroups + ' 组），实际缺失 ' + d.summary.missing + ' 个，实际多余 ' + d.summary.extra + ' 个');
  if (d.rectGroups.length) {
    lines.push('');
    lines.push('位置尺寸差异（实际 - 设计，单位像素，格式 dx,dy,dw,dh；×N = 同类节点数，a..b = 取值范围）：');
    d.rectGroups.slice(0, limit).forEach((g) => {
      const r = g.example;
      lines.push('  ' + g.p + (g.comp ? ' 〔' + g.comp + '〕' : '') + (g.count > 1 ? ' ×' + g.count : '') + (r.txt && g.count === 1 ? ' "' + r.txt + '"' : '') + '  差 ' + g.range.join(',') + (g.count === 1 ? '  实际 ' + r.actual.join(',') + '  设计 ' + r.ref.join(',') : '  例如 ' + r.p + ' 实际 ' + r.actual.join(',') + ' 设计 ' + r.ref.join(',')));
    });
    if (d.rectGroups.length > limit) lines.push('  … 还有 ' + (d.rectGroups.length - limit) + ' 组');
  }
  if (d.styleGroups.length) {
    lines.push('');
    lines.push('样式差异（按属性和值归组）：');
    d.styleGroups.slice(0, limit).forEach((g) => lines.push('  ' + (PROP_NAME[g.prop] || g.prop) + '  实际 ' + g.actual + '  设计 ' + g.ref + '  ×' + g.count + '  例如 ' + g.examples.join(' ; ')));
    if (d.styleGroups.length > limit) lines.push('  … 还有 ' + (d.styleGroups.length - limit) + ' 组');
  }
  if (d.missingInActual.length) lines.push('', '设计稿有而实际缺失：' + d.missingInActual.slice(0, 10).join('，'));
  if (d.extraInActual.length) lines.push('', '实际多出的节点：' + d.extraInActual.slice(0, 10).join('，'));
  return lines.join('\n');
}

module.exports = { collectLayout, layoutDiff, layoutToText, diffToText };
