'use strict';
/*
 * K1-4、J2（2026-11-01，docs/feedback-20261101.md）：开关字段表 kit/lib/config-fields.js。
 *   默认值只有一份：钩子、配置页后端拿到的一样，每个默认值都过得了自己的取值检查
 *   字段表和配置页对得上：有控件的字段都有控件、在写着的那一页、取值和范围一样；页面上每个开关都在字段表里；手册的表和字段表一致
 *   清洗：合规的收、乱填的保持原值，每个字段都试一遍
 *   第 29—31 条：自动自测、自动验证页面、后台自动探索、门槛不做开关，审核到 10 轮就停，到交接线先写交接记录取消；升级时清一次，之后手写的还认
 *   J2：旧配置（五个开关）按原值显示成两项；两项写回四项；旧名字传进来还认；钩子读到的值照旧
 * 用法：node dev/test-config-fields.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const CF = require(path.join(H.SRC, 'kit', 'lib', 'config-fields.js'));
const S = require(path.join(H.SRC, 'kit', 'lib', 'session.js'));
const A = require(path.join(H.SRC, 'router', 'kit-api.js'));
const page = H.read(path.join(H.SRC, 'router', 'ui.html')) || '';
const all = CF.FIELDS.concat(CF.VIEW_FIELDS);

(async () => {
  H.section('默认值只有一份');
  {
    H.ok('钩子、配置页后端拿到的是同一份', S.DEFAULT_CONFIG === CF.DEFAULT_CONFIG && A.DEFAULT_CONFIG === CF.DEFAULT_CONFIG);
    H.ok('session、kit-api 里不再写默认值', !/const DEFAULT_CONFIG = \{/.test(H.read(path.join(H.SRC, 'kit', 'lib', 'session-config.js')) || '') && !/const DEFAULT_CONFIG = \{/.test(H.read(path.join(H.SRC, 'router', 'kit-api.js')) || ''));
    const names = all.map((f) => f.name);
    H.ok('名字不重复', new Set(names).size === names.length, names);
    const bad = all.filter((f) => CF.accept(f, f.def) !== f.def);
    H.ok('每个默认值都过得了自己的取值检查', bad.length === 0, bad.map((f) => f.name));
    const noDoc = all.filter((f) => !f.internal && !f.doc && !f.sameRow);
    H.ok('不是内部字段的都写了手册的一行', noDoc.length === 0, noDoc.map((f) => f.name));
    const noPage = all.filter((f) => !f.internal && !f.noControl && !f.page);
    H.ok('有控件的都写了在哪一页', noPage.length === 0, noPage.map((f) => f.name));
  }

  H.section('字段表和配置页对得上');
  {
    const tabs = [...page.matchAll(/<section id="tab-(\w+)"/g)].map((m) => ({ name: m[1], at: m.index }));
    const tabOf = (at) => { let t = ''; for (const x of tabs) if (x.at < at) t = x.name; return t; };
    const missing = []; const wrong = [];
    for (const f of all) {
      if (f.internal || f.noControl) continue;
      const i = page.indexOf('id="k_' + f.name + '"');
      if (i < 0) { missing.push(f.name); continue; }
      if (tabOf(i) !== f.page) wrong.push(f.name + ' 在 ' + tabOf(i) + '，字段表写 ' + f.page);
    }
    H.ok('该有控件的都有', missing.length === 0, missing);
    H.ok('都在字段表写的那一页', wrong.length === 0, wrong);
    const known = new Set(all.map((f) => f.name));
    // 页面上收进保存条的开关：fBool、fSel、fNum 登记的
    const reg = [...page.matchAll(/\bf(Bool|Sel|Num)\('(\w+)'(?:,\s*'[^']*')?(?:,\s*(\[[^\]]*\]|\d+))?(?:,\s*(\d+))?(?:,\s*(true))?\)/g)];
    H.ok('（认出了页面上的开关）', reg.length >= 28, reg.length);
    const extra = reg.filter((m) => !known.has(m[2])).map((m) => m[2]);
    H.ok('页面上每个开关都在字段表里', extra.length === 0, extra);
    const internal = reg.filter((m) => { const f = all.find((x) => x.name === m[2]); return f && (f.internal || f.noControl); }).map((m) => m[2]);
    H.ok('字段表写内部的、按钮写的，页面上没有控件', internal.length === 0, internal);
    const mismatch = [];
    for (const m of reg) {
      const f = all.find((x) => x.name === m[2]);
      if (!f) continue;
      if (m[1] === 'Bool' && f.type !== 'bool') mismatch.push(f.name + ' 类型');
      if (m[1] === 'Sel') { const vals = JSON.parse(m[3].replace(/'/g, '"')); if (JSON.stringify(vals.slice().sort()) !== JSON.stringify(f.values.slice().sort())) mismatch.push(f.name + ' 取值 ' + vals); }
      if (m[1] === 'Num' && (Number(m[3]) !== f.min || Number(m[4]) !== f.max || !!m[5] !== !!f.zero)) mismatch.push(f.name + ' 范围 ' + m[3] + '-' + m[4]);
    }
    H.ok('控件的取值、范围和字段表一样', mismatch.length === 0, mismatch);
    const reg2 = new Set(reg.map((m) => m[2]));
    const unreg = all.filter((f) => !f.internal && !f.noControl && !reg2.has(f.name)).map((f) => f.name);
    H.ok('该有控件的都登记进了保存条', unreg.length === 0, unreg);
    const r = require('child_process').spawnSync(process.execPath, [path.join(H.REPO, 'dev', 'config-doc.js'), '--check'], { encoding: 'utf8', windowsHide: true });
    H.ok('手册"开关一览"的表和字段表一致', r.status === 0, r.stdout);
  }

  H.section('清洗：合规的收、乱填的保持原值，每个字段都试一遍');
  {
    const bads = [];
    for (const f of CF.FIELDS) {
      const good = f.type === 'bool' ? !f.def : f.type === 'enum' ? f.values.find((v) => v !== f.def) : f.type === 'version' ? '20261101.0900' : (f.def === f.max ? f.min : f.max);
      const junk = f.type === 'bool' ? 'yes' : f.type === 'enum' ? '乱写的' : f.type === 'version' ? '乱写的' : 99999999;
      const c1 = A.cleanConfig({ [f.name]: good });
      // autoMode 跟着 autoApply 走，上下文那四项由视图连带：这几个单独测
      if (!['autoMode', 'autoApply'].includes(f.name) && c1[f.name] !== good) bads.push(f.name + ' 不收 ' + good + ' 得 ' + c1[f.name]);
      const c2 = A.cleanConfig({ [f.name]: junk }, { [f.name]: good });
      if (!['autoMode', 'autoApply'].includes(f.name) && c2[f.name] !== good) bads.push(f.name + ' 乱填后 ' + c2[f.name]);
    }
    H.ok('合规的收，乱填的保持原值', bads.length === 0, bads);
    H.ok('int 的边界：空串不当 0', A.cleanConfig({ tmpKeepDays: '' }).tmpKeepDays === CF.DEFAULT_CONFIG.tmpKeepDays && A.cleanConfig({ tmpKeepDays: 0 }).tmpKeepDays === 0);
    H.ok('带 zero 的能填 0，不带的不行', A.cleanConfig({ contextLimitTokens: 0 }).contextLimitTokens === 0 && A.cleanConfig({ reviewBudgetSeconds: 0 }).reviewBudgetSeconds === CF.DEFAULT_CONFIG.reviewBudgetSeconds);
    H.ok('小数取整', A.cleanConfig({ reviewBudgetSeconds: 77.6 }).reviewBudgetSeconds === 78);
    H.ok('hints、maintainerHosts 不写回去', !('hints' in A.cleanConfig({}, { hints: [] })) && !('maintainerHosts' in A.cleanConfig({}, { maintainerHosts: 'x' })));
    H.ok('autoMode 旧名还认', A.cleanConfig({ autoMode: true }).autoApply === true);
  }

  H.section('J2：旧配置按原值显示成两项');
  {
    const view = (old) => { const c = A.cleanConfig(old); return c.contextAction + ' ' + c.contextPercent; };
    H.ok('默认：自动压缩 70', view({}) === 'compact 70', view({}));
    H.ok('压缩线改过：自动压缩 85', view({ autoCompactPercent: 85 }) === 'compact 85');
    H.ok('压缩线填 0：不管', view({ autoCompactPercent: 0 }) === 'off 70');
    H.ok('按交接线提醒、不问：提醒一句', view({ contextStrategy: 'handover', handoverAsk: 'off', handoverPercent: 65, autoCompactPercent: 90 }) === 'remind 65');
    H.ok('按交接线提醒、问我：问我', view({ contextStrategy: 'handover', handoverAsk: 'ask', handoverPercent: 80 }) === 'ask 80');
    H.ok('自动压缩优先时，旧的"问我"不起作用，照旧', view({ contextStrategy: 'compact', handoverAsk: 'ask', handoverPercent: 50 }) === 'compact 70');
    const keep = A.cleanConfig({ contextStrategy: 'handover', handoverAsk: 'off', handoverPercent: 65, autoCompactPercent: 90 }, {});
    H.ok('没动这两项：文件里存的四项不变', keep.handoverPercent === 65 && keep.autoCompactPercent === 90 && keep.contextStrategy === 'handover' && keep.handoverAsk === 'off', keep);
  }

  H.section('J2：两项写回四项，保存时只改动过的');
  {
    const cur = A.cleanConfig({});
    const save = (inc, from) => A.cleanConfig(Object.assign({}, from || cur, inc), from || cur);
    const c = save({ contextAction: 'remind', contextPercent: 60 });
    H.ok('提醒一句 60：按交接线提醒、不问、压缩线 75', c.contextStrategy === 'handover' && c.handoverAsk === 'off' && c.handoverPercent === 60 && c.autoCompactPercent === 75 && c.contextAction === 'remind' && c.contextPercent === 60, c);
    const d = save({ contextAction: 'ask' }, c);
    H.ok('只改成问我：百分比不变，问', d.handoverAsk === 'ask' && d.handoverPercent === 60 && d.autoCompactPercent === 75 && d.contextAction === 'ask', d);
    const e = save({ contextAction: 'ask', contextPercent: 90 }, c);
    H.ok('压缩线封顶 95', e.autoCompactPercent === 95 && e.handoverPercent === 90, e);
    const f = save({ contextAction: 'compact', contextPercent: 40 });
    H.ok('自动压缩最低 50', f.autoCompactPercent === 50 && f.contextPercent === 50 && f.contextStrategy === 'compact', f);
    const g = save({ contextAction: 'off' });
    H.ok('不管：压缩线 0，再存一次不变', g.autoCompactPercent === 0 && g.contextAction === 'off' && save({}, g).autoCompactPercent === 0, g);
    const old = save({ autoCompactPercent: 0 });
    H.ok('旧名字传进来还认（老页面）', old.autoCompactPercent === 0 && old.contextAction === 'off', old);
    const other = save({ commitMode: 'ask' }, c);
    H.ok('改别的开关：这几项不动', other.handoverPercent === 60 && other.autoCompactPercent === 75 && other.contextStrategy === 'handover', other);
    const bad = save({ contextAction: '乱写的', contextPercent: 999 }, c);
    H.ok('乱填的不收', bad.contextAction === 'remind' && bad.contextPercent === 60, bad);
    const keepAuto = save({ contextAction: 'remind' }, Object.assign({}, cur, { autoHandover: true }));
    H.ok('文件里手写的 autoHandover 不被冲掉', keepAuto.autoHandover === true, keepAuto.autoHandover);
  }

  H.section('J2：钩子读到的值照旧，文件里的旧字段留着（装回旧版读得懂）');
  {
    const h = H.makeHome('tcf-hook');
    H.setConfig(h, A.cleanConfig({ contextAction: 'ask', contextPercent: 60 }));
    const read = JSON.parse(H.node(h, '-e', ['const c = require(' + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + ').readConfig(); console.log(JSON.stringify({ s: c.contextStrategy, a: c.handoverAsk, p: c.handoverPercent, w: c.autoCompactPercent }))'], { cwd: h.root }).out.trim());
    H.ok('钩子读到按交接线提醒、问、60、压缩线 75', read.s === 'handover' && read.a === 'ask' && read.p === 60 && read.w === 75, read);
    const file = JSON.parse(fs.readFileSync(path.join(h.kit, 'config.json'), 'utf8'));
    H.ok('文件里四个旧字段都在', file.contextStrategy === 'handover' && file.handoverAsk === 'ask' && file.handoverPercent === 60 && file.autoCompactPercent === 75, file);
    const line = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: '{}', cwd: h.root });
    H.ok('状态栏照常', line.code === 0, line.err);
  }

  H.section('第 29—31 条：不做开关的、固定的值');
  {
    const D = CF.DEFAULT_CONFIG;
    H.ok('默认：一直开、不写交接记录', D.autoVerify === true && D.autoSeePage === true && D.specGate === true && D.autoOnboard === true && D.autoHandover === false, D);
    const f = (n) => CF.FIELDS.find((x) => x.name === n);
    H.ok('都标了内部字段（配置页、手册的开关表都没有）', CF.FIXED.every((n) => f(n) && f(n).internal && !f(n).doc), CF.FIXED);
    H.ok('页面上这几个控件都没了', CF.FIXED.every((n) => !page.includes('id="k_' + n + '"')));
    H.ok('自动模式合成一节', !page.includes('data-sec="自动模式：需求"') && !page.includes('data-sec="自动模式：实施"') && page.includes('data-sec="自动模式"') && !page.includes('id="sec-onboard"'));
    const pkgA = H.makePackage('tcf-a', '20261101.0900');
    const pkgB = H.makePackage('tcf-b', '20261102.0900');
    const h = H.freshHome('tcf-up');
    const inst = (p) => H.node(h, path.join(p, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
    const cfgFile = path.join(h.kit, 'config.json');
    const a = inst(pkgA);
    H.ok('（装上了）', a.code === 0, a.out + a.err);
    const marker = path.join(h.kit, 'state', 'fixed-switch-migration.json');
    // 装成上一版留下的：以前存了关掉、改小，还没迁移过
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(cfgFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), { autoVerify: false, autoSeePage: false, specGate: false, autoOnboard: false, requirementsReviewMaxRounds: 3, applyReviewMaxRounds: 5, autoHandover: true, commitMode: 'ask', handoverPercent: 66 }), null, 2));
    const b = inst(pkgB);
    const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    H.ok('升级：以前存的清掉了', b.code === 0 && CF.FIXED.every((k) => !(k in c)), [b.err, c]);
    H.ok('升级：别的开关不动', c.commitMode === 'ask' && c.handoverPercent === 66, c);
    H.ok('记了只清一次', fs.existsSync(marker));
    const st = JSON.parse(H.node(h, '-e', ['const c = require(' + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + ').readConfig(); console.log(JSON.stringify({ v: c.autoVerify, g: c.specGate, r: c.applyReviewMaxRounds, h: c.autoHandover }))'], { cwd: h.root }).out.trim());
    H.ok('钩子读到的：一直开、不写交接记录', st.v === true && st.g === true && st.h === false, st);
    fs.writeFileSync(cfgFile, JSON.stringify(Object.assign(c, { autoVerify: false }), null, 2));
    inst(pkgB);
    H.ok('清过一次之后：手写的还认（排查用），再更新不动', JSON.parse(fs.readFileSync(cfgFile, 'utf8')).autoVerify === false);
    const md = (H.read(path.join(h.kit, 'hook-rules.md')) || '');
    H.ok('规范里不写次数上限', !/最多 10 轮/.test(md) && /没有 P1、P2 就算过/.test(md), md.slice(0, 200));
  }

  H.section('配置页：五项合成两项');
  {
    H.ok('新的两个控件在，旧的五个不在', /id="k_contextAction"/.test(page) && /id="k_contextPercent"/.test(page) && !/id="k_(contextStrategy|handoverPercent|autoCompactPercent|handoverAsk|autoHandover)"/.test(page));
    H.ok('说明写了四种选择和压缩线怎么算', /快满时怎么办/.test(page) && /问我要不要交接/.test(page) && /再过 15 个百分点/.test(page));
    H.ok('配置页不再提"全自动模式"这个没有了的开关（20261102.0255 的"保护"一节还写着）', !/全自动模式|全自动阶段/.test(page), (page.match(/.{20}全自动(模式|阶段).{10}/) || [])[0]);
    H.ok('"保护"一节只说前两项认配置页', /前两项只认在这个页面上改的/.test(page));
    H.ok('预览和套件算压缩线的办法一样', /Math\.min\(95, Math\.max\(50, line \+ 15\)\)/.test(page) && /Math\.min\(95, Math\.max\(50, p \+ 15\)\)/.test(H.read(path.join(H.SRC, 'kit', 'lib', 'config-fields.js')) || ''));
  }

  H.done('开关字段表和"快满时怎么办"');
})().catch((e) => { H.ok('测试脚本出错', false, e && e.stack); H.done('开关字段表和"快满时怎么办"'); });
