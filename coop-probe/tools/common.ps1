# coop-probe 公共函数（各脚本以 . 号引入）。兼容 Windows PowerShell 5.1，不依赖任何模块。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:ProbeRoot = Split-Path -Parent $PSScriptRoot

function Get-ProbeRoot { return $script:ProbeRoot }

# Node：优先随包携带的 offline\node\node.exe，其次 PATH 里的 node.exe
function Resolve-NodeExe {
    $bundled = Join-Path $script:ProbeRoot 'offline\node\node.exe'
    if (Test-Path $bundled) { return $bundled }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# git：只用来给工作区打基线快照，缺了不致命
function Resolve-GitExe {
    $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# claude 命令：内网多为独立 exe，外网可能是 npm 的 .ps1 / .cmd 包装
function Resolve-ClaudeCommand {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $src = $cmd.Source
    if (-not $src) { $src = $cmd.Definition }
    $ext = [System.IO.Path]::GetExtension($src).ToLower()
    if ($ext -eq '.exe') { return @{ Wrap = 'exe'; Target = $src } }
    if ($ext -eq '.ps1') { return @{ Wrap = 'ps1'; Target = $src } }
    return @{ Wrap = 'cmd'; Target = $src }
}

# 模型端点：环境变量优先，其次 ~/.claude/settings.json 的 env 段
function Get-ModelEndpoint {
    $baseUrl = $env:ANTHROPIC_BASE_URL
    $token = $env:ANTHROPIC_AUTH_TOKEN
    $apiKey = $env:ANTHROPIC_API_KEY
    $model = $env:ANTHROPIC_DEFAULT_SONNET_MODEL
    $settings = Join-Path $env:USERPROFILE '.claude\settings.json'
    if (Test-Path $settings) {
        try {
            $j = Get-Content $settings -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.env) {
                if (-not $baseUrl -and $j.env.ANTHROPIC_BASE_URL) { $baseUrl = [string]$j.env.ANTHROPIC_BASE_URL }
                if (-not $token -and $j.env.ANTHROPIC_AUTH_TOKEN) { $token = [string]$j.env.ANTHROPIC_AUTH_TOKEN }
                if (-not $apiKey -and $j.env.ANTHROPIC_API_KEY) { $apiKey = [string]$j.env.ANTHROPIC_API_KEY }
                if (-not $model -and $j.env.ANTHROPIC_DEFAULT_SONNET_MODEL) { $model = [string]$j.env.ANTHROPIC_DEFAULT_SONNET_MODEL }
            }
        } catch { }
    }
    return [ordered]@{ baseUrl = $baseUrl; token = $token; apiKey = $apiKey; model = $model }
}

# 结果目录：同一轮体检共用一个时间戳目录（通过环境变量 PROBE_RESULT_DIR 传递）
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

# 写 UTF-8（无 BOM）。PS 5.1 的 Out-File -Encoding utf8 会带 BOM，JSON 类文件不能带
function Write-TextFile {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# 调用外部程序的唯一入口。
# 为什么不用 & exe 2>&1：Windows PowerShell 5.1 会把外部程序写到 stderr 的每一行包成错误记录，
# 在 $ErrorActionPreference='Stop' 下第一行 stderr 就变成致命错误，整个体检直接退出。
# javac 的警告、git 的换行符提示、JVM 的 "Picked up JAVA_TOOL_OPTIONS" 都会触发，内网实测踩过。
# 这里用 ProcessStartInfo 分别收 stdout / stderr，永不因 stderr 抛错；进程退出后最多再等 15 秒读完输出，
# 防止它留下的子进程占着管道导致整轮无人值守的体检挂死。
function Invoke-Native {
    param(
        [string]$Exe,
        [string]$ArgLine = '',
        [string]$WorkDir = '',
        [hashtable]$ExtraEnv,
        [string[]]$RemoveEnv,
        [int]$TimeoutSec = 600,
        [System.Text.Encoding]$Encoding
    )
    if (-not $Encoding) { $Encoding = New-Object System.Text.UTF8Encoding($false) }
    $r = [ordered]@{ exitCode = -1; stdout = ''; stderr = ''; timedOut = $false; error = '' }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        $psi.Arguments = $ArgLine
        if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = $Encoding
        $psi.StandardErrorEncoding = $Encoding
        if ($ExtraEnv) { foreach ($k in $ExtraEnv.Keys) { $psi.EnvironmentVariables[[string]$k] = [string]$ExtraEnv[$k] } }
        if ($RemoveEnv) { foreach ($k in $RemoveEnv) { if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } } }
        $p = [System.Diagnostics.Process]::Start($psi)
        $t = $p.StandardOutput.ReadToEndAsync()
        $e = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            $r.timedOut = $true
            try { & cmd.exe /c ('taskkill /T /F /PID ' + $p.Id + ' >nul 2>nul') | Out-Null } catch { }
            try { $p.Kill() } catch { }
        }
        try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($t, $e), 15000) } catch { }
        if ($t.IsCompleted -and -not $t.IsFaulted) { $r.stdout = [string]$t.Result }
        if ($e.IsCompleted -and -not $e.IsFaulted) { $r.stderr = [string]$e.Result }
        if (-not $r.timedOut) { try { $r.exitCode = [int]$p.ExitCode } catch { } }
    } catch {
        $r.error = $_.Exception.Message
    }
    return $r
}

