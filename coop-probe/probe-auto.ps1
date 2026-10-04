# probe-auto.ps1 —— 协作能力全自动体检：输入轮数后全程无人值守
#   环境检查与 hook 契约 → 地基测量 → 判定自检 → 逐轮跑模型任务 → 机械判定 → 报告落地
# 参数：
#   -Rounds N            轮数（不给则询问，默认 2）
#   -Tests m1,m4         只跑指定用例（默认全部）
#   -JavaProject <路径>  在你的真实项目上量反馈回路时延（不给则询问，直接回车跳过）
#   -BuildCmd "<命令>"   配合上一条；不给就按 pom.xml / package.json / 没有 pom 的老式 Java 工程自动认
#   -TomcatHome <路径>   老工程编译要用 Tomcat 自带的 servlet-api，自动找不到时用它指定
#   -TaskTimeoutMin 25   单个用例超时
#   -MaxTurns 150        单个用例最多回合数
#   -SkipBaseline        跳过地基测量
#   -Simulate            不调模型，用每个用例自带的理想答案与错答案走一遍全流程，验证工装本身
# 模型对比（model-compare.ps1）调用时另外会带：
#   -ModelSettings <文件>  直连某个模型的配置（含地址和 key 的 env 段），代替默认的 .claude\settings.json
#   -ModelName <名字>      报告里写哪个模型
#   -ResultDir <目录>      结果放这里，不另建 auto-时间戳 目录
#   -SkipEnvCheck / -SkipSelftest / -NoDesktopCopy
param(
    [int]$Rounds = 0,
    [string]$Tests = '',
    [string]$JavaProject = '',
    [string]$BuildCmd = '',
    [string]$TomcatHome = '',
    [int]$TaskTimeoutMin = 25,
    [int]$MaxTurns = 150,
    [switch]$SkipBaseline,
    [switch]$Simulate,
    [string]$ModelSettings = '',
    [string]$ModelName = '',
    [string]$ResultDir = '',
    [switch]$SkipEnvCheck,
    [switch]$SkipSelftest,
    [switch]$NoDesktopCopy
)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot

Write-Host ''
Write-Host ('协作能力 · 全自动体检' + $(if ($ModelName) { ' · ' + $ModelName } else { '' })) -ForegroundColor Cyan
Write-Host '（地基测量 + 十几个协作考点 + 机械判定 + 报告落地，中途不需要人操作）'
Write-Host ''

# ---- 用例发现 ----
$allCases = @(Get-ChildItem (Join-Path $root 'tests') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'meta.json') } | Sort-Object Name)
if ($Tests) {
    $want = @($Tests -split '[,\s]+' | Where-Object { $_ })
    # "m1" 只选 m1-edit-hit，不能把 m10~m13 也带上：要么整名相同，要么后面紧跟短横线
    $allCases = @($allCases | Where-Object { $n = $_.Name; @($want | Where-Object { $n -eq $_ -or $n -like ($_ + '-*') }).Count -gt 0 })
}
if (-not $allCases.Count) { Write-Bad 'tests\ 下没有可跑的用例'; return }

$metas = @()
foreach ($c in $allCases) {
    $m = Read-JsonFile (Join-Path $c.FullName 'meta.json')
    if ($m) { $metas += [ordered]@{ dir = $c.FullName; id = $c.Name; meta = $m } }
}

