(function () {
  'use strict';
  var P = window.Probe;
  var $ = P.$;
  var dash = null;
  var refreshCount = 0;

  function panelHtml(key, t) {
    var cards = t.cards.map(function (c, i) {
      return '<div class="card"><div class="card-num" id="' + key + 'Card' + (i + 1) + '">' + P.esc(c[1]) + '</div><div class="card-label">' + P.esc(c[0]) + '</div></div>';
    }).join('');
    return '<section id="' + key + '" class="panel" role="tabpanel"' + (key === 'sales' ? '' : ' hidden') + '>' +
      '<div class="cards">' + cards + '</div>' +
      '<div class="chart-box"><canvas id="' + key + 'Chart" width="640" height="220" aria-label="' + P.esc(t.title) + '近 6 个月柱状图"></canvas></div>' +
      '<button type="button" class="btn btn-sm toggle" id="' + key + 'Toggle">详情</button>' +
      '<div class="detail" id="' + key + 'Detail" hidden><table class="table"><thead><tr><th>月份</th><th>数值（' + P.esc(t.unit) + '）</th></tr></thead><tbody>' +
      dash.months.map(function (m, i) { return '<tr><td>' + m + '</td><td>' + t.values[i] + '</td></tr>'; }).join('') +
      '</tbody></table></div></section>';
  }

  function drawChart(key, t) {
    var cv = $(key + 'Chart');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, padL = 40, padB = 30, padT = 20;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    var max = Math.max.apply(null, t.values);
    var n = t.values.length;
    var slot = (W - padL - 10) / n;
    var barW = slot * 0.5;
    ctx.strokeStyle = '#e4e7ed';
    ctx.beginPath(); ctx.moveTo(padL, H - padB); ctx.lineTo(W - 10, H - padB); ctx.stroke();
    ctx.font = '12px "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    for (var i = 0; i < n; i++) {
      var h = Math.round((t.values[i] / max) * (H - padB - padT));
      var x = padL + i * slot + (slot - barW) / 2;
      var y = H - padB - h;
      ctx.fillStyle = t.values[i] === max ? '#1f5fd6' : '#7aa5f0';
      ctx.fillRect(x, y, barW, h);
      ctx.fillStyle = '#303133';
      ctx.fillText(String(t.values[i]), x + barW / 2, y - 5);
      ctx.fillStyle = '#606266';
      ctx.fillText(dash.months[i], x + barW / 2, H - padB + 16);
    }
  }

  function activate(key) {
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === key); });
    document.querySelectorAll('.panel').forEach(function (s) { s.hidden = (s.id !== key); });
    drawChart(key, dash.tabs[key]);
  }

  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (b) activate(b.getAttribute('data-tab'));
  });
  $('panels').addEventListener('click', function (e) {
    var b = e.target.closest('.toggle');
    if (!b) return;
    var d = $(b.id.replace('Toggle', 'Detail'));
    d.hidden = !d.hidden;
    b.textContent = d.hidden ? '详情' : '收起';
  });
  $('refreshBtn').addEventListener('click', function () {
    refreshCount++;
    $('refreshCount').textContent = '已刷新 ' + refreshCount + ' 次';
    var d = new Date();
    $('refreshTime').textContent = '最后刷新 ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    var key = document.querySelector('.tab.active').getAttribute('data-tab');
    drawChart(key, dash.tabs[key]);
    P.toast('数据已刷新');
  });

  P.api('/api/dash').then(function (j) {
    dash = j;
    $('panels').innerHTML = Object.keys(j.tabs).map(function (k) { return panelHtml(k, j.tabs[k]); }).join('');
    activate('sales');
  });
})();
