# 0-prepare-online.ps1 —— 在能上网的机器上运行一次，把测试包准备成可以整目录拷进内网的离线包
#   -SkipNode      不下载便携版 Node（内网机器确定有 Node 时可加）
#   -NodeVersion   便携版 Node 版本号（默认取本机 node -v）
#   -SkipSelfTest  不做自测
#   -Zip           打成 zip 放到上级目录
param([switch]$SkipNode, [string]$NodeVersion = '', [switch]$SkipSelfTest, [switch]$Zip)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot

Write-Step '1/5 检查本机 Node / npm'
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $npmCmd) { Write-Bad '外网机器需要 Node.js 18+（含 npm）来下载依赖'; return }
$localVer = (& node -v).TrimStart('v')
Write-Ok ('Node v' + $localVer + '，npm ' + (& npm -v))

Write-Step '2/5 npm install（跳过浏览器下载，内网用系统 Edge）'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
Push-Location $root
try { & npm install --no-audit --no-fund --loglevel error } finally { Pop-Location }
if (-not (Test-Path (Join-Path $root 'node_modules\playwright\package.json'))) { Write-Bad 'npm install 失败'; return }
Write-Ok 'node_modules 就绪'

Write-Step '3/5 便携版 Node（内网机器没有 Node 时的兜底）'
$nodeDir = Join-Path $root 'offline\node'
if ($SkipNode) {
    Write-Warn2 '已跳过。内网机器必须自己有 Node 18+'
} elseif (Test-Path (Join-Path $nodeDir 'node.exe')) {
    Write-Ok ('已存在：' + (Join-Path $nodeDir 'node.exe') + '（' + (& (Join-Path $nodeDir 'node.exe') -v) + '）')
} else {
    $ver = $(if ($NodeVersion) { $NodeVersion.TrimStart('v') } else { $localVer })
    $url = 'https://nodejs.org/dist/v' + $ver + '/node-v' + $ver + '-win-x64.zip'
    $nodeZip = Join-Path $root 'offline\node.zip'
    $tmp = Join-Path $root 'offline\node-tmp'
    Write-Info ('下载 ' + $url)
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        New-Item -ItemType Directory -Force -Path (Split-Path $nodeZip) | Out-Null
        Invoke-WebRequest -Uri $url -OutFile $nodeZip -UseBasicParsing
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive -Path $nodeZip -DestinationPath $tmp -Force
        $exe = Get-ChildItem $tmp -Recurse -Filter node.exe | Select-Object -First 1
        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        Copy-Item $exe.FullName (Join-Path $nodeDir 'node.exe') -Force
        Remove-Item $tmp -Recurse -Force
        Remove-Item $nodeZip -Force
        Write-Ok ('便携版 Node 已放到 offline\node\node.exe（v' + $ver + '，约 ' + [int]((Get-Item (Join-Path $nodeDir 'node.exe')).Length / 1MB) + ' MB）')
    } catch {
        Write-Warn2 ('下载失败：' + $_.Exception.Message + '。可手动下载 ' + $url + '，解压出 node.exe 放到 ' + $nodeDir)
    }
}

Write-Step '4/5 生成图片测试素材'
& node (Join-Path $root 'tools\make-image.js')

if (-not $SkipSelfTest) {
    Write-Step '5/5 自测：起站 → 第二档 → 第二点五档 → 停站'
    $env:PROBE_RESULT_DIR = Join-Path $root ('results\selftest-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    & (Join-Path $root '3-tier2-playwright.ps1')
    & (Join-Path $root '4-tier25-scenario.ps1')
    Write-Info (Invoke-SiteScript '-Stop')
} else { Write-Step '5/5 自测已跳过' }

if ($Zip) {
    Write-Step '打包（排除 results、.git、以及本机路径的 .mcp.json / .claude\settings.json，内网跑 1-check-env.ps1 会重新生成）'
    $dest = Join-Path (Split-Path $root -Parent) ('browser-probe-' + (Get-Date -Format 'yyyyMMdd') + '.zip')
    $staging = Join-Path $env:TEMP ('browser-probe-staging-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path $dest) { Remove-Item $dest -Force }
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $staging 'browser-probe') | Out-Null
        & robocopy $root (Join-Path $staging 'browser-probe') /E /XD results .git node-tmp /XF .mcp.json settings.json /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw ('robocopy 退出码 ' + $LASTEXITCODE) }
        # 不用 Compress-Archive：PS 5.1 的它不给中文文件名打 UTF-8 标记，换台机器解压 bat 名会乱码；直接调 .NET 并指定 UTF-8
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
        [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $dest, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
        Write-Ok ('已打包：' + $dest + '（' + [int]((Get-Item $dest).Length / 1MB) + ' MB）')
    } catch {
        Write-Warn2 ('打包失败：' + $_.Exception.Message + '。直接把整个 browser-probe 目录拷进内网也一样')
    } finally {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '准备完成。把整个 browser-probe 目录（或 zip）拷进内网，双击「运行全部体检（双击我）.bat」。' -ForegroundColor Cyan