if ($Rounds -le 0) {
    $in = Read-Host ('要测试几轮？共 ' + $metas.Count + ' 个用例，直接回车 = 2')
    if ($in -match '^\d+$' -and [int]$in -gt 0) { $Rounds = [int]$in } else { $Rounds = 2 }
}
if (-not $JavaProject -and -not $Simulate -and -not $SkipBaseline) {
    $JavaProject = ([string](Read-Host '要顺带量编译速度的项目目录（可以把文件夹拖进这个窗口；直接回车跳过）')).Trim().Trim('"')
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$auto = $(if ($ResultDir) { $ResultDir } else { Join-Path $root ('results\auto-' + $ts) })
New-Item -ItemType Directory -Force -Path $auto | Out-Null
$env:PROBE_RESULT_DIR = $auto
try { Start-Transcript -Path (Join-Path $auto 'run.log') -Force | Out-Null } catch { }
$swAll = [System.Diagnostics.Stopwatch]::StartNew()
Write-Info ('轮数 ' + $Rounds + '，用例 ' + $metas.Count + ' 个，单个超时 ' + $TaskTimeoutMin + ' 分钟')
Write-Info ('结果目录：' + $auto)

$node = Resolve-NodeExe
$git = Resolve-GitExe

# 各阶段互相隔离：任何一个阶段出错只记下来，绝不让它中断后面几个小时的模型测试。
# 内网第一次跑就是死在这里：地基测量里 javac 往 stderr 写了一行，整轮体检当场退出，模型测试一道都没开始。
$stageErrors = @()
function Invoke-Stage {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body }
    catch {
        $msg = $_.Exception.Message
        $script:stageErrors += ($Name + '：' + $msg)
        Write-Bad ($Name + ' 出错，已跳过这一阶段继续往下跑：' + $msg)
    }
}

# ---- 环境与 hook 契约 ----
if (-not $SkipEnvCheck) { Invoke-Stage '环境检查' { & (Join-Path $root '1-check-env.ps1') } }

# ---- 地基测量 ----
if (-not $SkipBaseline) {
    Invoke-Stage '地基测量' { & (Join-Path $root '2-baseline.ps1') -JavaProject $JavaProject -BuildCmd $BuildCmd -TomcatHome $TomcatHome }
}

# ---- 判定自检 ----
if (-not $SkipSelftest) { Invoke-Stage '判定自检' { & (Join-Path $root 'tools\run-selftests.ps1') } }
$selftest = Read-JsonFile (Join-Path $auto 'selftest.json')
$badJudges = @()
if ($selftest -and $selftest.rows) { $badJudges = @($selftest.rows | Where-Object { -not $_.ok } | ForEach-Object { $_.id }) }

# ---- 模型测试 ----
$claude = $null
if (-not $Simulate) { $claude = Resolve-ClaudeCommand }
$skipReason = ''
if (-not $node) { $skipReason = '没有 Node' }
elseif (-not $Simulate -and -not $claude) { $skipReason = '找不到 claude 命令' }

function Copy-Fixture {
    param([string]$Src, [string]$Dst)
    New-Item -ItemType Directory -Force -Path $Dst | Out-Null
    if (Test-Path $Src) { Copy-Item (Join-Path $Src '*') -Destination $Dst -Recurse -Force -ErrorAction SilentlyContinue }
}

function Invoke-Verify {
    param([string]$CaseDir, [string]$WorkDir, [string]$ErrLog)
    $v = Join-Path $CaseDir 'verify.js'
    if (-not (Test-Path $v)) { return @{ pass = $false; points = @(); notes = '缺 verify.js' } }
    # 经 Invoke-Native 调用：判定脚本或它拉起的被测代码往 stderr 写任何东西，都不会再让这一次判定丢失
    # 预加载垫片：判定脚本里的递归 fs.cpSync 在中文路径下会让 Node 直接崩溃
    $run = Invoke-Native -Exe $node -ArgLine ('"' + $v + '" "' + $WorkDir + '"') -WorkDir $root -TimeoutSec 900 -ExtraEnv (Get-NodeShimEnv (Join-Path $root 'tools\node-shim.js'))
    if ($ErrLog -and $run.stderr) { Write-TextFile -Path $ErrLog -Text ([string]$run.stderr) }
    $j = Get-TaggedJson -Text $run.stdout -Tag 'VERIFY'
    if (-not $j) {
        $tail = (@((([string]$run.stdout) + "`n" + ([string]$run.stderr)) -split "`r?`n" | Where-Object { $_ }) | Select-Object -Last 2) -join ' / '
        $why = $(if ($run.timedOut) { '（超时）' } elseif ($run.error) { '（' + $run.error + '）' } else { '' })
        return @{ pass = $false; points = @(); notes = ('判定脚本没有输出 VERIFY 行' + $why + '；末尾：' + $tail) }
    }
    return @{ pass = [bool]$j.pass; points = @($j.points); notes = [string]$j.notes }
}

