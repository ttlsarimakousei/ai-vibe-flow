# model-compare.ps1 —— 逐个模型直连测一遍，出一份对比报告：谁当主力、谁当审查、失败切换切过去能不能兜住、谁能看图
#   模型清单在 models.json（第一次运行时会从你的模型路由配置里导入）。不经过路由，每个模型用自己的地址和 key，
#   不会像上次那样中途被路由悄悄切到别的模型，一个模型一份成绩。
#   每个模型依次测：探活 → 首字时延、提示缓存、回复方式 → 看图 → 协作题各跑一轮。
#   探活不通的跳过、标"当时不可用"；中途被关（限流、额度、网关出错）的，剩下的题停下、标"没测完"，不算它能力差。
#   以后再双击，直接回车就只补测还没测完的，结果自动并进同一份对比报告。
# 参数：-Models "DeepSeek,GLM"   直接指定要测的模型（名字对应 models.json），不再询问
#       -Rounds 1                协作题每题跑几轮
#       -Tests m1,m13            只跑部分协作题
#       -SkipCoop / -SkipVision / -SkipLatency   跳过某一项
#       -ReportOnly              不测，只用已有结果重新出对比报告
param([string]$Models = '', [int]$Rounds = 1, [string]$Tests = '', [switch]$SkipCoop, [switch]$SkipVision, [switch]$SkipLatency, [switch]$ReportOnly)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
. (Join-Path $PSScriptRoot 'tools\models.ps1')
$root = Get-ProbeRoot
$node = Resolve-NodeExe
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host '模型对比：每个模型直连测一遍，不经过路由' -ForegroundColor Cyan
if (-not $node) { Write-Bad '没有 Node（随包的 offline\node\node.exe 也不在），跑不了'; return }

$list = @(Read-Models)
if (-not $list.Count) {
    Write-Bad '还没有可测的模型'
    Write-Info ('照着 models.example.json 的格式，在 ' + (Get-ModelsPath) + ' 里填上每个模型的地址和 key，再双击一次')
    return
}

$runDir = Join-Path $root ('results\models-run-' + $ts)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

