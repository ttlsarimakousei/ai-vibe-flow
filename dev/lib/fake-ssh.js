'use strict';
/*
 * 测试用的假 ssh：git 用它"连"假 GitLab（环境变量 GIT_SSH_COMMAND 指过来）。
 *   拉仓库、推仓库    git-upload-pack '组/项目.git' → 在本机的裸仓库上跑 git upload-pack
 *   不带命令          回一句 Welcome to GitLab, @tester!
 *   personal_access_token 名字 权限 天数   发一个令牌，同时写进假 GitLab 认的 tokens.json
 * 行为由 <数据目录>/ssh.json 控制（每次现读）：
 *   mode   ok / denied（密钥不认）/ hostkey（没连过，指纹没确认）/ down（连不上）/ readonly（能拉不能推）
 *   pat    ok / unknown（老版本的 GitLab，不认这个命令）/ disabled（管理员关掉了）
 * 每次调用记在 <数据目录>/ssh-calls.log（一行一个 JSON）。数据目录、裸仓库根目录从环境变量 FAKE_GITLAB_DATA、FAKE_GITLAB_REPOS 拿。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DATA = process.env.FAKE_GITLAB_DATA || '';
const REPOS = process.env.FAKE_GITLAB_REPOS || '';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
const argv = process.argv.slice(2);
const WITH_VALUE = new Set(['-o', '-p', '-P', '-i', '-l', '-F', '-E', '-c', '-m', '-b', '-J', '-L', '-R', '-D', '-e', '-I', '-Q', '-S', '-W', '-w']);
const opts = [];
let dest = '';
let words = [];
let probe = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-G') { probe = true; i++; continue; }
  if (WITH_VALUE.has(a)) { opts.push(a + ' ' + (argv[i + 1] || '')); i++; continue; }
  if (/^-/.test(a)) { opts.push(a); continue; }
  dest = a;
  words = argv.slice(i + 1);
  break;
}
// git 先用 ssh -G 主机 探一下是不是 OpenSSH：回 0 就当是
if (probe) process.exit(0);
const command = words.join(' ').trim();
const cfg = Object.assign({ mode: 'ok', pat: 'ok', user: 'tester' }, readJson('ssh.json', {}));
try { fs.appendFileSync(path.join(DATA, 'ssh-calls.log'), JSON.stringify({ at: Date.now(), opts, dest, command: command.replace(/(personal_access_token\s+\S+\s+\S+).*/, '$1 …'), mode: cfg.mode }) + '\n'); } catch (e) { /* 记不了就算了 */ }
const host = dest.replace(/^.*@/, '');
const die = (msg, code) => { process.stderr.write(msg + '\n'); process.exit(code); };
if (!DATA || !REPOS) die('fake-ssh：没给 FAKE_GITLAB_DATA / FAKE_GITLAB_REPOS', 255);
if (cfg.mode === 'down') die('ssh: connect to host ' + host + ' port 22: Connection timed out', 255);
if (cfg.mode === 'hostkey') die('Host key verification failed.', 255);
if (cfg.mode === 'denied') die(dest + ': Permission denied (publickey).', 255);

if (!command) { process.stdout.write('Welcome to GitLab, @' + cfg.user + '!\n'); process.exit(0); }
const pat = /^personal_access_token(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(command);
if (pat) {
  if (cfg.pat === 'unknown') die('remote: \nremote: ========================================================================\nremote: \nremote: ERROR: Unknown command: personal_access_token\nremote: \nremote: ========================================================================\nremote: ', 1);
  if (cfg.pat === 'disabled') die('remote: ERROR: Personal access tokens via SSH are disabled by the administrator', 1);
  if (!pat[1] || !pat[2]) die('remote: ERROR: Usage: personal_access_token <name> <scope1[,scope2,...]> [ttl_days]', 1);
  const days = pat[3] === undefined ? 30 : Number(pat[3]);
  if (!(days >= 0)) die("remote: ERROR: Invalid value for days_ttl: '" + pat[3] + "'", 1);
  const token = 'glpat-' + crypto.randomBytes(15).toString('hex').slice(0, 20);
  const d = new Date(Date.now() + days * 86400000);
  const expires = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const all = readJson('tokens.json', {});
  all[token] = { user: cfg.user, expires, name: pat[1], scopes: pat[2].split(','), via: 'ssh' };
  fs.writeFileSync(path.join(DATA, 'tokens.json'), JSON.stringify(all, null, 2));
  process.stdout.write('Token:   ' + token + '\nScopes:  ' + pat[2] + '\nExpires: ' + expires + '\n');
  process.exit(0);
}
const g = /^(git-upload-pack|git-receive-pack|git-upload-archive)\s+'?\/?(.+?)'?$/.exec(command);
if (!g) die('remote: ERROR: Unknown command: ' + command.split(/\s+/)[0], 1);
const repo = path.join(REPOS, g[2]);
if (!fs.existsSync(repo)) die("remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.", 1);
if (g[1] === 'git-receive-pack' && cfg.mode === 'readonly') die('remote: GitLab: You are not allowed to push code to this project.', 1);
const r = spawnSync('git', [g[1].replace(/^git-/, ''), repo], { stdio: 'inherit', windowsHide: true });
process.exit(r.status === null ? 255 : r.status);
