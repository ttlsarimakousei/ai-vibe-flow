# probe-auto.ps1 —— 全自动体检：输入轮数后全程无人值守
#   环境检查 → 标记信任目录 → 起演示站 → 脚本测试（1 / 2 / 2.5 / 3 基础自检）
#   → 逐轮用 claude -p 跑模型测试（看图 + 五套页面 × 写场景 / MCP 直驱）→ 自动评分 → 报告落地（results + 桌面）
# 参数：
#   -Rounds N          测试轮数（不给则在控制台询问，默认 3）
#   -Sets a,b,c,d,e,f  页面套（默认全部六套）
#   -SkipScripts       跳过脚本测试
#   -SkipImg           跳过看图测试
#   -TaskTimeoutMin 25 单个模型任务超时（分钟）
#   -MaxTurns 120      单个模型任务最多回合数
#   -Simulate          不调用 claude，用假结果走一遍评分与报告（自测用）
param(
    [int]$Rounds = 0,
    [string]$Sets = 'a,b,c,d,e,f',
    [switch]$SkipScripts,
    [switch]$SkipImg,
    [int]$TaskTimeoutMin = 25,
    [int]$MaxTurns = 120,
    [switch]$Simulate
)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot

Write-Host ''
Write-Host '浏览器验证 · 全自动体检' -ForegroundColor Cyan
Write-Host '（脚本测试 + 模型测试 + 自动评分 + 报告落地，中途不需要人操作）'
Write-Host ''
if ($Rounds -le 0) {
    $in = Read-Host '要测试几轮？直接回车 = 3'
    if ($in -match '^\d+$' -and [int]$in -gt 0) { $Rounds = [int]$in } else { $Rounds = 3 }
}
$setList = @($Sets -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLower() })
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$auto = Join-Path $root ('results\auto-' + $ts)
New-Item -ItemType Directory -Force -Path $auto | Out-Null
$env:PROBE_RESULT_DIR = $auto
try { Start-Transcript -Path (Join-Path $auto 'run.log') -Force | Out-Null } catch { }
$swAll = [System.Diagnostics.Stopwatch]::StartNew()
$taskCount = $setList.Count * 2 + $(if ($SkipImg) { 0 } else { 1 })
Write-Info ('轮数 ' + $Rounds + '，页面套 ' + ($setList -join ',') + '，每轮 ' + $taskCount + ' 项模型测试；单项超时 ' + $TaskTimeoutMin + ' 分钟')
Write-Info ('结果目录：' + $auto)

# ---------- 1. 环境 ----------
& (Join-Path $root '1-check-env.ps1')
$node = Resolve-NodeExe

# ---------- 2. 标记信任（claude -p 不弹信任框；未信任会忽略项目 settings 里的权限/hook/MCP 放行）----------
Write-Step '标记本目录为 Claude Code 已信任'
if ($node) { & $node (Join-Path $root 'tools\trust-project.js') $root } else { Write-Warn2 '没有 Node，跳过（若 claude 提示 workspace has not been trusted，请先交互式打开一次 claude 接受信任）' }

# ---------- 3. 演示站 ----------
Write-Step '启动演示站'
$siteOut = Invoke-SiteScript '-Start'
Write-Info $siteOut
$siteOk = ($siteOut -match 'SITE_READY')

# ---------- 4. 脚本测试 ----------
if (-not $SkipScripts) {
    & (Join-Path $root '2-tier1-edge.ps1')
    & (Join-Path $root '3-tier2-playwright.ps1')
    & (Join-Path $root '4-tier25-scenario.ps1')
    & (Join-Path $root '5-tier3-mcp-selftest.ps1')
}

# ---------- 5. 模型测试 ----------
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
function Quote-Arg { param([string]$s) return '"' + ($s -replace '"', '\"') + '"' }