if (-not $ReportOnly) {
    $sel = @()
    if ($Models) {
        $want = @($Models -split '[,，\s]+' | Where-Object { $_ })
        $sel = @($list | Where-Object { $want -contains $_.name })
    } else { $sel = @(Select-Models $list) }
    if (-not $sel.Count) { Write-Warn2 '没有选中任何模型，只用已有结果出报告' }
    else {
        Write-Info ('这次测：' + (($sel | ForEach-Object { $_.name }) -join '，') + '。每个模型大约 40 分钟，中途不用管')
        Write-Info '这一轮很吃额度，最好错开大家用模型的高峰'
    }

    # 公共准备只做一次：体检用的配置（放行本地工具、计数 hook）和判定自检
    $env:PROBE_RESULT_DIR = $runDir
    if ($sel.Count) {
        & (Join-Path $root '1-check-env.ps1') -SettingsOnly
        if (-not $SkipCoop) { try { & (Join-Path $root 'tools\run-selftests.ps1') } catch { Write-Bad ('判定自检出错：' + $_.Exception.Message) } }
    }
    $baseSettings = Join-Path $root '.claude\settings.json'

    $i = 0
    foreach ($m in $sel) {
        $i++
        Write-Step ('模型 ' + [string]$i + '/' + [string]$sel.Count + '：' + $m.name)
        $mts = Get-Date -Format 'yyyyMMdd-HHmmss'
        $mdir = Join-Path $root ('results\models\' + $m.safe + '\' + $mts)
        New-Item -ItemType Directory -Force -Path $mdir | Out-Null
        $sum = [ordered]@{ name = $m.name; ts = $mts; endpoint = ''; status = 'done'; reason = ''; notes = @() }
        try { $sum.endpoint = ([Uri]$m.base_url).Authority } catch { $sum.endpoint = '?' }
        $direct = Get-DirectEnv $m
        $pm = Get-ProbeModelName $m
        $routerBefore = Get-RouterTotal
        $tmpSettings = ''
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            # 1. 探活：一个小的流式请求，不通就跳过这个模型
            $pr = Invoke-Native -Exe $node -ArgLine ('"' + (Join-Path $root 'tools\stream-check.js') + '" --base "' + $m.base_url + '" --model "' + $pm + '" --format anthropic') -ExtraEnv $direct -TimeoutSec 200
            $ping = Get-TaggedJson -Text $pr.stdout -Tag 'STREAM'
            $sum.ping = $ping
            if (-not $ping -or [int]$ping.status -ne 200) {
                $sum.status = 'unavailable'
                $code = $(if ($ping) { [int]$ping.status } else { 0 })
                $err = $(if ($ping) { [string]$ping.error } else { ([string]$pr.stderr + ' ' + [string]$pr.error).Trim() })
                $sum.reason = Get-UnavailableReason $code $err
                Write-Bad ('探活不通，跳过：' + $sum.reason)
                continue
            }
            Write-Ok ('探活通过，回复' + $(if ($ping.verdict -eq 'streaming') { '是边写边出的' } elseif ($ping.verdict -eq 'buffered') { '是攒成整段一次给的' } else { '方式看不出来' }))

            # 2. 首字时延、提示缓存、回复方式
            if (-not $SkipLatency) {
                Write-Info '首字时延与提示缓存……'
                $null = Invoke-Native -Exe $node -ArgLine ('"' + (Join-Path $root 'tools\latency-probe.js') + '" --out "' + (Join-Path $mdir 'latency') + '" --model "' + $pm + '"') -ExtraEnv $direct -TimeoutSec 900
                $lat = Read-JsonFile (Join-Path $mdir 'latency\latency.json')
                if ($lat) { $sum.latency = $lat; foreach ($n in @($lat.notes)) { Write-Info $n } }
                else { $sum.notes += '时延探测没有产出结果' }
            }

            # 3. 看图
            if (-not $SkipVision) {
                Write-Info '看图……'
                $vr = Invoke-Native -Exe $node -ArgLine ('"' + (Join-Path $root 'tools\vision-check.js') + '" --out "' + (Join-Path $mdir 'vision') + '" --model "' + $pm + '"') -ExtraEnv $direct -TimeoutSec 900
                $vis = Get-TaggedJson -Text $vr.stdout -Tag 'VISION'
                if ($vis) {
                    $sum.vision = $vis
                    if ($vis.supported -eq $false) { Write-Warn2 ('不收图片：' + [string]$vis.error) }
                    else { Write-Ok ('看图 ' + [string]$vis.score + '/' + [string]$vis.max) }
                } else { $sum.notes += '看图测试没有产出结果' }
            }

            # 4. 协作题：Claude Code 直连这个模型，配置经 --settings 带进去
            if (-not $SkipCoop) {
                $tmpSettings = New-ModelSettings -Model $m -BaseSettings $baseSettings
                $coopDir = Join-Path $mdir 'coop'
                & (Join-Path $root 'probe-auto.ps1') -Rounds $Rounds -Tests $Tests -ModelSettings $tmpSettings -ModelName $m.name -ResultDir $coopDir -SkipEnvCheck -SkipBaseline -SkipSelftest -NoDesktopCopy
                $recs = @()
                $rj = Read-JsonFile (Join-Path $coopDir 'records.json')
                if ($rj) { $recs = @($rj) }
                $avail = @($recs | Where-Object { -not $_.unavailable })
                $passN = @($avail | Where-Object { $_.pass }).Count
                $steps = @($avail | ForEach-Object { [double]$_.toolCalls })
                $secs = @($avail | ForEach-Object { [double]$_.seconds })
                $sum.coop = [ordered]@{
                    total = $recs.Count
                    ran = $avail.Count
                    pass = $passN
                    avgSteps = $(if ($steps.Count) { [math]::Round(($steps | Measure-Object -Average).Average, 1) } else { $null })
                    avgSeconds = $(if ($secs.Count) { [int](($secs | Measure-Object -Average).Average) } else { $null })
                    unavailable = $recs.Count - $avail.Count
                    cases = @($recs | ForEach-Object { [ordered]@{ id = $_.id; round = $_.round; pass = [bool]$_.pass; unavailable = [bool]$_.unavailable; steps = $_.toolCalls; seconds = $_.seconds; failed = @(@($_.points) | Where-Object { -not $_.pass } | ForEach-Object { $_.key }) } })
                }
                $b = @($recs | Where-Object { $_.id -like 'm13*' -and -not $_.unavailable }) | Select-Object -First 1
                if ($b) {
                    $pt = @($b.points) | Where-Object { $_.key -eq 'items' } | Select-Object -First 1
                    if ($pt -and ([string]$pt.detail -match '(\d+)\s*/\s*10')) { $sum.batchDone = [int]$matches[1] }
                    $sum.batchPass = [bool]$b.pass
                }
                if ($sum.coop.unavailable -gt 0) { $sum.status = 'partial'; $sum.reason = '协作题有 ' + [string]$sum.coop.unavailable + ' 题因为模型当时不可用没跑成' }
                Write-Ok ('协作题 ' + [string]$passN + '/' + [string]$avail.Count + ' 通过' + $(if ($sum.coop.unavailable) { '，' + [string]$sum.coop.unavailable + ' 题没跑成（模型不可用）' } else { '' }))
            }
        } catch {
            $sum.notes += ('测这个模型时出错：' + $_.Exception.Message)
            Write-Bad ('出错：' + $_.Exception.Message)
        } finally {
            if ($tmpSettings) { Remove-Item -LiteralPath $tmpSettings -Force -ErrorAction SilentlyContinue }
            $sw.Stop()
            $sum.minutes = [math]::Round($sw.Elapsed.TotalMinutes, 1)
            $routerAfter = Get-RouterTotal
            if ($null -ne $routerBefore -and $null -ne $routerAfter -and $routerAfter -gt $routerBefore) {
                $sum.routerDelta = $routerAfter - $routerBefore
                $sum.notes += ('测试期间路由多了 ' + [string]$sum.routerDelta + ' 条请求。如果这段时间你没在用别的 Claude 会话，说明有请求绕回了路由，这个模型的成绩要打个问号')
                Write-Warn2 $sum.notes[-1]
            }
            Write-TextFile -Path (Join-Path $mdir 'summary.json') -Text ($sum | ConvertTo-Json -Depth 10)
        }
    }
    $env:PROBE_RESULT_DIR = $null
}

