'use strict';
/*
 * 像素比对：实际截图 vs 设计稿截图 → diff 百分比 + 差异区域 + 命中的布局树节点。
 * 依赖 pngjs + pixelmatch（已随包离线携带），不需要联网。
 *
 * 命令行：node tools/pixel-diff.js <actual.png> <ref.png> [--out diff.png] [--tree layout.json] [--threshold 0.1]
 * 模块：diffPng(actual, ref, opts) / attribute(clusters, tree) / toText(result)
 */
const fs = require('fs');
const { PNG } = require('pngjs');

function cropTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, 0, 0, w, h, 0, 0);
  return out;
}

async function diffPng(actualPath, refPath, opts) {
  opts = opts || {};
  const pixelmatch = (await import('pixelmatch')).default;
  const a0 = PNG.sync.read(fs.readFileSync(actualPath));
  const b0 = PNG.sync.read(fs.readFileSync(refPath));
  const w = Math.min(a0.width, b0.width);
  const h = Math.min(a0.height, b0.height);
  const sizeMismatch = (a0.width !== b0.width || a0.height !== b0.height) ? { actual: [a0.width, a0.height], ref: [b0.width, b0.height] } : null;
  const a = cropTo(a0, w, h);
  const b = cropTo(b0, w, h);
  const out = new PNG({ width: w, height: h });
  const threshold = opts.threshold == null ? 0.1 : opts.threshold;
  const diffPixels = pixelmatch(a.data, b.data, out.data, w, h, { threshold, includeAA: false, diffColor: [255, 0, 0], alpha: 0.3 });
  if (opts.outPath) fs.writeFileSync(opts.outPath, PNG.sync.write(out));
  const clusters = clusterize(out, w, h, opts.cell || 40);
  return { ok: true, ratio: diffPixels / (w * h), diffPixels, total: w * h, width: w, height: h, sizeMismatch, clusters, diffImage: opts.outPath || null };
}

/** 把差异像素按 cell×cell 网格聚合，再把相邻非空格子合并成区域 */
function clusterize(out, w, h, cell) {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const grid = new Int32Array(cols * rows);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) grid[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  const visited = new Uint8Array(cols * rows);
  const clusters = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (visited[k] || grid[k] === 0) continue;
      let minR = r, maxR = r, minC = c, maxC = c, sum = 0;
      const stack = [k];
      visited[k] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cr = Math.floor(cur / cols), cc = cur % cols;
        sum += grid[cur];
        if (cr < minR) minR = cr; if (cr > maxR) maxR = cr; if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
        const nb = [[cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]];
        for (const [nr, nc] of nb) {
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const nk = nr * cols + nc;
          if (!visited[nk] && grid[nk] > 0) { visited[nk] = 1; stack.push(nk); }
        }
      }
      clusters.push({ x: minC * cell, y: minR * cell, w: Math.min(w, (maxC + 1) * cell) - minC * cell, h: Math.min(h, (maxR + 1) * cell) - minR * cell, pixels: sum });
    }
  }
  clusters.sort((p, q) => q.pixels - p.pixels);
  return clusters.slice(0, 8);
}

/**
 * 差异区域 → 命中的布局树节点。
 * 先取"包含区域中心、面积最小"的前 3 个；区域中心落在空白处时，退回到"与区域相交"的节点，
 * 位置尺寸有变化的节点（opts.moved，来自布局树比对）优先，其次面积小的优先，并标记 overlap。
 */
function attribute(clusters, tree, opts) {
  const moved = (opts && opts.moved) || new Set();
  const area = (n) => n.w * n.h;
  const intersects = (n, c) => n.x < c.x + c.w && n.x + n.w > c.x && n.y < c.y + c.h && n.y + n.h > c.y;
  return clusters.map((c) => {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let hits = tree
      .filter((n) => cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h)
      .sort((p, q) => area(p) - area(q))
      .slice(0, 3)
      .map((n) => ({ p: n.p, comp: n.comp || '', txt: n.txt }));
    let overlap = false;
    if (!hits.length) {
      overlap = true;
      hits = tree
        .filter((n) => intersects(n, c))
        .sort((p, q) => ((moved.has(q.p) ? 1 : 0) - (moved.has(p.p) ? 1 : 0)) || (area(p) - area(q)))
        .slice(0, 3)
        .map((n) => ({ p: n.p, comp: n.comp || '', txt: n.txt, moved: moved.has(n.p) }));
    }
    return Object.assign({}, c, { hits, overlap });
  });
}

function toText(res) {
  const lines = [];
  lines.push('像素差异 ' + (res.ratio * 100).toFixed(2) + '%（' + res.diffPixels + ' / ' + res.total + ' 像素，' + res.width + 'x' + res.height + '）' + (res.sizeMismatch ? '  注意：两图尺寸不一致 ' + JSON.stringify(res.sizeMismatch) + '，已按公共区域比较' : ''));
  if (res.clusters.length) {
    lines.push('差异区域（按差异像素数排序）：');
    res.clusters.forEach((c, i) => {
      let hit = '';
      if (c.hits && c.hits.length) {
        hit = (c.overlap ? '  中心落在空白处，相交节点 ' : '  命中 ') + c.hits.map((h) => h.p + (h.comp ? ' 〔' + h.comp + '〕' : '') + (h.txt ? ' "' + h.txt + '"' : '') + (h.moved ? '（位置或尺寸有变化）' : '')).join(' ; ');
      } else {
        hit = '  没有命中任何节点（空白区域）';
      }
      lines.push('  ' + (i + 1) + '. 区域 x=' + c.x + ' y=' + c.y + ' ' + c.w + 'x' + c.h + '  差异像素 ' + c.pixels + hit);
    });
  } else {
    lines.push('没有差异区域');
  }
  return lines.join('\n');
}

/**
 * 在已保存的 PNG 上涂遮罩（默认品红）。用来替代 Playwright 截图的 mask 选项：
 * 那个选项要往页面注入一段高亮脚本，在 Chromium 92 这类老浏览器上会报 "object is not extensible"；自己画就不挑浏览器。
 * rects：[{x, y, w, h}]，坐标与截图像素一致（deviceScaleFactor=1 时即 CSS 像素）。
 */
function paintRects(pngPath, rects, color) {
  color = color || [255, 0, 255];
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let painted = 0;
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.w)), y1 = Math.min(png.height, Math.ceil(r.y + r.h));
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]; png.data[i + 3] = 255;
      }
    }
    painted++;
  }
  fs.writeFileSync(pngPath, PNG.sync.write(png));
  return painted;
}

module.exports = { diffPng, attribute, toText, paintRects };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const pos = argv.filter((a) => !a.startsWith('--'));
    const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
    if (pos.length < 2) { console.error('用法：node tools/pixel-diff.js <actual.png> <ref.png> [--out diff.png] [--tree layout.json] [--threshold 0.1]'); process.exit(2); }
    const res = await diffPng(pos[0], pos[1], { outPath: opt('out'), threshold: parseFloat(opt('threshold', '0.1')) });
    const treePath = opt('tree');
    if (treePath) res.clusters = attribute(res.clusters, JSON.parse(fs.readFileSync(treePath, 'utf8')));
    console.log(toText(res));
    console.log('RESULT ' + JSON.stringify({ ratio: res.ratio, diffPixels: res.diffPixels, clusters: res.clusters }));
  })().catch((e) => { console.error('比对失败：' + (e && e.message || e)); process.exit(1); });
}