function Test-AsciiPath { param([string]$Path) return ($Path -notmatch '[^\x00-\x7f]') }

# 找一个路径只含英文字符、当前用户能写的工作目录。
# 只用于地基测量的临时目录，尽量避开含中文的路径，少一个变数。
# 判定脚本与自检里 fs.cpSync 在中文路径下崩溃的问题，由下面的 node-shim.js 垫片解决。
function Get-AsciiWorkRoot {
    $cands = @()
    if ($env:PROBE_WORK_ROOT) { $cands += $env:PROBE_WORK_ROOT }
    if ($env:TEMP) { $cands += (Join-Path $env:TEMP 'coop-probe') }
    if ($env:ProgramData) { $cands += (Join-Path $env:ProgramData 'coop-probe') }
    $cands += 'C:\coop-probe'
    foreach ($c in $cands) {
        if (-not (Test-AsciiPath $c)) { continue }
        try {
            New-Item -ItemType Directory -Force -Path $c -ErrorAction Stop | Out-Null
            $probe = Join-Path $c ('.w' + [string]$PID)
            [System.IO.File]::WriteAllText($probe, 'x')
            Remove-Item $probe -Force -ErrorAction SilentlyContinue
            return $c
        } catch { }
    }
    return $null
}

# 给 Node 子进程预加载 node-shim.js 垫片，替换在中文路径下会崩溃的递归 fs.cpSync。
# 路径必须写成正斜杠：NODE_OPTIONS 里带引号的字符串会把反斜杠当转义符吃掉，
# 写成 "D:\x\y.js" 会找不到模块，结果所有 node 进程都起不来。正斜杠在 Windows 上同样有效，路径含中文也没问题（已实测）。
function Get-NodeShimEnv {
    param([string]$Shim)
    if ($Shim -and (Test-Path $Shim)) { return @{ NODE_OPTIONS = ('--require "' + $Shim.Replace([string][char]92, '/') + '"') } }
    return @{}
}

# 在一段文字里找"最后一行以某个前缀开头"的 JSON，常用于读 VERIFY / SELFTEST / RESULT 行
function Get-TaggedJson {
    param([string]$Text, [string]$Tag)
    $line = @(([string]$Text) -split "`r?`n" | Where-Object { $_ -match ('^' + [regex]::Escape($Tag) + '\s') }) | Select-Object -Last 1
    if (-not $line) { return $null }
    try { return (($line -replace ('^' + [regex]::Escape($Tag) + '\s*'), '') | ConvertFrom-Json) } catch { return $null }
}

# 判断一段按 UTF-8 读回来的外部程序输出里，中文是否完整：
#   有替换字符 U+FFFD → 乱码；有汉字且无替换字符 → 完整；一个非 ASCII 字符都没有 → 纯英文输出，不受影响
function Get-CjkVerdict {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return 'empty' }
    if ($Text.IndexOf([char]0xFFFD) -ge 0) { return 'garbled' }
    # 汉字范围用字符编码值拼出来，不在脚本里写字面汉字，也不依赖转义写法，避免受文件编码影响
    $cjk = '[' + [char]0x4E00 + '-' + [char]0x9FFF + ']'
    if ($Text -match $cjk) { return 'intact' }
    if ($Text -match '[^\x00-\x7f]') { return 'garbled' }
    return 'ascii'
}

function Write-Step { param([string]$Msg) Write-Host ''; Write-Host ('=== ' + $Msg + ' ===') -ForegroundColor Cyan }
function Write-Ok { param([string]$Msg) Write-Host ('  [OK] ' + $Msg) -ForegroundColor Green }
function Write-Bad { param([string]$Msg) Write-Host ('  [X]  ' + $Msg) -ForegroundColor Red }
function Write-Warn2 { param([string]$Msg) Write-Host ('  [!]  ' + $Msg) -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host ('       ' + $Msg) -ForegroundColor Gray }
