# 1-check-env.ps1 —— 环境检查 + 生成 .claude\settings.json + 实测 hook 契约
# hook 契约必须实测：所有护栏类设计都押在"某个事件名在这个版本上真的会触发"，而这从没在 2.1.259 上验证过。
# -SettingsOnly：只生成配置，不做 hook 契约实测（模型对比时用，那里每个模型直连，不需要再测一遍 hook）
param([switch]$SettingsOnly)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$out = New-ResultDir
$info = [ordered]@{}

Write-Step '环境检查'
try { $os = Get-CimInstance Win32_OperatingSystem; $info.os = ($os.Caption + ' ' + $os.Version) } catch { $info.os = [Environment]::OSVersion.VersionString }
$info.powershell = $PSVersionTable.PSVersion.ToString()
Write-Ok ('系统：' + $info.os + '；PowerShell ' + $info.powershell)

$node = Resolve-NodeExe
if ($node) { $info.node = (& $node -v); $info.nodePath = $node; Write-Ok ('Node ' + $info.node + '  (' + $node + ')') }
else { $info.node = $null; Write-Bad 'Node 不可用。判定脚本和样本工程都要它，把便携 node.exe 放到 offline\node\ 即可' }

$git = Resolve-GitExe
if ($git) { $info.git = ((& $git --version) -join ''); Write-Ok $info.git }
else { $info.git = $null; Write-Warn2 '没有 git。需要 git 基线的用例会退化为文件哈希对比，仍可运行' }

$claude = Resolve-ClaudeCommand
if ($claude) {
    $cv = ''
    try { $cv = ((& claude --version 2>$null) | Select-Object -First 1) } catch { $cv = '?' }
    $info.claude = [string]$cv
    $info.claudeWrap = $claude.Wrap
    $info.claudePath = $claude.Target
    Write-Ok ('Claude Code：' + $cv + '  (' + $claude.Wrap + ' → ' + $claude.Target + ')')
} else { $info.claude = $null; Write-Bad '未找到 claude 命令，模型测试无法进行' }

$ep = Get-ModelEndpoint
$info.baseUrl = $ep.baseUrl
$info.authKind = $(if ($ep.token) { 'ANTHROPIC_AUTH_TOKEN' } elseif ($ep.apiKey) { 'ANTHROPIC_API_KEY' } else { '未设置' })
$info.model = $ep.model
if ($ep.baseUrl) { Write-Ok ('模型端点：' + $ep.baseUrl + '（鉴权 ' + $info.authKind + '，模型 ' + $(if ($ep.model) { $ep.model } else { '未指定' }) + '）') }
else { Write-Warn2 '没读到 ANTHROPIC_BASE_URL，时延探测会打官方端点。内网请先配好环境变量或 ~/.claude/settings.json 的 env 段' }

$cases = @(Get-ChildItem (Join-Path $root 'tests') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'meta.json') })
$info.caseCount = $cases.Count
if ($cases.Count) { Write-Ok ('测试用例 ' + $cases.Count + ' 个：' + (($cases | ForEach-Object { $_.Name }) -join '，')) }
else { Write-Bad 'tests\ 下没有任何用例（缺 meta.json）' }