function Invoke-Claude {
    param([string]$Prompt, [string]$StdOut, [string]$StdErr)
    $argStr = '-p ' + (Quote-Arg $Prompt) + ' --output-format json --max-turns ' + $MaxTurns + ' --allowedTools "mcp__playwright" "Bash" "Read" "Write" "Edit" "Glob" "Grep"'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($claude.Wrap -eq 'exe') { $psi.FileName = $claude.Target; $psi.Arguments = $argStr }
    elseif ($claude.Wrap -eq 'ps1') { $psi.FileName = 'powershell.exe'; $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $claude.Target + '" ' + $argStr }
    else { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/s /c ""' + $claude.Target + '" ' + $argStr + '"' }
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    foreach ($k in @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT')) { if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } }
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $finished = $p.WaitForExit($TaskTimeoutMin * 60000)
    if (-not $finished) {
        try { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null } catch { }
        try { $p.Kill() } catch { }
    }
    $out = ''
    $err = ''
    try { $out = $outTask.Result } catch { }
    try { $err = $errTask.Result } catch { }
    Write-TextFile -Path $StdOut -Text $out
    Write-TextFile -Path $StdErr -Text $err
    $code = -1
    if ($finished) { $code = $p.ExitCode }
    return @{ timeout = (-not $finished); exitCode = $code; stdout = $out; stderr = $err }
}

function Normalize-Value {
    param($v)
    if ($null -eq $v) { return '' }
    if ($v -is [System.Array]) { $v = ($v -join '') }
    elseif ($v -is [bool]) { if ($v) { $v = '是' } else { $v = '否' } }
    $s = [string]$v
    $s = $s -replace '\s', ''
    $s = $s -replace '[,，、色：:「」“”"（）()]', ''
    return $s.ToLowerInvariant()
}
function Compare-Result {
    param($Expected, $Actual)
    $detail = @()
    $pass = $true
    foreach ($prop in $Expected.PSObject.Properties) {
        $k = $prop.Name
        $a = $null
        if ($Actual -and $Actual.PSObject.Properties[$k]) { $a = $Actual.$k }
        $shown = '缺失'
        if ($null -ne $a) { $shown = [string]$a }
        # 期望值可以是 { "regex": "...", "sample": "..." }：按正则判，容忍合理的写法差异
        if ($prop.Value -is [System.Management.Automation.PSCustomObject] -and $prop.Value.PSObject.Properties['regex']) {
            $ok = ($null -ne $a) -and (([string]$a) -match [string]$prop.Value.regex)
            if (-not $ok) { $pass = $false; $detail += ($k + '：期望匹配「' + [string]$prop.Value.regex + '」，实际「' + $shown + '」') }
            continue
        }
        if ((Normalize-Value $prop.Value) -ne (Normalize-Value $a)) {
            $pass = $false
            $detail += ($k + '：期望「' + [string]$prop.Value + '」，实际「' + $shown + '」')
        }
    }
    return @{ pass = $pass; detail = $detail }
}

$expected = @{}
foreach ($s in $setList) {
    $f = Join-Path $root ('tests\' + $s + '\expected.json')
    if (Test-Path $f) { $expected[$s] = (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json) } else { Write-Warn2 ('没有 ' + $f + '，跳过页面套 ' + $s) }
}
$setList = @($setList | Where-Object { $expected.ContainsKey($_) })
$expected['img'] = (Get-Content (Join-Path $root 'tests\img\expected.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
$logFile = Join-Path $root 'results\model\toolcalls.log'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null

function Get-LogLines { if (Test-Path $logFile) { return @(Get-Content $logFile -Encoding UTF8) } return @() }

function Simulate-Task {
    param($Rec, [string]$ResultPath, $Exp)
    $fake = [ordered]@{}
    foreach ($prop in $Exp.PSObject.Properties) {
        if ($prop.Value -is [System.Management.Automation.PSCustomObject] -and $prop.Value.PSObject.Properties['sample']) { $fake[$prop.Name] = $prop.Value.sample } else { $fake[$prop.Name] = $prop.Value }
    }
    if ($Rec.round -eq 1 -and $Rec.tag -eq 'c-t3') { $fake['page3Rows'] = '4' }
    $fake['retries'] = 0
    $fake['notes'] = '模拟结果'
    Write-TextFile -Path $ResultPath -Text ($fake | ConvertTo-Json)
    $n = Get-Random -Minimum 8 -Maximum 20
    if ($Rec.test -eq 't3') { for ($i = 0; $i -lt $n; $i++) { [System.IO.File]::AppendAllText($logFile, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "`tmcp__playwright__browser_snapshot`r`n"), (New-Object System.Text.UTF8Encoding($false))) } }
    Start-Sleep -Milliseconds 200
    return @{ timeout = $false; exitCode = 0; stdout = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":' + ($n + 3) + ',"result":"完成"}' }
}

function Invoke-ModelTask {
    param([int]$Round, [string]$Set, [string]$Test, [string]$Title)
    $roundDir = Join-Path $auto ('model\round-' + $Round)
    New-Item -ItemType Directory -Force -Path $roundDir | Out-Null
    $tag = $Set + '-' + $Test
    if ($Set -eq 'img') { $tag = 'img' }
    $resultPath = Join-Path $roundDir ($tag + '.json')
    $scOut = Join-Path $roundDir ($tag + '-out')
    $taskFile = 'tests/' + $Set + '/' + $Test + '.md'
    if ($Set -eq 'img') { $taskFile = 'tests/img/task.md' }
    $prompt = '[浏览器体检 第' + $Round + '轮 ' + $tag + '] 用 Read 工具读取 ' + $taskFile + '，严格按其中要求执行。结果文件路径：' + ($resultPath -replace '\\', '/') + '。场景执行器输出目录：' + ($scOut -replace '\\', '/') + '。做完后只回复一行：完成。'
    $rec = [ordered]@{ round = $Round; set = $Set; test = $Test; title = $Title; tag = $tag; pass = $false; mcpCalls = 0; seconds = 0; numTurns = $null; isError = $null; subtype = ''; timeout = $false; exitCode = $null; detail = @(); notes = ''; retries = $null; modelToolCalls = $null; finalText = ''; resultPath = $resultPath; startedAt = (Get-Date -Format 'HH:mm:ss') }
    $exp = $null
    if ($Set -eq 'img') { $exp = $expected['img'].task } else { $exp = $expected[$Set].$Test }

    $before = (Get-LogLines).Count
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Simulate) {
        $r = Simulate-Task -Rec $rec -ResultPath $resultPath -Exp $exp
    } else {
        $r = Invoke-Claude -Prompt $prompt -StdOut (Join-Path $roundDir ($tag + '.claude.json')) -StdErr (Join-Path $roundDir ($tag + '.claude.err.txt'))
    }
    $sw.Stop()
    $rec.seconds = [int]$sw.Elapsed.TotalSeconds
    $rec.timeout = $r.timeout
    $rec.exitCode = $r.exitCode
    try {
        # claude 的 JSON 在最后一行；前面可能有警告文字，只取最后一个以 { 开头的行
        $jsonLine = @(([string]$r.stdout) -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
        if (-not $jsonLine) { throw '没有 JSON 行' }
        $j = $jsonLine | ConvertFrom-Json
        $rec.numTurns = $j.num_turns
        $rec.isError = $j.is_error
        $rec.subtype = [string]$j.subtype
        $txt = [string]$j.result
        if ($txt.Length -gt 300) { $txt = $txt.Substring(0, 300) + '…' }
        $rec.finalText = $txt
    } catch {
        $rec.subtype = '输出不是 JSON'
        $txt = [string]$r.stdout
        if (-not $txt) { $txt = [string]$r.stderr }
        if ($txt.Length -gt 300) { $txt = $txt.Substring(0, 300) + '…' }
        $rec.finalText = $txt
    }
    $lines = Get-LogLines
    if ($lines.Count -gt $before) { $rec.mcpCalls = @($lines[$before..($lines.Count - 1)] | Where-Object { $_ -match 'mcp__playwright__' }).Count }

    if (Test-Path $resultPath) {
        try {
            $actual = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $cmp = Compare-Result -Expected $exp -Actual $actual
            $rec.pass = $cmp.pass
            $rec.detail = $cmp.detail
            if ($actual.PSObject.Properties['notes']) { $rec.notes = [string]$actual.notes }
            if ($actual.PSObject.Properties['retries']) { $rec.retries = $actual.retries }
            if ($actual.PSObject.Properties['toolCalls']) { $rec.modelToolCalls = $actual.toolCalls }
        } catch {
            $rec.detail = @('结果文件不是合法 JSON：' + $_.Exception.Message)
        }
    } else {
        $why = ''
        if ($rec.timeout) { $why = '（超时 ' + $TaskTimeoutMin + ' 分钟，已终止）' }
        elseif ($rec.isError) { $why = '（claude 报错：' + $rec.finalText + '）' }
        elseif ($rec.subtype -and $rec.subtype -ne 'success') { $why = '（claude 结束原因：' + $rec.subtype + '）' }
        $rec.detail = @('模型没有写结果文件' + $why)
    }
    $status = '失败'
    $color = 'Red'
    if ($rec.pass) { $status = '通过'; $color = 'Green' }
    $extra = ''
    if ($Test -eq 't3') { $extra = 'MCP 调用 ' + $rec.mcpCalls + ' 次，' }
    Write-Host ('  第' + $Round + '轮 ' + $tag.PadRight(7) + ' ' + $status + '  ' + $extra + $rec.seconds + ' 秒' + $(if ($rec.detail.Count) { '  ' + ($rec.detail -join '；') } else { '' })) -ForegroundColor $color
    return $rec
}

$records = @()
$claude = $null
if (-not $Simulate) { $claude = Resolve-ClaudeCommand }
$modelSkipReason = ''
if (-not $Simulate -and -not $claude) { $modelSkipReason = '找不到 claude 命令' }
elseif (-not $siteOk) { $modelSkipReason = '演示站没有启动' }
elseif (-not $node -and -not $Simulate) { $modelSkipReason = '没有 Node（场景执行器与 MCP 都需要）' }

if ($modelSkipReason) {
    Write-Step ('模型测试跳过：' + $modelSkipReason)
} else {
    Write-Step ('模型测试：' + $Rounds + ' 轮 × ' + $taskCount + ' 项' + $(if ($Simulate) { '（模拟模式，不调用 claude）' } else { '（claude：' + $claude.Target + '）' }))
    for ($r = 1; $r -le $Rounds; $r++) {
        Write-Host ('  --- 第 ' + $r + ' 轮 ' + (Get-Date -Format 'HH:mm:ss') + ' ---')
        if (-not $SkipImg) { $records += Invoke-ModelTask -Round $r -Set 'img' -Test 'task' -Title $expected['img'].title }
        foreach ($s in $setList) {
            $records += Invoke-ModelTask -Round $r -Set $s -Test 't25' -Title $expected[$s].title
            $records += Invoke-ModelTask -Round $r -Set $s -Test 't3' -Title $expected[$s].title
        }
    }
    Write-TextFile -Path (Join-Path $auto 'model\records.json') -Text ($records | ConvertTo-Json -Depth 5)
}

# ---------- 6. 停站 ----------
Write-Step '停止演示站'
Write-Info (Invoke-SiteScript '-Stop')

# ---------- 7. 报告 ----------
function Read-Json { param([string]$P) if (Test-Path $P) { try { return (Get-Content $P -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null } } return $null }
function Fmt-Ok { param($o) if ($null -eq $o) { return '未运行' } if ($o.ok) { return '通过' } return '失败' }
function Pct { param([int]$a, [int]$b) if ($b -le 0) { return '-' } return ([string]$a + '/' + $b + '（' + [int][math]::Round(100.0 * $a / $b) + '%）') }
function Avg { param($arr) $vals = @($arr | Where-Object { $null -ne $_ }); if ($vals.Count -eq 0) { return '-' } return [int][math]::Round(($vals | Measure-Object -Average).Average) }

$env1 = Read-Json (Join-Path $auto 'env.json')
$t1 = Read-Json (Join-Path $auto 'tier1\report.json')
$t2 = Read-Json (Join-Path $auto 'tier2\report.json')
$t25 = Read-Json (Join-Path $auto 'tier25\report.json')
$t3s = Read-Json (Join-Path $auto 'tier3-selftest\report.json')

$L = @()
$L += ('# 浏览器验证全自动体检报告 ' + $ts)
$L += ''
$L += ('- 轮数：' + $Rounds + '；页面套：' + ($setList -join '，') + '；总用时 ' + [int]$swAll.Elapsed.TotalMinutes + ' 分钟' + $(if ($Simulate) { '；**模拟模式（未调用模型）**' } else { '' }))
if ($env1) {
    $L += ('- 环境：' + $env1.os + '；Node ' + $(if ($env1.node) { $env1.node } else { '无' }) + '；浏览器 ' + $(if ($env1.browser) { $env1.browser + '（' + $env1.browserVersion + '）' } else { '无' }) + '；Claude Code ' + $(if ($env1.claude) { $env1.claude } else { '未找到' }) + '；Playwright ' + $env1.playwright + '，MCP ' + $env1.playwrightMcp)
}
$L += ('- 结果目录：' + $auto)
$L += ''
$L += '## 一、脚本测试（不需要模型）'
$L += ''
if ($SkipScripts) { $L += '（本次跳过）' } else {
    $L += '| 档 | 方案 | 结果 | 说明 |'
    $L += '|---|---|---|---|'
    $t1note = ''
    if ($t1 -and $t1.capabilities) { $t1note = '截图 ' + $t1.capabilities.'整页截图' + '；DOM ' + $t1.capabilities.'DOM 文本' + '；console ' + $t1.capabilities.'console 错误' } elseif ($t1 -and $t1.error) { $t1note = [string]$t1.error }
    $L += ('| 1 | 系统浏览器无头命令行 | ' + (Fmt-Ok $t1) + ' | ' + $t1note + ' |')
    $t2note = ''
    if ($t2 -and $t2.steps) {
        $fails = @($t2.steps | Where-Object { -not $_.ok })
        $t2note = '启动方式 ' + $t2.via + '；' + $(if ($fails.Count) { '失败步骤：' + (($fails | ForEach-Object { $_.name }) -join '，') } else { '登录/点击/截图/像素比对/布局树/console 全部可用' })
        if ($t2.eyes -and $t2.eyes.pixel) { $t2note += '；像素差异 ' + ([math]::Round($t2.eyes.pixel.ratio * 100, 2)) + '%' }
        if ($t2.eyes -and $t2.eyes.layout) { $t2note += '；布局差异归组 ' + $t2.eyes.layout.summary.rectGroups + ' 组坐标 + ' + $t2.eyes.layout.summary.styleGroups + ' 组样式' }
    } elseif ($t2 -and $t2.error) { $t2note = [string]$t2.error }
    $L += ('| 2 | Playwright 脚本（固定流程） | ' + (Fmt-Ok $t2) + ' | ' + $t2note + ' |')
    $t25note = ''
    if ($t25 -and $t25.scenarios) { $t25note = ($t25.scenarios | ForEach-Object { $_.file + '：' + $(if ($_.ok) { '通过' } else { '失败（' + $_.failed + '）' }) }) -join '；' } elseif ($t25 -and $t25.error) { $t25note = [string]$t25.error }
    $L += ('| 2.5 | 场景执行器（六套示例场景） | ' + (Fmt-Ok $t25) + ' | ' + $t25note + ' |')
    $t3note = ''
    if ($t3s -and $t3s.steps) {
        $fails = @($t3s.steps | Where-Object { -not $_.ok })
        $t3note = $(if ($fails.Count) { '失败步骤：' + (($fails | ForEach-Object { $_.name + '（' + $_.error + '）' }) -join '，') } else { 'MCP 服务器、快照 ref、填表、点击、等待全部正常；工具调用 ' + $t3s.toolCalls + ' 次' })
    } elseif ($t3s -and $t3s.error) { $t3note = [string]$t3s.error }
    $L += ('| 3 基础 | Playwright MCP 服务器自检（不用模型） | ' + (Fmt-Ok $t3s) + ' | ' + $t3note + ' |')
}
$L += ''
$L += '## 二、模型测试矩阵'
$L += ''
if ($modelSkipReason) { $L += ('（跳过：' + $modelSkipReason + '）') }
elseif ($records.Count -eq 0) { $L += '（没有记录）' }
else {
    $hdr = '| 测试项 |'
    $sep = '|---|'
    for ($r = 1; $r -le $Rounds; $r++) { $hdr += ' 第' + $r + '轮 |'; $sep += '---|' }
    $hdr += ' 通过率 |'
    $sep += '---|'
    $L += $hdr
    $L += $sep
    $rowsDef = @()
    if (-not $SkipImg) { $rowsDef += @{ tag = 'img'; label = '看图能力' } }
    foreach ($s in $setList) {
        $rowsDef += @{ tag = ($s + '-t25'); label = ($s + ' ' + $expected[$s].title + ' · 写场景（2.5 档）') }
        $rowsDef += @{ tag = ($s + '-t3'); label = ($s + ' ' + $expected[$s].title + ' · MCP 直驱（3 档）') }
    }
    foreach ($rd in $rowsDef) {
        $line = '| ' + $rd.label + ' |'
        $passN = 0
        for ($r = 1; $r -le $Rounds; $r++) {
            $rec = $records | Where-Object { $_.tag -eq $rd.tag -and $_.round -eq $r } | Select-Object -First 1
            if ($null -eq $rec) { $line += ' 未跑 |'; continue }
            if ($rec.pass) { $passN++ }
            $cell = $(if ($rec.pass) { '通过' } else { '失败' })
            if ($rec.test -eq 't3') { $cell += '，' + $rec.mcpCalls + ' 次调用' }
            if ($rec.test -eq 't25' -and $null -ne $rec.retries) { $cell += '，重试 ' + $rec.retries }
            $cell += '，' + $rec.seconds + ' 秒'
            if ($rec.timeout) { $cell += '，超时' }
            $line += ' ' + $cell + ' |'
        }
        $line += ' ' + (Pct $passN $Rounds) + ' |'
        $L += $line
    }

    # 统计
    $imgRecs = @($records | Where-Object { $_.set -eq 'img' })
    $t25Recs = @($records | Where-Object { $_.test -eq 't25' })
    $t3Recs = @($records | Where-Object { $_.test -eq 't3' })
    $imgPass = @($imgRecs | Where-Object { $_.pass }).Count
    $t25Pass = @($t25Recs | Where-Object { $_.pass }).Count
    $t3Pass = @($t3Recs | Where-Object { $_.pass }).Count
    $L += ''
    $L += '## 三、统计'
    $L += ''
    $L += '| 指标 | 数值 |'
    $L += '|---|---|'
    if ($imgRecs.Count) { $L += ('| 看图通过率 | ' + (Pct $imgPass $imgRecs.Count) + ' |') }
    $L += ('| 第二点五档（写场景）通过率 | ' + (Pct $t25Pass $t25Recs.Count) + ' |')
    $L += ('| 第二点五档平均耗时 | ' + (Avg ($t25Recs | ForEach-Object { $_.seconds })) + ' 秒 |')
    $L += ('| 第二点五档平均重试次数 | ' + (Avg ($t25Recs | ForEach-Object { $_.retries })) + ' |')
    $L += ('| 第三档（MCP 直驱）通过率 | ' + (Pct $t3Pass $t3Recs.Count) + ' |')
    $L += ('| 第三档平均 MCP 调用次数 | ' + (Avg ($t3Recs | ForEach-Object { $_.mcpCalls })) + ' |')
    $L += ('| 第三档最多 MCP 调用次数 | ' + $(if ($t3Recs.Count) { (@($t3Recs | ForEach-Object { [int]$_.mcpCalls }) | Measure-Object -Maximum).Maximum } else { '-' }) + ' |')
    $L += ('| 第三档平均耗时 | ' + (Avg ($t3Recs | ForEach-Object { $_.seconds })) + ' 秒 |')
    $L += ('| 超时次数 | ' + @($records | Where-Object { $_.timeout }).Count + ' |')

    # 分页面套
    $L += ''
    $L += '| 页面套 | 写场景通过 | MCP 直驱通过 |'
    $L += '|---|---|---|'
    foreach ($s in $setList) {
        $a25 = @($t25Recs | Where-Object { $_.set -eq $s })
        $a3 = @($t3Recs | Where-Object { $_.set -eq $s })
        $L += ('| ' + $s + ' ' + $expected[$s].title + ' | ' + (Pct @($a25 | Where-Object { $_.pass }).Count $a25.Count) + ' | ' + (Pct @($a3 | Where-Object { $_.pass }).Count $a3.Count) + ' |')
    }

    # 结论
    $L += ''
    $L += '## 四、结论（按阈值自动判定）'
    $L += ''
    if ($imgRecs.Count) {
        if ($imgPass -eq $imgRecs.Count) { $L += '- **看图：能。** 截图可以直接给模型做整体判断。' }
        elseif ($imgPass -gt 0) { $L += '- **看图：不稳定。** 有时能读有时不能，截图只能作辅助。' }
        else { $L += '- **看图：不能。** 走零图模式：像素比对数字 + 布局树 + console 文本。' }
    }
    $rate25 = 0; if ($t25Recs.Count) { $rate25 = $t25Pass / $t25Recs.Count }
    if ($rate25 -ge 0.9) { $L += '- **第二点五档：稳定。** 模型能照格式写场景并跑通，可作为默认验证通道。' }
    elseif ($rate25 -ge 0.6) { $L += '- **第二点五档：基本可用。** 失败项见下方明细，多为某类页面写不对选择器，可通过补页面元素说明改善。' }
    else { $L += '- **第二点五档：不稳定。** 模型写场景文件的格式遵从或选择器能力不足。' }
    $rate3 = 0; if ($t3Recs.Count) { $rate3 = $t3Pass / $t3Recs.Count }
    $avg3 = 0; $vals3 = @($t3Recs | ForEach-Object { $_.mcpCalls }); if ($vals3.Count) { $avg3 = ($vals3 | Measure-Object -Average).Average }
    if ($rate3 -ge 0.8 -and $avg3 -le 25) { $L += ('- **第三档：可用于探索性验证。** 通过率高且平均 ' + [int][math]::Round($avg3) + ' 次调用内完成。') }
    elseif ($rate3 -ge 0.6) { $L += '- **第三档：能用但不稳定。** 只做辅助排查，日常回归用第二点五档。' }
    else { $L += '- **第三档：不适合这个模型。** 用第二点五档。' }

    # 失败明细
    $fails = @($records | Where-Object { -not $_.pass })
    $L += ''
    $L += '## 五、失败明细'
    $L += ''
    if ($fails.Count -eq 0) { $L += '无。' } else {
        foreach ($f in $fails) {
            $L += ('- 第' + $f.round + '轮 ' + $f.tag + '（' + $f.title + '）：' + ($f.detail -join '；'))
            if ($f.notes) { $L += ('  - 模型备注：' + $f.notes) }
            if ($f.timeout) { $L += ('  - 超时 ' + $TaskTimeoutMin + ' 分钟被终止') }
            if ($f.subtype -and $f.subtype -ne 'success') { $L += ('  - claude 结束原因：' + $f.subtype + $(if ($f.finalText) { '，最后输出：' + $f.finalText } else { '' })) }
            $L += ('  - 文件：' + $f.resultPath + '（.claude.json / .claude.err.txt 同目录）')
        }
    }
}
$L += ''
$L += '## 六、怎么看'
$L += ''
$L += '- 写场景（2.5 档）= 模型写 JSON 场景文件，脚本执行：确定、便宜、可重复，适合日常回归。'
$L += '- MCP 直驱（3 档）= 模型自己开浏览器：能临场判断，适合探索性验证；调用次数越少越好，超过 25 次说明在打转。'
$L += '- 标准答案在 tests/<套>/expected.json；模型写的结果在 results 目录各轮的 round-N 里，同目录还有 claude 的完整输出。'

$reportPath = Join-Path $auto 'report.md'
Write-TextFile -Path $reportPath -Text ($L -join "`n")
$desktop = [Environment]::GetFolderPath('Desktop')
$desktopCopy = ''
try {
    $desktopCopy = Join-Path $desktop ('浏览器体检报告-' + $ts + '.md')
    Copy-Item $reportPath $desktopCopy -Force
} catch { $desktopCopy = '' }

$swAll.Stop()
Write-Step ('全部完成，用时 ' + [int]$swAll.Elapsed.TotalMinutes + ' 分 ' + ($swAll.Elapsed.Seconds) + ' 秒')
Write-Host ('  报告：' + $reportPath) -ForegroundColor Cyan
if ($desktopCopy) { Write-Host ('  桌面副本：' + $desktopCopy) -ForegroundColor Cyan }
try { Stop-Transcript | Out-Null } catch { }
