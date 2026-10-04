(function () {
  'use strict';
  var P = window.Probe;
  var $ = P.$;
  var state = { q: '', page: 1, size: 10, pages: 1 };

  function load() {
    return P.api('/api/products?q=' + encodeURIComponent(state.q) + '&page=' + state.page + '&size=' + state.size).then(render);
  }
  function render(j) {
    state.pages = j.pages;
    state.page = j.page;
    var tb = $('productTable').querySelector('tbody');
    tb.innerHTML = j.list.map(function (p) {
      return '<tr><td>' + p.id + '</td><td>' + P.esc(p.name) + '</td><td>' + P.esc(p.category) + '</td><td>' + p.price + '</td><td>' + p.stock +
        '</td><td><button type="button" class="btn btn-sm del-btn" data-id="' + p.id + '" data-name="' + P.esc(p.name) + '">删除</button></td></tr>';
    }).join('');
    $('total').textContent = '共 ' + j.total + ' 条';
    var html = '';
    for (var i = 1; i <= j.pages; i++) html += '<button type="button" class="btn btn-sm page-btn' + (i === j.page ? ' active' : '') + '" data-page="' + i + '">' + i + '</button> ';
    $('pages').innerHTML = html;
    $('pageInfo').textContent = '第 ' + j.page + ' / ' + j.pages + ' 页';
    $('prevBtn').disabled = j.page <= 1;
    $('nextBtn').disabled = j.page >= j.pages;
  }

  $('searchBtn').addEventListener('click', function () { state.q = $('q').value.trim(); state.page = 1; load(); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('searchBtn').click(); } });
  $('prevBtn').addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
  $('nextBtn').addEventListener('click', function () { if (state.page < state.pages) { state.page++; load(); } });
  $('pages').addEventListener('click', function (e) {
    var b = e.target.closest('.page-btn');
    if (b) { state.page = parseInt(b.getAttribute('data-page'), 10); load(); }
  });

  function openModal() {
    ['pName', 'pPrice', 'pStock'].forEach(function (id) { $(id).value = ''; });
    $('modalErr').textContent = '';
    $('modal').hidden = false;
    $('pName').focus();
  }
  function closeModal() { $('modal').hidden = true; }
  $('addBtn').addEventListener('click', openModal);
  $('cancelBtn').addEventListener('click', closeModal);
  $('saveBtn').addEventListener('click', function () {
    var name = $('pName').value.trim();
    var price = $('pPrice').value.trim();
    if (!name) { $('modalErr').textContent = '名称不能为空'; return; }
    if (price !== '' && isNaN(Number(price))) { $('modalErr').textContent = '价格必须是数字'; return; }
    P.post('/api/products', { name: name, category: $('pCat').value, price: price, stock: $('pStock').value.trim() }).then(function (j) {
      if (!j.ok) { $('modalErr').textContent = j.msg || '保存失败'; return; }
      closeModal();
      state.q = ''; $('q').value = ''; state.page = 1;
      load().then(function () { P.toast('新增成功'); });
    });
  });

  $('productTable').addEventListener('click', function (e) {
    var b = e.target.closest('.del-btn');
    if (!b) return;
    var name = b.getAttribute('data-name');
    if (!window.confirm('确定删除「' + name + '」吗？')) return;
    P.post('/api/products/delete', { id: b.getAttribute('data-id') }).then(function (j) {
      if (!j.ok) { P.toast(j.msg || '删除失败'); return; }
      load().then(function () { P.toast('已删除'); });
    });
  });

  // 每次打开页面都重置数据，保证测试可重复
  P.post('/api/products/reset').then(load);
})();
