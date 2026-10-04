# 3-tier2-playwright.ps1 —— 第二档：Playwright 脚本（固定流程，用系统 Edge，不下载浏览器）
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$out = New-ResultDir 'tier2'
Write-Step '第二档：Playwright 脚本（固定流程）'

$node = Resolve-NodeExe
if (-not $node) {
    Write-Bad '没有 Node，第二档无法运行（把便携版 node.exe 放到 offline\node\ 即可）'
    Write-TextFile -Path (Join-Path $out 'report.json') -Text ('{"tier":2,"ok":false,"error":"没有 Node"}')
    return
}
$siteOut = Invoke-SiteScript '-Ensure'
Write-Info $siteOut
if ($siteOut -notmatch 'SITE_READY') { Write-Bad '演示站没起来，第二档跳过'; Write-TextFile -Path (Join-Path $out 'report.json') -Text ('{"tier":2,"ok":false,"error":"演示站未启动"}'); return }

& $node (Join-Path $root 'tools\tier2-run.js') --out $out --base (Get-SiteBase)
if ($LASTEXITCODE -ne 0) { Write-Warn2 ('第二档有失败步骤，详见 ' + (Join-Path $out 'report.md')) } else { Write-Ok ('第二档全部通过，详见 ' + (Join-Path $out 'report.md')) }
