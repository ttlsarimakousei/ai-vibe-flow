# 判定自检：对每个用例，用"理想答案"跑一遍判定脚本应判通过，用"典型错答案"跑一遍应判失败。
# 两头都对，才说明这个判定脚本有区分度。上一个体检包就是死在判分标准本身写错上。
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-ProbeRoot
$node = Resolve-NodeExe
$out = New-ResultDir
Write-Step '判定自检（先验判分脚本本身对不对）'

if (-not $node) { Write-Bad '没有 Node，无法自检'; return }

$rows = @()
$cases = @(Get-ChildItem (Join-Path $root 'tests') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'meta.json') } | Sort-Object Name)
foreach ($c in $cases) {
    $row = [ordered]@{ id = $c.Name; ok = $false; detail = '' }
    $st = Join-Path $c.FullName 'selftest.js'
    if (-not (Test-Path $st)) {
        $row.detail = '缺 selftest.js'
        Write-Bad ($c.Name + '：缺 selftest.js，这个用例的判定没有经过验证')
    } else {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        # 经 Invoke-Native 调用：自测脚本或它拉起的进程往 stderr 写任何东西都不会再让这一步崩掉
        # 预加载垫片：自检里的递归 fs.cpSync 在中文路径下会让 Node 直接崩溃，内网就是这样丢了 8 个用例的自检
        $run = Invoke-Native -Exe $node -ArgLine ('"' + $st + '"') -WorkDir $c.FullName -TimeoutSec 900 -ExtraEnv (Get-NodeShimEnv (Join-Path $root 'tools\node-shim.js'))
        $sw.Stop()
        $j = Get-TaggedJson -Text $run.stdout -Tag 'SELFTEST'
        if ($j) {
            $row.ok = [bool]$j.ok
            $row.detail = [string]$j.detail
        } else {
            $tail = (@((([string]$run.stdout) + "`n" + ([string]$run.stderr)) -split "`r?`n" | Where-Object { $_ }) | Select-Object -Last 2) -join ' / '
            $row.detail = '没有输出 SELFTEST 行' + $(if ($run.timedOut) { '（超时）' } elseif ($run.error) { '（' + $run.error + '）' } else { '' }) + '；末尾：' + $tail
        }
        $row.ms = [int]$sw.Elapsed.TotalMilliseconds
        if ($row.ok) { Write-Ok ($c.Name + '：判定有区分度' + $(if ($row.detail) { '（' + $row.detail + '）' } else { '' })) }
        else { Write-Bad ($c.Name + '：' + $row.detail) }
    }
    $rows += $row
}

$bad = @($rows | Where-Object { -not $_.ok })
Write-TextFile -Path (Join-Path $out 'selftest.json') -Text (@{ rows = $rows; failed = $bad.Count } | ConvertTo-Json -Depth 5)
# 注意：PowerShell 里 $x.Count + ' 字符串' 会尝试把字符串转成整数并报错，拼接必须以字符串开头
if ($bad.Count) { Write-Warn2 ([string]$bad.Count + ' / ' + [string]$rows.Count + ' 个用例的判定没通过自检。它们的体检结果不可信，报告里会单独标注') }
else { Write-Ok ('全部 ' + [string]$rows.Count + ' 个用例的判定都能区分对错') }
