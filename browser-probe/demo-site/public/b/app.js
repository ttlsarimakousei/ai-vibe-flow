(function () {
  'use strict';
  var P = window.Probe;
  var $ = P.$;
  var data = {};

  function show(n) {
    ['step1', 'step2', 'step3', 'done'].forEach(function (id, i) { $(id).hidden = (i !== n - 1); });
    [1, 2, 3].forEach(function (i) { $('s' + i).classList.toggle('active', i === Math.min(n, 3)); });
  }
  function validate1() {
    var name = $('name').value.trim();
    if (!name) return '供应商名称不能为空';
    if (!$('type').value) return '请选择供应商类型';
    var r = document.querySelector('input[name=region]:checked');
    if (!r) return '请选择地区';
    var email = $('email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '邮箱格式不正确';
    data.name = name; data.type = $('type').value; data.region = r.value; data.email = email;
    return '';
  }
  function validate2() {
    var c = $('contact').value.trim();
    if (!c) return '联系人不能为空';
    var p = $('phone').value.trim();
    if (!/^\d{11}$/.test(p)) return '电话必须是 11 位数字';
    data.contact = c; data.phone = p; data.remark = $('remark').value.trim(); data.enabled = $('enabled').checked;
    return '';
  }
  function renderConfirm() {
    var rows = [['供应商名称', data.name], ['类型', data.type], ['地区', data.region], ['邮箱', data.email], ['联系人', data.contact], ['电话', data.phone], ['备注', data.remark || '（无）'], ['启用', data.enabled ? '是' : '否']];
    $('confirm').querySelector('tbody').innerHTML = rows.map(function (r) { return '<tr><th>' + r[0] + '</th><td>' + P.esc(r[1]) + '</td></tr>'; }).join('');
  }

  $('next1').addEventListener('click', function () { var e = validate1(); $('err1').textContent = e; if (!e) show(2); });
  $('prev2').addEventListener('click', function () { show(1); });
  $('next2').addEventListener('click', function () { var e = validate2(); $('err2').textContent = e; if (!e) { renderConfirm(); show(3); } });
  $('prev3').addEventListener('click', function () { show(2); });
  $('submit').addEventListener('click', function () {
    $('submit').disabled = true;
    P.post('/api/suppliers', data).then(function (j) {
      if (j.ok) {
        $('code').textContent = j.code;
        $('doneName').textContent = j.name;
        show(4);
        P.toast('提交成功');
      } else {
        P.toast(j.msg || '提交失败');
        $('submit').disabled = false;
      }
    });
  });

  P.api('/api/me').then(function () { show(1); });
})();