# ---------- 对比报告：每个模型取最近一次有成绩的结果，以后补测的模型会自动并进来 ----------
Write-Step '对比报告'
$rows = @()
foreach ($m in $list) {
    $runs = @(Get-ModelRuns $m.safe)
    if (-not $runs.Count) { continue }
    $best = @($runs | Where-Object { $_.status -eq 'done' -or $_.status -eq 'partial' }) | Select-Object -First 1
    $rows += [pscustomobject]@{ name = $m.name; latest = $runs[0]; best = $best }
}
if (-not $rows.Count) { Write-Warn2 '还没有任何模型的结果'; return }

function Get-Rate { param($S) if (-not $S -or -not $S.coop -or [int]$S.coop.ran -le 0) { return $null }; return ([double]$S.coop.pass / [double]$S.coop.ran) }
function Get-CoopCell {
    param($S)
    if (-not $S -or -not $S.coop) { return '-' }
    if ([int]$S.coop.ran -eq 0) { return '一题都没跑成（模型不可用）' }
    $t = [string]$S.coop.pass + '/' + [string]$S.coop.ran
    if ([int]$S.coop.unavailable -gt 0) { $t += '（另有 ' + [string]$S.coop.unavailable + ' 题没跑成）' }
    return $t
}
function Get-LatCell {
    param($S)
    if (-not $S -or -not $S.latency -or -not $S.latency.rows) { return '-' }
    $r = @($S.latency.rows | Where-Object { [int]$_.size -eq 32000 })
    $c = $r | Where-Object { [int]$_.run -eq 1 } | Select-Object -First 1
    $w = $r | Where-Object { [int]$_.run -eq 2 } | Select-Object -First 1
    if (-not $c -or $null -eq $c.ttftMs) { return '-' }
    return ([string][math]::Round([double]$c.ttftMs / 1000, 1) + ' / ' + $(if ($w -and $null -ne $w.ttftMs) { [string][math]::Round([double]$w.ttftMs / 1000, 1) } else { '-' }) + ' 秒')
}
function Get-StreamCell {
    param($S)
    if (-not $S) { return '-' }
    $st = $null
    if ($S.latency -and $S.latency.streaming -and [int]$S.latency.streaming.status -eq 200) { $st = $S.latency.streaming; $n = [int]$st.chunks }
    elseif ($S.ping -and [int]$S.ping.status -eq 200) { $st = $S.ping; $n = [int]$st.pieces }
    if (-not $st) { return '-' }
    $spread = [double]$st.spreadMs
    if ($n -ge 5 -and $spread -ge 200) { return '逐字' }
    if ($n -ge 5 -and $spread -lt 50) { return '整段' }
    return '看不出'
}
function Get-VisionCell {
    param($S)
    if (-not $S -or -not $S.vision) { return '-' }
    if ($S.vision.supported -eq $false) { return '不收图片' }
    return ([string]$S.vision.score + '/' + [string]$S.vision.max)
}
function Get-BatchCell {
    param($S)
    if (-not $S -or $null -eq $S.batchDone) { return '-' }
    return ([string]$S.batchDone + '/10' + $(if ($S.batchPass) { '' } else { '，没过' }))
}