function Invoke-ClaudeCase {
    param([string]$WorkDir, [string]$Id, [int]$Round, [string]$LogPath, [int]$Timeout)
    $prompt = '[协作体检 第' + [string]$Round + '轮 ' + $Id + '] 用 Read 工具读取 task.md，严格按其中要求执行。做完后只回复一行：完成。'
    $settingsPath = $(if ($ModelSettings) { $ModelSettings } else { Join-Path $root '.claude\settings.json' })
    $argStr = '-p "' + $prompt + '" --output-format json --max-turns ' + [string]$MaxTurns + ' --settings "' + $settingsPath + '"'
    $exe = $claude.Target
    $line = $argStr
    if ($claude.Wrap -eq 'ps1') { $exe = 'powershell.exe'; $line = '-NoProfile -ExecutionPolicy Bypass -File "' + $claude.Target + '" ' + $argStr }
    elseif ($claude.Wrap -eq 'cmd') { $exe = 'cmd.exe'; $line = '/s /c ""' + $claude.Target + '" ' + $argStr + '"' }
    # 经 Invoke-Native：超时会连同子进程一起终止，进程退出后最多再等 15 秒读输出，不会让无人值守的整轮挂死
    $r = Invoke-Native -Exe $exe -ArgLine $line -WorkDir $WorkDir -ExtraEnv @{ PROBE_TOOLLOG = $LogPath } -RemoveEnv @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT') -TimeoutSec ($Timeout * 60)
    $err = [string]$r.stderr
    if ($r.error) { $err = '启动 claude 失败：' + $r.error + "`n" + $err }
    return @{ timeout = [bool]$r.timedOut; exitCode = $r.exitCode; stdout = [string]$r.stdout; stderr = $err }
}

