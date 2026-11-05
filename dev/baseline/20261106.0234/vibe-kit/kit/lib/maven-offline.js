'use strict';
/*
 * Maven 先离线，缺了只拉缺的（问题表第 35 条，2026-11-02）。devserver 起后端用。
 *   addOffline         起服务的 Maven 命令没写 -o 的加上：不去私服查依赖、查 SNAPSHOT。写了 -U 的是要更新，不加
 *   missingArtifacts   从 Maven 的报错里取出本地仓库缺的依赖。缺的是父 pom、插件的不拉：dependency:get 自己也要读项目的 pom、插件走别的仓库配置，拉了也没用
 *   fetchCommand       拉某一个依赖的命令：和原来的命令用同一套 Maven、settings.xml、本地仓库、profile
 * 报错的写法照 Maven 3.9 的原文核对过：
 *   [ERROR] dependency: com.foo:bar:jar:1.2 (compile)
 *   [ERROR]   Cannot access central (…) in offline mode and the artifact com.foo:bar:jar:1.2 has not been downloaded from it before.
 * 3.6 及以前是一行："The following artifacts could not be resolved: a:b:jar:1, c:d:jar:2: Cannot access …"
 */
const path = require('path');

const COORD = '([\\w.-]+):([\\w.-]+):([\\w-]+)(?::([\\w.-]+))?:([\\w.-]+)';
const unq = (t) => String(t || '').replace(/^["']|["']$/g, '');
const tokens = (cmd) => String(cmd || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
const isMvn = (t) => /^mvnw?(?:\.cmd|\.bat|\.sh)?$/i.test(path.basename(unq(t).replace(/\\/g, '/')));
/** 在哪个词上是 mvn。前面只能是环境变量；一条里串了几个命令的（&&、;、|）不管，返回 -1 */
function mvnAt(cmd) {
  const t = tokens(cmd);
  if (t.some((x) => /^[&|;]+$/.test(x) || /^[^"']*(?:&&|\|\||;)/.test(x))) return -1;
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
  return isMvn(t[i]) ? i : -1;
}
/** 起服务的 Maven 命令加上 -o。不是这种命令、已经写了 -o 或 -U 的，原样返回 */
function addOffline(cmd) {
  const i = mvnAt(cmd);
  if (i < 0) return cmd;
  const t = tokens(cmd);
  const rest = t.slice(i + 1).map(unq);
  if (rest.some((x) => /^(?:-o|--offline|-U|--update-snapshots)$/.test(x))) return cmd;
  if (!rest.some((x) => /^[\w.-]+:(?:run|start|dev)$/.test(x))) return cmd;
  return t.slice(0, i + 1).concat('-o', t.slice(i + 1)).join(' ');
}
/** 返回 { list: [{ coord: 'g:a:v', artifact: dependency:get 的写法 }], blocked: 不能定向拉的原因 } */
function missingArtifacts(text) {
  const s = String(text || '');
  if (/Non-resolvable (?:parent|import) POM/i.test(s)) return { list: [], blocked: '缺的是父 pom' };
  if (/Plugin \S+ or one of its dependencies could not be resolved/i.test(s)) return { list: [], blocked: '缺的是插件' };
  const seen = new Map();
  const add = (m) => {
    const [g, a, type, cl, v] = m;
    seen.set(g + ':' + a + ':' + type + (cl ? ':' + cl : '') + ':' + v, { coord: g + ':' + a + ':' + v, type, artifact: g + ':' + a + ':' + v + ':' + (type === 'test-jar' ? 'jar:tests' : type + (cl ? ':' + cl : '')) });
  };
  for (const m of s.matchAll(new RegExp('\\bartifact\\s+' + COORD + '\\s+has not been downloaded', 'g'))) add(m.slice(1));
  for (const m of s.matchAll(/following artifacts could not be resolved:\s*(.+?):\s*(?:Cannot access|Could not)/g)) {
    for (const one of m[1].split(/,\s*/)) { const c = new RegExp('^' + COORD).exec(one.trim()); if (c) add(c.slice(1)); }
  }
  const list = [...seen.values()];
  if (list.some((x) => x.type === 'pom')) return { list: [], blocked: '缺的是父 pom' };
  return { list, blocked: '' };
}
/** 拉 artifact 的命令。原来的命令不是 Maven 的返回 ''。-o、目标、别的参数不带；settings.xml、本地仓库、pom、profile 带上（私服在这几样里） */
function fetchCommand(cmd, artifact) {
  const i = mvnAt(cmd);
  if (i < 0) return '';
  const t = tokens(cmd);
  const keep = t.slice(0, i + 1);
  for (let k = i + 1; k < t.length; k++) {
    const x = unq(t[k]);
    if (/^(?:-s|--settings|-gs|--global-settings|-f|--file|-P|--activate-profiles)$/.test(x)) { keep.push(t[k]); if (t[k + 1]) keep.push(t[++k]); continue; }
    // 贴着写的：-Pdev、-s/x/settings.xml、--settings=…（-f 不认贴着写的，-fae、-ff 是别的参数）
    if (/^(?:-Dmaven\.repo\.local=|-P.|-s.|-gs.|--(?:settings|global-settings|file|activate-profiles)=)/.test(x)) keep.push(t[k]);
  }
  return keep.concat('-B', 'dependency:get', '"-Dartifact=' + artifact + '"').join(' ');
}

module.exports = { addOffline, missingArtifacts, fetchCommand };