$sorted = @($rows | Sort-Object @{ Expression = { $x = Get-Rate $_.best; if ($null -eq $x) { -1 } else { $x } }; Descending = $true }, @{ Expression = { if ($_.best -and $_.best.coop -and $null -ne $_.best.coop.avgSeconds) { [double]$_.best.coop.avgSeconds } else { 1e9 } }; Descending = $false })
$L = @()
$L += ('# 模型对比报告 ' + $ts)
$L += ''
$L += '每个模型直连测，不经过路由。协作题是原来那 12 道，加一道"一条消息十个编号"的批量题；模型当时不可用的题不计入通过率。'
$L += ''
$L += '| 模型 | 协作题通过 | 平均步数 | 平均用时 | 批量题 | 看图 | 首字 冷/热 | 回复方式 | 最近一次 |'
$L += '|---|---|---|---|---|---|---|---|---|'
foreach ($r in $sorted) {
    $s = $r.best
    $avgSteps = $(if ($s -and $s.coop -and $null -ne $s.coop.avgSteps) { [string]$s.coop.avgSteps } else { '-' })
    $avgSecs = $(if ($s -and $s.coop -and $null -ne $s.coop.avgSeconds) { [string]$s.coop.avgSeconds + ' 秒' } else { '-' })
    $L += ('| ' + $r.name + ' | ' + (Get-CoopCell $s) + ' | ' + $avgSteps + ' | ' + $avgSecs + ' | ' + (Get-BatchCell $s) + ' | ' + (Get-VisionCell $s) + ' | ' + (Get-LatCell $s) + ' | ' + (Get-StreamCell $s) + ' | ' + (Get-StatusText $r.latest) + ' |')
}

