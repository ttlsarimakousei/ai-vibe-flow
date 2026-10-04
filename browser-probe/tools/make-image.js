'use strict';
/*
 * 生成"图片能力"测试素材：assets/probe-image.png + 标准答案 assets/probe-image.answer.txt
 * 在外网准备阶段运行一次即可（内网不需要重新生成）。
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browser');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:"Microsoft YaHei","Segoe UI",Arial,sans-serif}
#box{width:420px;height:280px;padding:24px;box-sizing:border-box}
.row{display:flex}
.sq{width:80px;height:80px;margin-right:24px;border-radius:6px}
.num{font-size:56px;font-weight:bold;margin-top:20px;color:#222}
.txt{font-size:22px;color:#444;margin-top:6px}
</style></head><body><div id="box">
<div class="row"><div class="sq" style="background:#e53935"></div><div class="sq" style="background:#43a047"></div><div class="sq" style="background:#1e88e5"></div></div>
<div class="num">42</div><div class="txt">内网体检</div>
</div></body></html>`;

(async () => {
  const { browser, via } = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 420, height: 280 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.locator('#box').screenshot({ path: path.join(OUT, 'probe-image.png') });
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'probe-image.answer.txt'), '标准答案：图中有 3 个色块，从左到右依次是 红色、绿色、蓝色；数字是 42；汉字是「内网体检」。\n');
  console.log('已生成 assets/probe-image.png（浏览器：' + via + '）');
})().catch((e) => { console.error('生成失败：' + (e && e.message || e)); process.exit(1); });
