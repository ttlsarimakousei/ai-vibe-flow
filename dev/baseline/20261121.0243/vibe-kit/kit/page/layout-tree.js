'use strict';
/*
 * 布局树：把页面上可见元素压成紧凑的文本（路径 / 文本 / 坐标尺寸 / 几项关键样式）。
 * 这是给"不能看图"的模型准备的眼睛：它读不了截图，但能读这份树；和设计图比对时，像素差异落在哪几个节点上也靠它。
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

function layoutToText(tree, maxLines) {
  maxLines = maxLines || 200;
  const hasComp = tree.some((n) => n.comp);
  const lines = tree.slice(0, maxLines).map((n) =>
    [n.p].concat(hasComp ? [n.comp || '-'] : []).concat([n.txt ? JSON.stringify(n.txt) : '-', n.x + ',' + n.y + ' ' + n.w + 'x' + n.h, n.st.color, n.st.bg, n.st.fs, 'pad ' + n.st.pad]).join(' | '));
  lines.unshift('路径 | ' + (hasComp ? '组件 | ' : '') + '自有文本 | x,y 宽x高 | 文字色 | 背景色 | 字号 | 内边距');
  if (tree.length > maxLines) lines.push('… 共 ' + tree.length + ' 个节点，已截断');
  return lines.join('\n');
}

module.exports = { collectLayout, layoutToText };
