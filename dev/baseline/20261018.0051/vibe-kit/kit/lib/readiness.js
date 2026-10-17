'use strict';
/* 开工就绪摘要只核对文件和登记，不跑项目脚本、不连数据库。识别、工具存在和验证成功分别显示。结果按来源指纹失效。 */
const fs = require('fs');
const path = require('path');
const S = require('./session');
const W = require('./workspace');
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function executable(name, dirs) { const ext = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']; return dirs.filter(Boolean).some((d) => ext.some((e) => fs.existsSync(path.join(d, name + e)))); }
function inspect(root) {
  root = path.resolve(root); const notes = read(path.join(root, '.vibe', 'project.md')); const localText = read(path.join(S.KIT, 'local.json')); let local = {};
  try { local = JSON.parse(localText); } catch (e) { /* 缺环境设置 */ }
  const roots = S.isShell(root) ? S.nestedRepos(root) : [root]; const marks = [];
  for (const r of roots) for (const f of ['pom.xml', 'build.gradle', 'package.json', 'pyproject.toml', '.vibe/project.md']) if (fs.existsSync(path.join(r, f))) marks.push([path.relative(root, path.join(r, f)), W.hash(read(path.join(r, f)))]);
  const idea = require('./idea-mcp').status();
  const paths = String(process.env.PATH || '').split(path.delimiter).concat(...['jdks', 'mavens'].map((k) => (Array.isArray(local[k]) ? local[k] : []).map((v) => path.join(v.path || '', 'bin'))));
  const toolStats = []; for (const d of paths.filter(Boolean)) for (const n of ['javac', 'mvn', 'node', 'python', 'gradle']) for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) try { const st = fs.statSync(path.join(d, n + ext)); toolStats.push([d, n + ext, st.size, st.mtimeMs]); } catch (e) { /* 不存在的工具不记为就绪 */ }
  const dependencyState = roots.map((r) => [r, fs.existsSync(path.join(r, 'node_modules')), fs.existsSync(path.join(r, 'gradlew')), fs.existsSync(path.join(r, 'gradlew.bat'))]);
  const drivers = require('./drivers').readRegistry();
  const driverStats = Object.values(drivers).flatMap((r) => require('./drivers').variants(r).map((v) => { try { const st = fs.statSync(v.jar); return [v.jar, st.size, st.mtimeMs]; } catch (e) { return [v.jar, '缺少']; } }));
  const fingerprint = W.hash(JSON.stringify([marks, notes, localText, toolStats, dependencyState, driverStats, read(path.join(S.KIT, 'drivers.json')), process.env.PATH || '', idea.status, idea.checkedAt]));
  const cached = S.readState('readiness')[S.normKey(root)]; if (cached && cached.fingerprint === fingerprint) return cached;
  const identified = [...new Set(marks.map(([f]) => /pom\.xml$/.test(f) ? 'Maven' : /build\.gradle$/.test(f) ? 'Gradle' : /package\.json$/.test(f) ? 'Node' : /pyproject\.toml$/.test(f) ? 'Python' : '').filter(Boolean))];
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const configured = (k) => (Array.isArray(local[k]) ? local[k] : []).map((x) => path.join(x.path || '', 'bin'));
  const tools = { Node: executable('node', dirs), JDK: executable('javac', configured('jdks').concat(dirs)), Maven: executable('mvn', configured('mavens').concat(dirs)), Python: executable('python', dirs) || executable('python3', dirs), Gradle: roots.some((r) => fs.existsSync(path.join(r, 'gradlew')) || fs.existsSync(path.join(r, 'gradlew.bat'))) || executable('gradle', dirs) };
  const required = [...new Set(identified.flatMap((x) => x === 'Maven' ? ['JDK', 'Maven'] : x === 'Gradle' ? ['JDK', 'Gradle'] : [x]))];
  const requested = roots.flatMap((r) => require('./drivers').projectDrivers(r));
  const driverRows = requested.map((d) => ({ artifact: d.artifactId, version: d.version || '项目未明确版本', registered: Object.values(drivers).some((r) => require('./drivers').variants(r).some((v) => fs.existsSync(v.jar) && (!d.version || v.version === d.version) && (String(v.artifactId || r.artifactId || '') === d.artifactId || path.basename(v.jar).toLowerCase().includes(d.artifactId.toLowerCase())))) }));
  const frontend = roots.map((r) => { const f = require('./onboard').frontendFacts(r, new Set()); return f ? { project: path.basename(r), dependenciesPresent: fs.existsSync(path.join(r, 'node_modules')), proxyConfigured: !!f.proxies.length, proxyNeedsActualBackend: !!f.proxies.length, note: '有代理时先核对是否读取 VIBE_BACKEND_URL；写死地址不会由套件自动覆盖' } : null; }).filter(Boolean);
  const result = { root, fingerprint, at: Date.now(), identified, tools, missing: required.filter((n) => !tools[n]), idea: idea.status, ideaCapabilities: require('./idea-tools').capabilities(), drivers: driverRows, frontend, projectNotes: !!notes, verification: '未实际执行构建、测试或数据库连接；依赖是否齐全、版本兼容和索引就绪需在已授权任务中验证' };
  S.updateState('readiness', (s) => { s[S.normKey(root)] = result; for (const k of Object.keys(s)) if (Date.now() - s[k].at > 14 * 86400000) delete s[k]; }); return result;
}
function brief(root) { const r = inspect(root); const idea = { unchecked: '尚未检测', connected: '已连接', disabled: '已关闭', not_found: '未发现服务' }[r.idea] || '状态需核对'; return '[环境就绪] 识别到 ' + (r.identified.join('、') || '普通工程') + '；' + (r.missing.length ? '缺工具 ' + r.missing.join('、') : '所需工具文件存在') + '；IDEA ' + idea + '。识别结果不代表构建或测试通过，依赖与版本兼容仍需实际验证。'; }
module.exports = { inspect, brief };
