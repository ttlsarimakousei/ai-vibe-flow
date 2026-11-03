'use strict';
/*
 * 状态文件：读、写、改（state/ 下），流水账 hooks.log，可清和长期保留的名单，套件目录 KIT，路径比较 normKey。最底层，别的 session-*.js 都依赖它。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const stateStore = require('./state-store');

const KIT = path.join(__dirname, '..');

/** 同步地等一小会儿（重试写文件用）；主线程和工作线程里都能用 */
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 等不了就不等 */ } }

// 小状态：~/.claude/vibe-kit/state/<名字>.json。按会话的（<会话>.json、<会话>-xxx.json）过几天就清；全局的（审查记录、网关实测这些）不按时间清。
// 写一律先写临时文件再改名（原子写）：好几个钩子进程会同时读写同一个文件，直接覆盖写会让别人读到半截、再把空对象写回去冲掉记录。
const safeId = (id) => String(id || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 80);

/**
 * 状态文件在哪（K1-3，2026-11-01，审核 M14）：名字以 Claude Code 的会话号开头的（<会话号>、<会话号>-flow、<会话号>-auto-switch……），
 * 放 state/session/<会话号>/<后缀>.json（只有会话号的叫 context.json），一个会话一个目录，清理按目录算；别的（跨会话的、缓存、迁移标记）
 * 照旧在 state/ 下，很多地方（查库、redis 的脚本，状态栏）按这个路径直接读，不挪。
 * 升级前就开着的会话：旧位置（state/<会话号>-xxx.json）有文件、新位置没有，就接着用旧位置（仓库主人 11-01 定的"旧文件留一版"，装回旧版时还读得到）
 */
const SESSION_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(.+))?$/i;
const flatFile = (name) => path.join(KIT, 'state', safeId(name) + '.json');
function sessionFileOf(name) { const m = SESSION_NAME.exec(String(name || '')); return m ? path.join(KIT, 'state', 'session', m[1].toLowerCase(), safeId(m[2] || 'context') + '.json') : ''; }
const stateFile = (name) => { const s = sessionFileOf(name); if (!s) return flatFile(name); try { if (!fs.existsSync(s) && fs.existsSync(flatFile(name))) return flatFile(name); } catch (e) { /* 照新位置 */ } return s; };

/** 读状态。文件不存在返回 {}；存在但读不懂（别人正在写）重试几次，还不行也返回 {}（只读的地方够用；要写回的用 updateState） */
/**
 * 一次钩子调用里同一个状态文件只读一次（2026-11-01，K 批 M13：以前一次调用把 flow、配置封条、审查记录这些读好几遍）。
 * 给出去的是副本，调用方改了不影响缓存；这次调用里写了它就作废。不在钩子调用里（工具、测试直接调）照旧每次读
 */
const inv = () => require('./invocation');
const copy = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
function readState(name) {
  return copy(inv().memo('state|' + name, () => stateStore.read(stateFile(name))));
}
/** 写了这个状态：作废它的缓存；会话自动开关、配置封条变了，读配置的缓存也作废 */
function forgetState(name) { try { const I = inv(); if (!I.forget) return; I.forget('state|' + name); if (name === 'config-seal' || /-auto-switch$/.test(name)) I.forget('config|'); } catch (e) { /* 老版本没有 */ } }

function writeState(name, obj) {
  forgetState(name);
  const r = stateStore.write(stateFile(name), obj);
  forgetState(name);
  return r;
}

/**
 * 读-改-写：fn 收到当前内容（对象），改完返回（或者直接改传进去的对象）。
 * 文件存在但读不懂：刚写完不久（别人可能正在写）就放弃这次写，免得把别人的记录冲掉；
 * 已经好一会儿没人动过、还是读不懂的，是坏掉了（杀毒软件、磁盘满、手改）：改名留一份（<名字>.bad），从空的重新记。
 * 不然全局的记录（审查过没有）一坏就再也写不进去，归档、打勾一直被拦成"还没审过"。
 * 返回写进去的对象；放弃了、写不进去（杀毒软件占着文件）时返回 null
 */
function updateState(name, fn) {
  const r = stateStore.update(stateFile(name), fn, hookLog);
  forgetState(name);
  return r;
}

/** 钩子的流水账（state/hooks.log）：什么时候跑的、看到了什么、做了什么。出问题时看这个，不用猜 */
function hookLog(line) {
  try {
    const d = path.join(KIT, 'state'); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'hooks.log');
    try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.1'); } catch (e) { /* 还没有 */ }
    fs.appendFileSync(f, new Date().toLocaleString('zh-CN', { hour12: false }) + ' ' + require('./redact').text(line) + '\n');
  } catch (e) { /* 记不了就算了 */ }
}

/** 全局记录：跨会话要用的，不按文件时间删（条目自己 60 天后清） */
const GLOBAL_STATE = /^(big-task|auto-session-migration|fixed-switch-migration|install-done|welcome|diag|perf-baseline|perf-report|reviewed|reviewed-proposal|task-ticks|block-stats|config-audit|tool-stats|tool-usage-pos|old-skills|onboard-fail|plan-hint|plan-unlisted|gateway|handover-consumed|artifact-cache|hook-stats|changes-cache|anchor-scan|tidy-hint|config-seal|kit-hash|kit-drift|lesson-commit|update|issues|issues-dirty|issues-exported|archived-seen|usage|usage-sync|usage-device|pull|evidence|review-jobs|review-points|workflow-v2-migration|review-waivers|work-baselines|work-sessions|readiness|devserver|defaults-1017-migration)\.json$|^hooks\.log/;

