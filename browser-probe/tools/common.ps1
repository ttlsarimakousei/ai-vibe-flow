# browser-probe 公共函数（各脚本以 . 号引入）。兼容 Windows PowerShell 5.1，不依赖任何模块。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:ProbeRoot = Split-Path -Parent $PSScriptRoot

function Get-ProbeRoot { return $script:ProbeRoot }

function Get-SitePort {
    if ($env:PROBE_PORT) { return [int]$env:PROBE_PORT }
    return 4173
}

function Get-SiteBase {
    if ($env:PROBE_BASE) { return $env:PROBE_BASE.TrimEnd('/') }
    return ('http://127.0.0.1:{0}' -f (Get-SitePort))
}

# Node：优先随包携带的 offline\node\node.exe，其次 PATH 里的 node.exe
function Resolve-NodeExe {
    $bundled = Join-Path $script:ProbeRoot 'offline\node\node.exe'
    if (Test-Path $bundled) { return $bundled }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# 浏览器：环境变量 PROBE_BROWSER_PATH > Edge > Chrome > 注册表 App Paths
function Resolve-BrowserExe {
    if ($env:PROBE_BROWSER_PATH -and (Test-Path $env:PROBE_BROWSER_PATH)) { return $env:PROBE_BROWSER_PATH }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    $rels = @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')
    foreach ($rel in $rels) {
        foreach ($b in $bases) {
            $p = Join-Path $b $rel
            if (Test-Path $p) { return $p }
        }
    }
    foreach ($exe in @('msedge.exe', 'chrome.exe')) {
        foreach ($hive in @('HKLM:', 'HKCU:')) {
            try {
                $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
                $p = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
                if ($p -and (Test-Path $p)) { return $p }
            } catch { }
        }
    }
    return $null
}

# 结果目录：同一轮 run-all 共用一个时间戳目录（通过环境变量 PROBE_RESULT_DIR 传递）
function New-ResultDir {
    param([string]$Name)
    $base = $env:PROBE_RESULT_DIR
    if (-not $base) {
        $base = Join-Path $script:ProbeRoot ('results\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $env:PROBE_RESULT_DIR = $base
    }
    $dir = $base
    if ($Name) { $dir = Join-Path $base $Name }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

# 写 UTF-8（无 BOM）文本文件；PS 5.1 的 Out-File -Encoding utf8 会带 BOM，JSON 类文件不能带
function Write-TextFile {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Test-HttpOk {
    param([string]$Url, [int]$TimeoutMs = 2000)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Timeout = $TimeoutMs
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return ($code -ge 200 -and $code -lt 400)
    } catch { return $false }
}

function Wait-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 15)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (Test-HttpOk -Url $Url) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Invoke-SiteScript {
    param([string]$Action)
    $site = Join-Path $script:ProbeRoot 'tools\site.ps1'
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $site $Action 2>&1
    return ($out | Out-String).Trim()
}

function Write-Step { param([string]$Msg) Write-Host ''; Write-Host ('=== ' + $Msg + ' ===') -ForegroundColor Cyan }
function Write-Ok { param([string]$Msg) Write-Host ('  [OK] ' + $Msg) -ForegroundColor Green }
function Write-Bad { param([string]$Msg) Write-Host ('  [X]  ' + $Msg) -ForegroundColor Red }
function Write-Warn2 { param([string]$Msg) Write-Host ('  [!]  ' + $Msg) -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host ('       ' + $Msg) -ForegroundColor Gray }
