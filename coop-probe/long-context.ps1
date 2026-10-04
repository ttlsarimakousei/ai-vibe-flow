# long-context.ps1 —— 挑一两个模型，看上下文到几十万 token 时还靠不靠得住、要等多久
#   标称 1M 不等于真能用到 1M：模型常常到几十万 token 就开始"记不住前面的约定"。
#   每一档都在开头写一条项目约定、在 10%/50%/90% 处各埋一条事实，问一遍（冷）再换个问法问一遍（热）。
#   很吃额度，所以单独一个入口，只测挑中的模型。
# 参数：-Models "DeepSeek"               直接指定，不询问
#       -Sizes "100000,300000,600000"    各档的 token 数
#       -CacheWait 300                   最后等多少秒再问一次，看缓存能活多久；0 = 不测；不给则询问
param([string]$Models = '', [string]$Sizes = '100000,300000,600000', [int]$CacheWait = -1)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
. (Join-Path $PSScriptRoot 'tools\models.ps1')
$root = Get-ProbeRoot
$node = Resolve-NodeExe
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host '长上下文：几十万 token 时还靠不靠得住、要等多久' -ForegroundColor Cyan
if (-not $node) { Write-Bad '没有 Node，跑不了'; return }
$list = @(Read-Models)
if (-not $list.Count) {
    Write-Bad '还没有可测的模型'
    Write-Info ('照着 models.example.json 的格式，在 ' + (Get-ModelsPath) + ' 里填上每个模型的地址和 key，再双击一次')
    return
}

$sizeList = @($Sizes -split '[,，\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$budget = [int](($sizeList | Measure-Object -Sum).Sum * 2 / 10000)

$sel = @()
if ($Models) {
    $want = @($Models -split '[,，\s]+' | Where-Object { $_ })
    $sel = @($list | Where-Object { $want -contains $_.name })
} else {
    Write-Host ''
    Write-Host '可以测的模型：' -ForegroundColor Cyan
    for ($i = 0; $i -lt $list.Count; $i++) {
        $h = @(Get-ModelRuns $list[$i].safe) | Select-Object -First 1
        $extra = ''
        if ($h -and $h.coop -and [int]$h.coop.ran -gt 0) { $extra = '    协作题 ' + [string]$h.coop.pass + '/' + [string]$h.coop.ran }
        Write-Host ('  ' + [string]($i + 1) + '. ' + $list[$i].name + $extra)
    }
    Write-Info ('每个模型大约消耗 ' + [string]$budget + ' 万 token 的额度，建议只挑一两个（比如模型对比里排前面的）')
    $in = ([string](Read-Host '测哪几个？输入编号，用逗号隔开')).Trim()
    $idx = @($in -split '[,，\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ - 1 } | Where-Object { $_ -ge 0 -and $_ -lt $list.Count } | Select-Object -Unique)
    $sel = @($idx | ForEach-Object { $list[$_] })
}
if (-not $sel.Count) { Write-Warn2 '没有选中任何模型'; return }
if ($CacheWait -lt 0) {
    $a = ([string](Read-Host '要不要顺带测缓存能保持多久？要多等 5 分钟。输入 y 测，直接回车不测')).Trim()
    $CacheWait = $(if ($a -match '^(y|Y|是|要)') { 300 } else { 0 })
}

$runDir = Join-Path $root ('results\longctx-' + $ts)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$results = @()
foreach ($m in $sel) {
    Write-Step ('模型：' + $m.name)
    $mdir = Join-Path $runDir $m.safe
    $pm = Get-ProbeModelName $m
    # 直接用 & 调用，过程能实时看到；key 临时放进本进程的环境变量传给子进程，跑完立刻清掉
    $direct = Get-DirectEnv $m
    $saved = @{}
    foreach ($k in $direct.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, [string]$direct[$k]) }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $node (Join-Path $root 'tools\long-context.js') --out $mdir --model $pm --sizes ($sizeList -join ',') --cache-wait $CacheWait }
    catch { Write-Bad ('出错：' + $_.Exception.Message) }
    finally {
        $ErrorActionPreference = $prevEap
        foreach ($k in $direct.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $results += [pscustomobject]@{ name = $m.name; md = (Join-Path $mdir 'long.md') }
}

$L = @()
$L += ('# 长上下文报告 ' + $ts)
$L += ''
$L += '每一档造一份像真实项目的长材料，开头写一条项目约定（金额字段名以 Amt 结尾），在 10%、50%、90% 的位置各埋一条事实（达梦连接池的等待时间、返利比例、一个错误码的含义）。先问一遍（冷），再用同样的前缀换个问法问一遍（热）。"出结果"是从发出请求到收到第一个字的时间，网关是整段返回时，就是等整个回答的时间。'
$L += ''
foreach ($r in $results) {
    $L += ('## ' + $r.name)
    $L += ''
    if (Test-Path $r.md) { $L += @((Get-Content $r.md -Raw -Encoding UTF8) -split "`n") } else { $L += '没有产出结果。' }
    $L += ''
}
$L += '## 对照 Claude Code'
$L += ''
$L += '- 在内网 claude 里敲 `/context`，看它显示的上限是 200k 还是 1000k。它按这个上限决定什么时候自动压缩会话；是 200k 的话，上面超过 20 万的档在日常里根本用不到。'
$L += '- 上面哪一档开始丢分，就是会话不该超过的长度；这决定工作流里会话开多长、什么时候主动压缩或者换新会话。'
$rp = Join-Path $runDir '长上下文报告.md'
Write-TextFile -Path $rp -Text ($L -join "`n")
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('长上下文报告-' + $ts + '.md'); Copy-Item $rp $desk -Force } catch { $desk = '' }
Write-Host ''
Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