# ---- 生成 .claude\settings.json ----
Write-Step '生成 Claude Code 配置'
$hookPs1 = Join-Path $root 'tools\hook-log.ps1'
function New-Hook { param([string]$Name) return [ordered]@{ hooks = @([ordered]@{ type = 'command'; command = ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $hookPs1 + '" -Event ' + $Name) }) } }
$settings = [ordered]@{
    permissions = [ordered]@{
        allow = @('Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep')
        deny  = @('Bash(git push:*)', 'WebFetch', 'WebSearch')
    }
    hooks = [ordered]@{
        PostToolUse      = @([ordered]@{ matcher = '.*'; hooks = (New-Hook 'PostToolUse').hooks })
        UserPromptSubmit = @(New-Hook 'UserPromptSubmit')
        Stop             = @(New-Hook 'Stop')
        SessionStart     = @(New-Hook 'SessionStart')
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $root '.claude') | Out-Null
$settingsPath = Join-Path $root '.claude\settings.json'
Write-TextFile -Path $settingsPath -Text ($settings | ConvertTo-Json -Depth 8)
Write-Ok '.claude\settings.json 已生成（放行本地工具、禁 push 与联网、四个事件挂计数 hook）'
if ($SettingsOnly) {
    Write-TextFile -Path (Join-Path $out 'env.json') -Text ($info | ConvertTo-Json -Depth 6)
    return
}

# ---- 实测 hook 契约 ----
Write-Step 'hook 契约实测（这一版到底有哪些事件会触发）'
$hookProbe = [ordered]@{ tested = @(); fired = @(); note = '' }
if (-not $claude) {
    Write-Warn2 '没有 claude，跳过'
    $hookProbe.note = '没有 claude 命令'
} else {
    $probeDir = Join-Path $out 'hook-contract'
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
    $probeLog = Join-Path $probeDir 'events.log'
    if (Test-Path $probeLog) { Remove-Item $probeLog -Force }

    # 把所有可能的事件名都挂上，看哪些真的会被调用
    $candidates = @('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd', 'Notification', 'PreCompact', 'StopFailure', 'PostToolUseFailure', 'InstructionsLoaded')
    $hookProbe.tested = $candidates
    $probeHooks = [ordered]@{}
    foreach ($c in $candidates) {
        if ($c -eq 'PreToolUse' -or $c -eq 'PostToolUse') { $probeHooks[$c] = @([ordered]@{ matcher = '.*'; hooks = (New-Hook $c).hooks }) }
        else { $probeHooks[$c] = @(New-Hook $c) }
    }
    $probeSettings = [ordered]@{ permissions = [ordered]@{ allow = @('Bash', 'Read') }; hooks = $probeHooks }
    $probeSettingsPath = Join-Path $probeDir 'settings.json'
    Write-TextFile -Path $probeSettingsPath -Text ($probeSettings | ConvertTo-Json -Depth 8)

    if ($node) { $null = Invoke-Native -Exe $node -ArgLine ('"' + (Join-Path $root 'tools\trust-project.js') + '" "' + $probeDir + '"') -TimeoutSec 60 }
    Write-TextFile -Path (Join-Path $probeDir 'hello.txt') -Text 'hook 契约探测用的样本文件'

    $env:PROBE_TOOLLOG = $probeLog
    $prompt = '用 Bash 工具运行 echo hook-probe，再用 Read 工具读取 hello.txt，然后只回复两个字：完成。'
    $argStr = '-p "' + $prompt + '" --output-format json --max-turns 8 --settings "' + $probeSettingsPath + '"'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($claude.Wrap -eq 'exe') { $psi.FileName = $claude.Target; $psi.Arguments = $argStr }
    elseif ($claude.Wrap -eq 'ps1') { $psi.FileName = 'powershell.exe'; $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $claude.Target + '" ' + $argStr }
    else { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/s /c ""' + $claude.Target + '" ' + $argStr + '"' }
    $psi.WorkingDirectory = $probeDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['PROBE_TOOLLOG'] = $probeLog
    foreach ($k in @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT')) { if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } }

    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $so = $p.StandardOutput.ReadToEndAsync()
        $se = $p.StandardError.ReadToEndAsync()
        $done = $p.WaitForExit(180000)
        if (-not $done) { try { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null } catch { } }
        Write-TextFile -Path (Join-Path $probeDir 'claude.out.json') -Text ([string]$so.Result)
        Write-TextFile -Path (Join-Path $probeDir 'claude.err.txt') -Text ([string]$se.Result)
    } catch {
        $hookProbe.note = '启动 claude 失败：' + $_.Exception.Message
        Write-Bad $hookProbe.note
    }
    $env:PROBE_TOOLLOG = $null

    # 先看这次探测本身有没有成功：会话失败（鉴权、端点不通）时一个工具都不会跑，
    # 那时候"PostToolUse 没触发"说明不了任何问题，必须区分开，否则会得出完全错误的结论
    $sessionOk = $false
    try {
        $so = Get-Content (Join-Path $probeDir 'claude.out.json') -Raw -Encoding UTF8
        $jline = @(($so -split "`r?`n") | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
        if ($jline) { $jj = $jline | ConvertFrom-Json; $sessionOk = (-not $jj.is_error); $hookProbe.sessionResult = [string]$jj.result }
    } catch { }
    $hookProbe.sessionOk = $sessionOk

    if (Test-Path $probeLog) {
        $lines = @(Get-Content $probeLog -Encoding UTF8)
        $fired = @($lines | ForEach-Object { ($_ -split "`t")[1] } | Where-Object { $_ } | Select-Object -Unique)
        $hookProbe.fired = $fired
        $hookProbe.lines = $lines.Count
        Write-Ok ('触发的事件：' + ($fired -join '，') + '（共 ' + [string]$lines.Count + ' 条记录）')
        $missing = @($candidates | Where-Object { $fired -notcontains $_ })
        Write-Info ('本次未触发：' + ($missing -join '，') + '。未触发不等于不存在，这次探测只做了一次 Bash 加一次 Read，像 PreCompact、SubagentStop 本来就不该出现。')
        if (-not $sessionOk) {
            Write-Warn2 '这次探测的会话本身失败了（多半是鉴权或端点不通），所以一个工具都没跑起来，工具类事件没触发是正常的。等 claude 能正常工作后重跑本脚本才能得出结论。'
            $hookProbe.note = '会话失败，工具类事件的结论无效'
        } elseif ($fired -notcontains 'PostToolUse') {
            # 会话成功不等于模型真的调用了工具：它可能一轮就直接回话了。只有真的用了工具还没触发，才是 hook 的问题
            $turns = 99
            try { if ($jline) { $turns = [int](($jline | ConvertFrom-Json).num_turns) } } catch { }
            $hookProbe.numTurns = $turns
            if ($turns -le 1) {
                Write-Warn2 '会话成功了，但模型这次没有真的去调用工具（一轮就结束了），所以工具类事件没法判定。这不代表 hook 有问题，以模型测试阶段各用例的步数为准。'
                $hookProbe.note = '模型没有调用工具，工具类事件无法判定'
                $hookProbe.toolsUnknown = $true
            } else {
                Write-Bad 'PostToolUse 没有触发，而模型确实调用了工具。工具调用计数会全为零，所有基于 hook 的护栏设计都要重新考虑'
                $hookProbe.note = 'PostToolUse 在模型调用了工具的情况下仍未触发'
            }
        }
    } else {
        Write-Bad 'hook 一次都没触发，日志文件没生成。可能是目录未被信任，或这一版的 hook 契约与预期不同'
        $hookProbe.note += ' 日志文件未生成'
    }
}
$info.hookContract = $hookProbe

Write-TextFile -Path (Join-Path $out 'env.json') -Text ($info | ConvertTo-Json -Depth 6)
Write-Info ('环境信息已写入 ' + (Join-Path $out 'env.json'))