$L += ''
$L += '## 结论'
$L += ''
$scored = @($sorted | Where-Object { $null -ne (Get-Rate $_.best) })
if ($scored.Count -and (Get-Rate $scored[0].best) -lt 0.5) {
    $L += ('- 没有哪个模型的协作题能过半（最好的是 ' + $scored[0].name + '，' + (Get-CoopCell $scored[0].best) + '），先看下面没过的题再定，不硬给推荐。')
} elseif ($scored.Count) {
    $top = $scored[0]
    $L += ('- **主力候选：' + $top.name + '**。协作题 ' + (Get-CoopCell $top.best) + '，平均 ' + [string]$top.best.coop.avgSeconds + ' 秒一题。')
    if ($scored.Count -ge 2) { $L += ('- **审查候选：' + $scored[1].name + '**。和主力不是同一个模型，看问题的角度不同，适合拿来审主力写的东西。') }
    $good = @($scored | Where-Object { (Get-Rate $_.best) -ge 0.9 } | ForEach-Object { $_.name })
    $weak = @($scored | Where-Object { (Get-Rate $_.best) -lt 0.9 } | ForEach-Object { $_.name + '（' + (Get-CoopCell $_.best) + '）' })
    if ($good.Count) { $L += ('- 放进失败切换也兜得住的：' + ($good -join '、') + '。') }
    if ($weak.Count) { $L += ('- 切过去会明显掉质量的：' + ($weak -join '、') + '。路由的失败切换顺序里别排它们，或者排在最后。') }
} else { $L += '- 还没有哪个模型跑完协作题，定不了主力。' }
$visOk = @($rows | Where-Object { $_.best -and $_.best.vision -and $_.best.vision.supported -ne $false -and [double]$_.best.vision.max -gt 0 -and ([double]$_.best.vision.score / [double]$_.best.vision.max) -ge 0.7 } | ForEach-Object { $_.name })
$noImg = @($rows | Where-Object { $_.best -and $_.best.vision -and $_.best.vision.supported -eq $false } | ForEach-Object { $_.name })
if ($visOk.Count) { $L += ('- 看图靠得住、能用来做设计图还原的：' + ($visOk -join '、') + '。') }
elseif (@($rows | Where-Object { $_.best -and $_.best.vision }).Count) { $L += '- 没有哪个模型看图能到七成。设计图还原要靠截图逐像素比对这类机械手段，不能指望模型看图。' }
if ($noImg.Count) { $L += ('- 不收图片的：' + ($noImg -join '、') + '。') }
$pending = @($rows | Where-Object { [string]$_.latest.status -ne 'done' } | ForEach-Object { $_.name + '（' + (Get-StatusText $_.latest) + $(if ($_.latest.reason) { '：' + [string]$_.latest.reason } else { '' }) + '）' })
$never = @($list | Where-Object { $n = $_.name; -not ($rows | Where-Object { $_.name -eq $n }) } | ForEach-Object { $_.name })
if ($pending.Count) { $L += ('- 没测完或当时不可用的：' + ($pending -join '；') + '。再双击「模型对比」，直接回车就只补测这些。') }
if ($never.Count) { $L += ('- 还没测过的：' + ($never -join '、') + '。') }

$L += ''
$L += '## 各模型没过的题'
$L += ''
foreach ($r in $sorted) {
    $s = $r.best
    if (-not $s) { continue }
    $bad = @()
    if ($s.coop) { $bad = @(@($s.coop.cases) | Where-Object { -not $_.pass -and -not $_.unavailable } | ForEach-Object { $_.id + '（没过：' + ((@($_.failed)) -join '/') + '）' }) }
    $line = '- ' + $r.name + '：' + $(if (-not $s.coop) { '没跑协作题' } elseif ([int]$s.coop.ran -eq 0) { '协作题一题都没跑成（模型当时不可用）' } elseif ($bad.Count) { $bad -join '，' } else { '全过' })
    if ($s.vision -and $s.vision.groups) {
        $vd = @($s.vision.groups.PSObject.Properties | Where-Object { [int]$_.Value.score -lt [int]$_.Value.max } | ForEach-Object { $_.Value.label + '：' + $_.Value.detail })
        if ($vd.Count) { $line += '；看图丢分：' + ($vd -join '；') }
    }
    $L += $line
    foreach ($n in @($s.notes)) { if ($n) { $L += ('  - ' + $n) } }
}

$L += ''
$L += '## 怎么看'
$L += ''
$L += '- 协作题：模型在样本工程的副本上真干活，判定全部由脚本机械完成。步数是工具调用次数，越少说明弯路越少。'
$L += '- 批量题：一条消息里十个编号的小改动，看它会不会漏做、做一半就收工，或者没做到却说做完了。'
$L += '- 看图：满分 12。基础 4 分（色块、颜色、数字、汉字），读界面 4 分（行数、金额、订单号、按钮文字），找设计稿差异 4 分。'
$L += '- 首字：3.2 万字符的上下文，第一次和同样前缀第二次各要多久出第一个字。第二次快很多，说明提示缓存在起作用。'
$L += '- 回复方式："整段"是网关把回复攒齐了一次性给，写长内容时会先干等；"逐字"是边写边出。'
$L += ('- 每个模型的原始结果在 ' + (Join-Path $root 'results\models') + ' 下，按模型名和时间分目录。')

$rp = Join-Path $runDir '模型对比报告.md'
Write-TextFile -Path $rp -Text ($L -join "`n")
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('模型对比报告-' + $ts + '.md'); Copy-Item $rp $desk -Force } catch { $desk = '' }
Write-Host ''
foreach ($l in @($L | Select-Object -Skip 4 -First ($sorted.Count + 2))) { Write-Host ('  ' + $l) }
Write-Host ''
Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
