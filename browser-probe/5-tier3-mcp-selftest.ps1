# 5-tier3-mcp-selftest.ps1 —— 第三档基础设施自检：不用模型，脚本自己当 MCP 客户端把 Playwright MCP 服务器跑一遍
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$out = New-ResultDir 'tier3-selftest'
Write-Step '第三档基础设施自检：Playwright MCP 服务器'

$node = Resolve-NodeExe
if (-not $node) { Write-Bad '没有 Node，无法运行'; Write-TextFile -Path (Join-Path $out 'report.json') -Text '{"tier":3,"ok":false,"error":"没有 Node"}'; return }
if (-not (Test-Path (Join-Path $root '.mcp.json'))) { Write-Bad '.mcp.json 不存在，先运行 1-check-env.ps1'; Write-TextFile -Path (Join-Path $out 'report.json') -Text '{"tier":3,"ok":false,"error":".mcp.json 不存在"}'; return }
$siteOut = Invoke-SiteScript '-Ensure'
Write-Info $siteOut
if ($siteOut -notmatch 'SITE_READY') { Write-Bad '演示站没起来，跳过'; Write-TextFile -Path (Join-Path $out 'report.json') -Text '{"tier":3,"ok":false,"error":"演示站未启动"}'; return }

& $node (Join-Path $root 'tools\mcp-selftest.js') --out $out --base (Get-SiteBase)
if ($LASTEXITCODE -ne 0) { Write-Warn2 ('MCP 自检失败，详见 ' + (Join-Path $out 'report.md') + '。这种情况下 /probe-t3 必然失败，先修环境') } else { Write-Ok ('MCP 服务器、系统 Edge、快照、交互全部正常，详见 ' + (Join-Path $out 'report.md')) }
