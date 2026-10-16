'use strict';
/*
 * 解开安装包做核对（pack.js 打完自查、accept-packages.js 验收）。用 Windows PowerShell 自带的 Archive 模块，不用 tar.exe：
 * tar.exe 会把文件名转成系统的代码页，英文系统（代码页 1252）上中文文件名转不过去，报"unreadable filename"退出。
 * 2026-10-16 在英文系统上打包时遇到；压缩包本身没问题，文件名是 UTF-8 并带 UTF-8 标志，资源管理器和 Expand-Archive 都认。
 * 和压缩时一样明确加载 Windows 自带的模块：宿主的 PSModulePath 可能先指向另一份 PowerShell。不改执行策略，不开窗口。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function extract(zip, out) {
  const ps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const archive = path.join(path.dirname(ps), 'Modules', 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1');
  const load = fs.existsSync(archive) ? 'Import-Module ' + quote(archive) + ' -ErrorAction Stop; ' : '';
  execFileSync(fs.existsSync(ps) ? ps : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + load + 'Expand-Archive -LiteralPath ' + quote(zip) + ' -DestinationPath ' + quote(out) + ' -Force'], { stdio: 'ignore', windowsHide: true, timeout: 600000 });
}
module.exports = { extract };