/**
 * 可以按文件时间清掉的固定名字（去重缓存、限时的放行、近期的拦截、节流、日志）：清了只是少一次去重或从头再记。
 * 新加一个固定名字的状态文件，要么进上面的 GLOBAL_STATE，要么进这里（dev/test-auto-mode-kept.js 会扫代码查）。
 * 20261030 以前迁移标记 defaults-1017-migration 两边都不在，3 天后被当成会话文件删掉，之后每次更新都把用户的开关改回默认（审核 P01）
 */
const DISPOSABLE_STATE = ['bypass', 'blocks', 'active-sessions', 'tool-flow', 'onboard-kick', 'onboard.log', 'tool-usage.jsonl', 'lessons.lock', 'voice-pos', 'config-page'];

/** 全局记录里的一条是什么时候记的：数字就是时间，对象看 at */
const entryAt = (v) => (typeof v === 'number' ? v : (v && typeof v === 'object' && Number(v.at)) || 0);

/**
 * 每种状态多久清（K1-3，Codex 改进路线第 4 节的"目录说明"）：新加一个固定名字的状态要落进下面一类（dev/test-auto-mode-kept.js 扫代码查）。
 *   会话        state/session/<会话号>/：目录里最新的文件过了天数（cleanState 的 days）整个删
 *   跨会话      GLOBAL_STATE 里的：不按文件时间删，条目自己 60 天清（见 cleanState 末尾）
 *   迁移标记    GLOBAL_STATE 里 *-migration 的：永远不删（删了每次更新都会重做一遍迁移，审核 P01）
 *   缓存        DISPOSABLE_STATE 里的：按文件时间删，清了只是少一次去重或从头再记
 *   别的        升级前留下的按会话的旧文件（state/<会话号>-xxx.json）：按文件时间删
 */
const STATE_KINDS = [
  { kind: '会话', where: 'state/session/<会话号>/', clean: '目录里最新的文件过了天数整个删' },
  { kind: '跨会话', where: 'state/<名字>.json（GLOBAL_STATE）', clean: '不按文件时间删，条目 60 天清' },
  { kind: '迁移标记', where: 'state/<名字>-migration.json（GLOBAL_STATE）', clean: '不删' },
  { kind: '缓存', where: 'state/<名字>（DISPOSABLE_STATE）', clean: '按文件时间删' },
];
function stateKindOf(name) { const n = String(name || ''); if (SESSION_NAME.test(n)) return '会话'; if (/-migration$/.test(n) && GLOBAL_STATE.test(n + '.json')) return '迁移标记'; if (GLOBAL_STATE.test(n + '.json')) return '跨会话'; if (DISPOSABLE_STATE.includes(n)) return '缓存'; return ''; }
function cleanState(days) {
  try {
    const d = path.join(KIT, 'state');
    const dead = Date.now() - days * 86400000;
    // 会话目录：里面最新的文件过了天数，整个目录删（锁还被活进程拿着的不删）
    try {
      const sd = path.join(d, 'session');
      for (const sid of fs.existsSync(sd) ? fs.readdirSync(sd) : []) {
        const dir = path.join(sd, sid); let newest = 0; let busy = false;
        try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch (e) { /* 刚删 */ } if (/\.lock$/.test(f)) { const o = stateStore.read(p); if (o.pid) { try { process.kill(o.pid, 0); busy = true; } catch (e) { if (e.code === 'EPERM') busy = true; } } } } } catch (e) { continue; }
        if (!busy && newest && newest < dead) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 别人在用 */ } }
      }
    } catch (e) { /* 清不了下次再清 */ }
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) continue;
      if (/\.(?:lock|recover)$/.test(f)) { const owner = stateStore.read(p); if (owner.pid) { try { process.kill(owner.pid, 0); continue; } catch (e) { if (e.code === 'EPERM') continue; } } }
      if (/\.tmp$/.test(f)) { if (st.mtimeMs < Date.now() - 3600000) try { fs.unlinkSync(p); } catch (e) { /* 别人在用 */ } continue; }
      if (GLOBAL_STATE.test(f)) continue;
      if (st.mtimeMs < dead) try { fs.unlinkSync(p); } catch (e) { /* 别人在用 */ }
    }
    // 全局记录里 60 天前的条目清掉（审查记录、催过、计划提醒）
    const old = Date.now() - 60 * 86400000;
    for (const name of ['big-task', 'reviewed', 'reviewed-proposal', 'review-points', 'task-ticks', 'plan-hint', 'plan-unlisted']) {
      if (!fs.existsSync(stateFile(name))) continue;
      updateState(name, (o) => { for (const k of Object.keys(o)) { const t = entryAt(o[k]); if (t && t < old) delete o[k]; } });
    }
  } catch (e) { /* 忽略 */ }
}

const normKey = (f) => path.resolve(f).split(path.sep).join('/').toLowerCase();
const underDir = (file, dir) => { const f = normKey(file); const d = normKey(dir); return f === d || f.startsWith(d + '/'); };


module.exports = { KIT, sleepMs, stateFile, readState, writeState, updateState, hookLog, GLOBAL_STATE, DISPOSABLE_STATE, cleanState, normKey, underDir, STATE_KINDS, stateKindOf, sessionFileOf };