# 这一题是不是因为模型当时不可用（限流、额度、网关出错、连不上）才没做成。只认接口层面的错误：
# Claude Code 的结果里 terminal_reason 为 api_error，或者报错文字以 "API Error" 开头（实测形如
# "API Error: Repeated 529 Overloaded errors..."）。400 这类协议错误说明模型或网关和 Claude Code 配合有问题，照常算失败
function Get-ApiFailure {
    param($R2)
    $j = $null
    $jl = @(([string]$R2.stdout) -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
    if ($jl) { try { $j = $jl | ConvertFrom-Json } catch { $j = $null } }
    $text = ''
    if ($j) {
        if (-not [bool]$j.is_error) { return '' }
        $text = [string]$j.result + ' ' + [string]$j.terminal_reason + ' ' + [string]$j.api_error_status
    } elseif ($R2.timeout) { return '' }
    $all = $text + ' ' + [string]$R2.stderr
    if ($all -match '(?i)API Error: (Repeated )?(400|413|422)\b|Missing Tool Result|tool use concurrency|duplicate tool_use') { return '' }
    $pat = '(?i)\bapi_error\b|API Error: (Repeated )?(401|403|429|5\d\d)\b|API Error: (No response|Request timed out|Connection error)|API Error \(Connection|Overloaded|rate.?limit|at capacity|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|Unable to connect'
    if ($all -notmatch $pat) { return '' }
    $why = $(if ($j -and $j.result) { ([string]$j.result).Trim() } else { $all.Trim() })
    if ($why.Length -gt 120) { $why = $why.Substring(0, 120) + '…' }
    return $why
}

$records = @()
$consecUnavail = 0
if ($skipReason) {
    Write-Step ('模型测试跳过：' + $skipReason)
} else {
    Write-Step ('模型测试：' + $Rounds + ' 轮 × ' + $metas.Count + ' 个用例' + $(if ($Simulate) { '（模拟模式：用自带样本走流程，不调模型）' } else { '' }))
    for ($r = 1; $r -le $Rounds; $r++) {
        Write-Host ('  --- 第 ' + $r + ' 轮 ' + (Get-Date -Format 'HH:mm:ss') + ' ---')
        $roundDir = Join-Path $auto ('round-' + $r)

        # 先把这一轮所有工作区建好，然后一次性标记信任（每个工作区都会 git init 成独立项目根）
        $prepared = @()
        foreach ($m in $metas) {
            $work = Join-Path $roundDir $m.id
            if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
            Copy-Fixture -Src (Join-Path $m.dir 'fixture') -Dst $work
            Copy-Item (Join-Path $m.dir 'task.md') -Destination (Join-Path $work 'task.md') -Force -ErrorAction SilentlyContinue
            if ($git -and $m.meta.needsGit) {
                # git 往 stderr 写的换行符警告在 PS 5.1 里会被包成 ErrorRecord 并被 $ErrorActionPreference='Stop' 变成致命错误，
                # 所以这一段临时放开，并关掉 autocrlf 从根上消掉那条警告
                $prevEap = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                Push-Location $work
                try {
                    & $git init -q --quiet | Out-Null
                    & $git config core.autocrlf false | Out-Null
                    & $git config user.name probe | Out-Null
                    & $git config user.email probe@local | Out-Null
                    & $git add -A | Out-Null
                    & $git commit -q -m baseline | Out-Null
                } catch { } finally { Pop-Location; $ErrorActionPreference = $prevEap }
            }
            $prepared += @{ meta = $m; work = $work }
        }
        # 经 Invoke-Native：直接 & node 的话，它往 stderr 写一行就会被 PowerShell 5.1 当成致命错误，整轮就断了
        if ($node -and -not $Simulate) {
            $targets = (@($prepared | ForEach-Object { '"' + $_.work + '"' })) -join ' '
            $tr = Invoke-Native -Exe $node -ArgLine ('"' + (Join-Path $root 'tools\trust-project.js') + '" ' + $targets) -TimeoutSec 60
            if ($tr.exitCode -ne 0) { Write-Warn2 ('标记工作区信任没成功，继续跑（hook 计数可能为 0）：' + (([string]$tr.stderr) + ' ' + ([string]$tr.error)).Trim()) }
        }

        foreach ($pp in $prepared) {
            $m = $pp.meta
            $work = $pp.work
            $rec = [ordered]@{ round = $r; id = $m.id; name = [string]$m.meta.name; probes = @($m.meta.probes); pass = $false; seconds = 0; toolCalls = 0; timeout = $false; points = @(); notes = ''; judgeUnverified = ($badJudges -contains $m.id); work = $work }
            $logPath = Join-Path $roundDir ($m.id + '.tools.log')
            $timeout = $(if ($m.meta.timeoutMin) { [int]$m.meta.timeoutMin } else { $TaskTimeoutMin })
            # 连续两题都是模型不可用，说明它被关了，剩下的题不再白等
            if ($consecUnavail -ge 2) {
                $rec.unavailable = $true
                $rec.notes = '模型已经连续两题不可用，这一题没跑'
                $records += $rec
                Write-Host ('  第' + $r + '轮 ' + $m.id.PadRight(20) + ' 没跑（模型不可用）') -ForegroundColor Yellow
                continue
            }
            $sw = [System.Diagnostics.Stopwatch]::StartNew()

            try {
            if ($Simulate) {
                # 模拟：先用理想答案跑一遍（应通过），再用错答案跑一遍（应失败），验证工装能区分
                $passSrc = Join-Path $m.dir 'selftest\pass'
                $failSrc = Join-Path $m.dir 'selftest\fail'
                if (Test-Path $passSrc) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; Copy-Fixture -Src $passSrc -Dst $work }
                $vp = Invoke-Verify -CaseDir $m.dir -WorkDir $work
                $workF = $work + '-fail'
                if (Test-Path $failSrc) { Copy-Fixture -Src $failSrc -Dst $workF }
                $vf = Invoke-Verify -CaseDir $m.dir -WorkDir $workF
                $rec.pass = ($vp.pass -and -not $vf.pass)
                $rec.points = $vp.points
                $rec.notes = '理想答案判 ' + $(if ($vp.pass) { '通过' } else { '失败（' + $vp.notes + '）' }) + '；错答案判 ' + $(if ($vf.pass) { '通过（工装没有区分度）' } else { '失败' })
            } else {
                $r2 = Invoke-ClaudeCase -WorkDir $work -Id $m.id -Round $r -LogPath $logPath -Timeout $timeout
                $rec.timeout = $r2.timeout
                $rec.exitCode = $r2.exitCode
                Write-TextFile -Path (Join-Path $roundDir ($m.id + '.claude.json')) -Text ([string]$r2.stdout)
                if ($r2.stderr) { Write-TextFile -Path (Join-Path $roundDir ($m.id + '.claude.err.txt')) -Text ([string]$r2.stderr) }
                try {
                    $jsonLine = @(([string]$r2.stdout) -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
                    if ($jsonLine) {
                        $j = $jsonLine | ConvertFrom-Json
                        $rec.numTurns = $j.num_turns
                        $rec.isError = $j.is_error
                        $txt = [string]$j.result
                        if ($txt.Length -gt 200) { $txt = $txt.Substring(0, 200) + '…' }
                        $rec.finalText = $txt
                    }
                } catch { }
                if (Test-Path $logPath) { $rec.toolCalls = @(Get-Content $logPath -Encoding UTF8 | Where-Object { $_ -match "`tPostToolUse`t" }).Count }
                $apiFail = Get-ApiFailure $r2
                if ($apiFail) {
                    # 接口层面的失败：不算模型做错，单独标出来，不进通过率
                    $rec.unavailable = $true
                    $rec.notes = '模型当时不可用：' + $apiFail
                    $consecUnavail++
                } else {
                    $consecUnavail = 0
                    $v = Invoke-Verify -CaseDir $m.dir -WorkDir $work -ErrLog (Join-Path $roundDir ($m.id + '.verify.err.txt'))
                    $rec.pass = $v.pass
                    $rec.points = $v.points
                    $rec.notes = $v.notes
                }
            }
            } catch {
                # 单个用例出任何意外都只算它自己失败，不连累后面的用例
                $rec.pass = $false
                $rec.notes = '这个用例执行时出错：' + $_.Exception.Message
                Write-Bad ($m.id + ' 执行出错，记为失败并继续：' + $_.Exception.Message)
            }

            $sw.Stop()
            $rec.seconds = [int]$sw.Elapsed.TotalSeconds
            $records += $rec
            $status = $(if ($rec.unavailable) { '不可用' } elseif ($rec.pass) { '通过' } else { '失败' })
            $color = $(if ($rec.unavailable) { 'Yellow' } elseif ($rec.pass) { 'Green' } else { 'Red' })
            $failed = @($rec.points | Where-Object { -not $_.pass } | ForEach-Object { $_.key })
            $extra = ''
            if (-not $Simulate) { $extra = '，' + $rec.toolCalls + ' 步' }
            if ($rec.timeout) { $extra += '，超时' }
            if ($failed.Count) { $extra += '，未过：' + ($failed -join '/') }
            elseif ($rec.notes -and -not $rec.pass) { $extra += '，' + $rec.notes }
            Write-Host ('  第' + $r + '轮 ' + $m.id.PadRight(20) + ' ' + $status + '  ' + $rec.seconds + ' 秒' + $extra) -ForegroundColor $color
        }
    }
    Write-TextFile -Path (Join-Path $auto 'records.json') -Text ($records | ConvertTo-Json -Depth 8)
}

# ---------- 报告 ----------
$env1 = Read-JsonFile (Join-Path $auto 'env.json')

function Pct { param([int]$a, [int]$b) if ($b -le 0) { return '-' } return ([string]$a + '/' + $b + '（' + [int][math]::Round(100.0 * $a / $b) + '%）') }
function Avg { param($arr) $v = @($arr | Where-Object { $null -ne $_ }); if (-not $v.Count) { return '-' } return [int][math]::Round(($v | Measure-Object -Average).Average) }

$L = @()
$L += ('# 协作能力体检报告 ' + $(if ($ModelName) { $ModelName + ' ' } else { '' }) + $ts)
$L += ''
$L += ('- 轮数：' + $Rounds + '；用例：' + $metas.Count + ' 个；总用时 ' + [int]$swAll.Elapsed.TotalMinutes + ' 分钟' + $(if ($Simulate) { '；**模拟模式（未调模型，只验工装）**' } else { '' }))
if ($env1) {
    $L += ('- 环境：' + $env1.os + '；Node ' + $env1.node + '；Claude Code ' + $(if ($env1.claude) { $env1.claude } else { '未找到' }) + '；模型端点 ' + $(if ($env1.baseUrl) { $env1.baseUrl } else { '未配置' }))
}
$L += ('- 结果目录：' + $auto)
$L += ''

$L += '## 一、地基（这些数决定了后面所有设计成不成立）'
$L += ''
if ($stageErrors.Count) {
    $L += ('**有阶段出错并被跳过**：' + ($stageErrors -join '；') + '。其余阶段照常完成，下面缺的数据就是这些阶段没产出的。')
    $L += ''
}
if ($env1 -and $env1.hookContract) {
    $fired = @($env1.hookContract.fired)
    $L += ('**hook 契约**：本次触发的事件为 ' + $(if ($fired.Count) { $fired -join '，' } else { '无' }) + '。')
    if (-not $env1.hookContract.sessionOk) { $L += '  但这次探测的会话本身失败了，一个工具都没跑起来，所以工具类事件的结论无效，需要在 claude 能正常工作后重测。' }
    elseif ($env1.hookContract.toolsUnknown) { $L += '  模型这次探测时没有真的调用工具，工具类事件没法判定。以第三节各用例的步数为准：步数不全是 0，就说明 PostToolUse 正常。' }
    elseif ($fired -notcontains 'PostToolUse') { $L += '  PostToolUse 在模型调用了工具的情况下仍未触发，所有依赖 hook 的护栏设计都要先解决这个问题，本报告里的步数统计也不可信。' }
    $L += ''
}
# 地基三段的内容由 2-baseline.ps1 自己写成片段，这里原样嵌入，两边不再各写一遍、各出各的错
$baseMd = Join-Path $auto 'baseline\baseline.md'
if (Test-Path $baseMd) {
    $L += @((Get-Content $baseMd -Raw -Encoding UTF8) -split "`n")
    $L += ''
} elseif (-not $SkipBaseline) { $L += '地基测量没有产出结果，原因见上面的阶段错误。'; $L += '' }

$L += '## 二、判定自检'
$L += ''
if ($selftest -and $selftest.rows) {
    if ($badJudges.Count) { $L += ('有 ' + $badJudges.Count + ' 个用例的判定脚本没通过自检：' + ($badJudges -join '，') + '。它们的体检结果不可信，下面矩阵里带星号标出。') }
    else { $L += ('全部 ' + @($selftest.rows).Count + ' 个用例的判定脚本都能区分对错。') }
} else { $L += '未运行。' }
$L += ''

$L += '## 三、用例矩阵'
$L += ''
if ($skipReason) { $L += ('（跳过：' + $skipReason + '）') }
elseif (-not $records.Count) { $L += '（没有记录）' }
else {
    $hdr = '| 用例 | 考点 |'
    $sep = '|---|---|'
    for ($r = 1; $r -le $Rounds; $r++) { $hdr += ' 第' + $r + '轮 |'; $sep += '---|' }
    $hdr += ' 通过率 |'
    $sep += '---|'
    $L += $hdr
    $L += $sep
    foreach ($m in $metas) {
        $star = $(if ($badJudges -contains $m.id) { ' *' } else { '' })
        $line = '| ' + $m.id + ' ' + $m.meta.name + $star + ' | ' + (@($m.meta.probes) -join '/') + ' |'
        $passN = 0
        $ranN = 0
        for ($r = 1; $r -le $Rounds; $r++) {
            $rec = $records | Where-Object { $_.id -eq $m.id -and $_.round -eq $r } | Select-Object -First 1
            if (-not $rec) { $line += ' 未跑 |'; continue }
            if ($rec.unavailable) { $line += ' 模型不可用 |'; continue }
            $ranN++
            if ($rec.pass) { $passN++ }
            $cell = $(if ($rec.pass) { '通过' } else { '失败' })
            if (-not $Simulate) { $cell += '，' + $rec.toolCalls + ' 步' }
            $cell += '，' + $rec.seconds + ' 秒'
            if ($rec.timeout) { $cell += '，超时' }
            $line += ' ' + $cell + ' |'
        }
        $line += ' ' + (Pct $passN $ranN) + ' |'
        $L += $line
    }
    $L += ''
    # 模型当时不可用的题不算它做错，也不进通过率和平均数
    $ran = @($records | Where-Object { -not $_.unavailable })
    $unav = @($records | Where-Object { $_.unavailable })
    $L += ('通过率 ' + (Pct @($ran | Where-Object { $_.pass }).Count $ran.Count) + '；平均每个用例 ' + (Avg ($ran | ForEach-Object { $_.seconds })) + ' 秒' + $(if (-not $Simulate) { '、' + (Avg ($ran | ForEach-Object { $_.toolCalls })) + ' 步' } else { '' }) + '；超时 ' + @($ran | Where-Object { $_.timeout }).Count + ' 次。' + $(if ($unav.Count) { '另有 ' + [string]$unav.Count + ' 题因为模型当时不可用没跑成，不计入。' } else { '' }))
    $L += ''

    $L += '## 四、按考点看'
    $L += ''
    $L += '| 考点 | 通过 | 说明 |'
    $L += '|---|---|---|'
    $probeMap = @{}
    foreach ($rec in $ran) { foreach ($p in @($rec.probes)) { if (-not $probeMap.ContainsKey($p)) { $probeMap[$p] = @() }; $probeMap[$p] += $rec } }
    foreach ($k in ($probeMap.Keys | Sort-Object)) {
        $arr = $probeMap[$k]
        $n = @($arr | Where-Object { $_.pass }).Count
        $names = (@($arr | ForEach-Object { $_.name }) | Select-Object -Unique) -join '，'
        $L += ('| ' + $k + ' | ' + (Pct $n $arr.Count) + ' | ' + $names + ' |')
    }
    $L += ''

    $L += '## 五、失败明细'
    $L += ''
    $fails = @($ran | Where-Object { -not $_.pass })
    if ($unav.Count) { $L += ('模型当时不可用、没跑成的题：' + ((@($unav | ForEach-Object { '第' + [string]$_.round + '轮 ' + $_.id })) -join '，') + '。原因：' + [string]$unav[0].notes); $L += '' }
    if (-not $fails.Count) { $L += '无。' }
    else {
        foreach ($f in $fails) {
            $L += ('- 第' + $f.round + '轮 ' + $f.id + '（' + $f.name + '）')
            foreach ($pt in @($f.points | Where-Object { -not $_.pass })) { $L += ('  - 未过 ' + $pt.key + '：' + $pt.detail) }
            if ($f.notes) { $L += ('  - 判定备注：' + $f.notes) }
            if ($f.timeout) { $L += ('  - 超时 ' + $TaskTimeoutMin + ' 分钟被终止') }
            if ($f.judgeUnverified) { $L += '  - 注意：这个用例的判定脚本没通过自检，失败可能是判错' }
            $L += ('  - 工作区：' + $f.work)
        }
    }
    $L += ''
}

$L += '## 六、怎么读这份报告'
$L += ''
$L += '- 每个用例都是从四个真实项目转录里提炼出来的失败场景，模型在一份独立的样本工程副本上干活，判定全部由脚本完成，不看它写了什么漂亮话。'
$L += '- 步数是工具调用次数。同一个用例几轮之间步数稳定说明行为可预测；某一轮突然翻倍说明它在打转。'
$L += '- 带星号的用例判定脚本本身没通过自检，结果仅供参考。'
$L += '- 通过率低的考点，去看第五节的失败明细和工作区，那里能看出它是做错了还是根本没做。'

$reportPath = Join-Path $auto 'report.md'
Write-TextFile -Path $reportPath -Text ($L -join "`n")
$desktopCopy = ''
if (-not $NoDesktopCopy) { try { $desktopCopy = Join-Path ([Environment]::GetFolderPath('Desktop')) ('协作体检报告-' + $ts + '.md'); Copy-Item $reportPath $desktopCopy -Force } catch { $desktopCopy = '' } }

$swAll.Stop()
Write-Step ('全部完成，用时 ' + [int]$swAll.Elapsed.TotalMinutes + ' 分 ' + $swAll.Elapsed.Seconds + ' 秒')
Write-Host ('  报告：' + $reportPath) -ForegroundColor Cyan
if ($desktopCopy) { Write-Host ('  桌面副本：' + $desktopCopy) -ForegroundColor Cyan }
try { Stop-Transcript | Out-Null } catch { }
