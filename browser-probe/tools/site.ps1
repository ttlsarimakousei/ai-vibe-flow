# 演示站点的启停。用法：
#   powershell -File tools\site.ps1 -Ensure   （默认：没在跑就启动）
#   powershell -File tools\site.ps1 -Start
#   powershell -File tools\site.ps1 -Stop
#   powershell -File tools\site.ps1 -Status
# 输出固定为一行：SITE_READY <地址> | SITE_DOWN | SITE_STOPPED | SITE_ERROR <原因>
param([switch]$Start, [switch]$Stop, [switch]$Ensure, [switch]$Status)
. (Join-Path $PSScriptRoot 'common.ps1')

$root = Get-ProbeRoot
$port = Get-SitePort
$base = 'http://127.0.0.1:' + $port
$health = $base + '/api/health'
$pidFile = Join-Path $root 'results\site.pid'
$server = Join-Path $root 'demo-site\server.js'

function Start-Site {
    $node = Resolve-NodeExe
    if (-not $node) { Write-Output 'SITE_ERROR 找不到 node.exe（PATH 里没有，offline\node\ 也没有）'; exit 1 }
    New-Item -ItemType Directory -Force -Path (Split-Path $pidFile) | Out-Null
    $env:PROBE_PORT = "$port"
    $p = Start-Process -FilePath $node -ArgumentList ('"' + $server + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $p.Id
    if (Wait-HttpOk -Url $health -TimeoutSec 15) {
        Write-Output ('SITE_READY ' + $base + ' (pid ' + $p.Id + ')')
    } else {
        Write-Output ('SITE_ERROR 启动后 15 秒内 ' + $health + ' 无响应（端口被占？Node 版本过旧？）')
        exit 1
    }
}

function Stop-Site {
    $stopped = 0
    if (Test-Path $pidFile) {
        $id = Get-Content $pidFile | Select-Object -First 1
        try { Stop-Process -Id ([int]$id) -Force -ErrorAction Stop; $stopped++ } catch { }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object { $_.CommandLine -like '*demo-site*server.js*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++ }
    } catch { }
    Write-Output ('SITE_STOPPED (' + $stopped + ' 个进程)')
}

if ($Stop) { Stop-Site; exit 0 }
if ($Status) { if (Test-HttpOk $health) { Write-Output ('SITE_READY ' + $base) } else { Write-Output ('SITE_DOWN ' + $base) }; exit 0 }
if ($Start) { if (Test-HttpOk $health) { Write-Output ('SITE_READY ' + $base + ' (已在运行)') } else { Start-Site }; exit 0 }
# 默认 -Ensure
if (Test-HttpOk $health) { Write-Output ('SITE_READY ' + $base) } else { Start-Site }
