(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var preview = q.get('preview') === '1';
  var view = document.getElementById('view');
  var title = document.getElementById('pageTitle');
  var toast = document.getElementById('toast');
  var links = document.querySelectorAll('.nav a');

  function api(path, opts) {
    var url = path;
    if (preview) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'preview=1';
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) {
        location.href = '/login.html' + location.search;
        throw new Error('未登录');
      }
      return r.json();
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.hidden = true; }, 3000);
  }

  function setActive(route) {
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-route') === route) links[i].classList.add('active');
      else links[i].classList.remove('active');
    }
  }

  function card(label, n) {
    return '<div class="card"><div class="card-num">' + n + '</div><div class="card-label">' + label + '</div></div>';
  }

  var routes = {
    home: function () {
      title.textContent = '首页';
      view.innerHTML = '<div class="cards">' + card('用户', 5) + card('订单', 4) + card('待办', 2) + '</div>' +
        '<p class="tip">这是一个用于浏览器验证体检的演示站点，数据都是假的。</p>';
    },
    users: function () {
      title.textContent = '用户管理';
      view.innerHTML = '<div class="toolbar"><button type="button" class="btn btn-primary" id="addUserBtn">新增用户</button></div>' +
        '<table class="table" id="userTable"><thead><tr><th>ID</th><th>姓名</th><th>部门</th><th>角色</th><th>状态</th></tr></thead><tbody></tbody></table>';
      return api('/api/users').then(function (j) {
        var tb = view.querySelector('#userTable tbody');
        tb.innerHTML = j.list.map(function (u) {
          var tag = u.status === '启用' ? 'tag-on' : 'tag-off';
          return '<tr><td>' + u.id + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.dept) + '</td><td>' + esc(u.role) +
            '</td><td><span class="tag ' + tag + '">' + esc(u.status) + '</span></td></tr>';
        }).join('');
        document.getElementById('addUserBtn').addEventListener('click', function () { showToast('演示站不支持新增用户'); });
      });
    },
    orders: function () {
      title.textContent = '订单管理';
      view.innerHTML = '<div class="toolbar"><button type="button" class="btn btn-primary" id="exportBtn">导出</button></div>' +
        '<table class="table" id="orderTable"><thead><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th></tr></thead><tbody></tbody></table>';
      return api('/api/orders').then(function (j) {
        var tb = view.querySelector('#orderTable tbody');
        tb.innerHTML = j.list.map(function (o) {
          return '<tr><td>' + esc(o.no) + '</td><td>' + esc(o.customer) + '</td><td>' + esc(o.amount) + '</td><td>' + esc(o.status) + '</td></tr>';
        }).join('');
        document.getElementById('exportBtn').addEventListener('click', function () {
          api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { showToast(r.msg); });
        });
      });
    },
    settings: function () {
      title.textContent = '系统设置';
      view.innerHTML = '<form class="form" id="settingsForm">' +
        '<label><input type="checkbox" id="notify" checked> 开启通知</label>' +
        '<label>主题 <select id="theme"><option>浅色</option><option>深色</option></select></label>' +
        '<button type="button" class="btn" id="saveBtn">保存</button>' +
        '</form>' +
        '<p class="tip">本页会故意触发 1 条 console.error、1 个未捕获异常和 1 个 404 请求，用于测试错误捕获能力。</p>';
      document.getElementById('saveBtn').addEventListener('click', function () { showToast('已保存'); });
      console.error('设置页 console.error 示例：配置项 foo 缺失');
      fetch('/api/missing' + (preview ? '?preview=1' : ''), { credentials: 'same-origin' }).catch(function () {});
      setTimeout(function () { throw new Error('设置页故意抛出的未捕获错误'); }, 0);
    }
  };

  function render() {
    var route = (location.hash || '#home').slice(1);
    if (!routes[route]) route = 'home';
    setActive(route);
    var r = routes[route]();
    document.title = '内网体检演示站 - ' + title.textContent;
    return r;
  }

  window.addEventListener('hashchange', render);
  api('/api/me').then(function (j) {
    document.getElementById('who').textContent = '当前用户：' + j.user;
    render();
  });
})();
