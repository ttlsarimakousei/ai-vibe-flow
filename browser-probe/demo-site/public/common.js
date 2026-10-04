(function (w) {
  'use strict';
  var q = new URLSearchParams(location.search);
  var preview = q.get('preview') === '1';

  function api(path, opts) {
    var url = path;
    if (preview) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'preview=1';
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) {
        w.top.location.href = '/login.html' + location.search;
        throw new Error('未登录');
      }
      return r.json();
    });
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var toastEl = null;
  var timer = null;
  function toast(text, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { toastEl.hidden = true; }, ms || 3000);
  }
  function $(id) { return document.getElementById(id); }

  w.Probe = { api: api, post: post, esc: esc, toast: toast, preview: preview, $: $ };
})(window);
