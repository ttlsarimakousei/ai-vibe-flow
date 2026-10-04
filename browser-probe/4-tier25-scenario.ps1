# 4-tier25-scenario.ps1 —— 第二点五档：场景执行器跑 scenarios\sample-*.json 全部示例场景（覆盖 A~E 五套页面）
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$out = New-ResultDir 'tier25'
Write-Step '第二点五档：场景执行器（示例场景，A~E 五套页面）'

$node = Resolve-NodeExe
if (-not $node) { Write-Bad '没有 Node，第二点五档无法运行'; Write-TextFile -Path (Join-Path $out 'report.json') -Text '{"tier":2.5,"ok":false,"error":"没有 Node"}'; return }
$siteOut = Invoke-SiteScript '-Ensure'
Write-Info $siteOut
if ($siteOut -notmatch 'SITE_READY') { Write-Bad '演示站没起来，跳过'; Write-TextFile -Path (Join-Path $out 'report.json') -Text '{"tier":2.5,"ok":false,"error":"演示站未启动"}'; return }

$summary = [ordered]@{ tier = 2.5; name = '场景执行器'; ok = $true; scenarios = @() }
$files = Get-ChildItem (Join-Path $root 'scenarios') -Filter 'sample-*.json' | Sort-Object Name
foreach ($f in $files) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    Write-Host ('  场景：' + $f.Name)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $node (Join-Path $root 'tools\scenario-run.js') $f.FullName --out (Join-Path $out $name) --base (Get-SiteBase)
    $code = $LASTEXITCODE
    $sw.Stop()
    $ok = ($code -eq 0)
    if (-not $ok) { $summary.ok = $false }
    $values = $null
    $failed = ''
    try {
        $rj = Get-Content (Join-Path $out ($name + '\result.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
        $values = $rj.values
        if ($rj.fatal) { $failed = [string]$rj.fatal }
        $fs = @($rj.steps | Where-Object { -not $_.ok -and -not $_.skipped })
        if ($fs.Count) { $failed = '第 ' + $fs[0].i + ' 步 ' + $fs[0].step + '：' + $fs[0].error }
    } catch { }
    $summary.scenarios += [ordered]@{ file = $f.Name; ok = $ok; ms = [int]$sw.ElapsedMilliseconds; result = (Join-Path $out ($name + '\result.md')); values = $values; failed = $failed }
}
Write-TextFile -Path (Join-Path $out 'report.json') -Text ($summary | ConvertTo-Json -Depth 6)
if ($summary.ok) { Write-Ok ('全部 ' + $files.Count + ' 个示例场景通过') } else { Write-Warn2 '有示例场景失败，看各自的 result.md' }
