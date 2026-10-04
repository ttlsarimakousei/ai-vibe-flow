# run-all.ps1 —— 一键跑完不需要模型的三档（第一档 / 第二档 / 第二点五档），生成 summary.md，并给出模型测试的下一步
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$env:PROBE_RESULT_DIR = Join-Path $root ('results\' + $ts)
$resultDir = New-ResultDir
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host ''
Write-Host '浏览器验证体检包 · 一键运行' -ForegroundColor Cyan
Write-Host ('结果目录：' + $resultDir)

& (Join-Path $root '1-check-env.ps1')
& (Join-Path $root '2-tier1-edge.ps1')
& (Join-Path $root '3-tier2-playwright.ps1')
& (Join-Path $root '4-tier25-scenario.ps1')
& (Join-Path $root '5-tier3-mcp-selftest.ps1')

Write-Step '停止演示站'
Write-Info (Invoke-SiteScript '-Stop')

# ---- 汇总 ----
function Read-Json { param([string]$P) if (Test-Path $P) { try { return (Get-Content $P -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null } } return $null }
$env1 = Read-Json (Join-Path $resultDir 'env.json')
$t1 = Read-Json (Join-Path $resultDir 'tier1\report.json')
$t2 = Read-Json (Join-Path $resultDir 'tier2\report.json')
$t25 = Read-Json (Join-Path $resultDir 'tier25\report.json')
$t3 = Read-Json (Join-Path $resultDir 'tier3-selftest\report.json')

function Fmt-Ok { param($o) if ($null -eq $o) { return '未运行' } if ($o.ok) { return '通过' } return '失败' }
function Fmt-Note { param($o, [string]$ok, [string]$bad) if ($null -eq $o) { return '' } if ($o.error) { return [string]$o.error } if ($o.ok) { return $ok } return $bad }

$L = @()
$L += ('# 浏览器验证体检结果 ' + $ts)
$L += ''
$L += '## 环境'
$L += ''
if ($env1) {
    $L += ('- 系统：' + $env1.os + '，PowerShell ' + $env1.powershell)
    $L += ('- Node：' + $(if ($env1.node) { $env1.node + '（' + $env1.nodePath + '）' } else { '无' }))
    $L += ('- 浏览器：' + $(if ($env1.browser) { $env1.browser + '（' + $env1.browserVersion + '）' } else { '无' }))
    $L += ('- Claude Code：' + $(if ($env1.claude) { $env1.claude } else { '未找到' }))
    $L += ('- Playwright：' + $env1.playwright + '，MCP：' + $env1.playwrightMcp)
}
$L += ''
$L += '## 脚本测试（不需要模型）'
$L += ''
$L += '| 档 | 方案 | 结果 | 耗时 | 说明 |'
$L += '|---|---|---|---|---|'
$t1ms = 0; if ($t1 -and $t1.steps) { foreach ($s in $t1.steps) { $t1ms += [int]$s.ms } }
$L += ('| 1 | 系统浏览器无头命令行 | ' + (Fmt-Ok $t1) + ' | ' + $t1ms + ' ms | ' + $(if ($t1 -and $t1.capabilities) { '截图 ' + $t1.capabilities.'整页截图' + '；DOM ' + $t1.capabilities.'DOM 文本' + '；异步等待 ' + $t1.capabilities.'等待异步数据后再截' + '；console ' + $t1.capabilities.'console 错误' } else { Fmt-Note $t1 '' '' }) + ' |')
$t2note = ''
if ($t2 -and $t2.steps) {
    $fails = @($t2.steps | Where-Object { -not $_.ok })
    $t2note = '启动方式：' + $t2.via + '；' + $(if ($fails.Count) { '失败步骤：' + (($fails | ForEach-Object { $_.name }) -join '，') } else { '登录/点击/截图/像素比对/布局树/console 全部可用' })
    if ($t2.eyes -and $t2.eyes.pixel) { $t2note += '；像素差异 ' + ([math]::Round($t2.eyes.pixel.ratio * 100, 2)) + '%' }
    if ($t2.eyes -and $t2.eyes.layout) { $t2note += '；布局差异 ' + $t2.eyes.layout.summary.rectDiffs + ' 处坐标 + ' + $t2.eyes.layout.summary.styleDiffs + ' 处样式' }
} else { $t2note = Fmt-Note $t2 '' '' }
$L += ('| 2 | Playwright 脚本（固定流程） | ' + (Fmt-Ok $t2) + ' | ' + $(if ($t2) { [string]$t2.totalMs } else { '' }) + ' ms | ' + $t2note + ' |')
$t25note = ''
if ($t25 -and $t25.scenarios) { $t25note = ($t25.scenarios | ForEach-Object { $_.file + '：' + $(if ($_.ok) { '通过' } else { '失败' }) }) -join '；' } else { $t25note = Fmt-Note $t25 '' '' }
$t25ms = 0; if ($t25 -and $t25.scenarios) { foreach ($s in $t25.scenarios) { $t25ms += [int]$s.ms } }
$L += ('| 2.5 | 场景执行器（模型写场景，脚本执行） | ' + (Fmt-Ok $t25) + ' | ' + $t25ms + ' ms | ' + $t25note + ' |')
$t3note = ''
if ($t3 -and $t3.steps) {
    $fails = @($t3.steps | Where-Object { -not $_.ok })
    $t3note = $(if ($fails.Count) { '失败步骤：' + (($fails | ForEach-Object { $_.name + '（' + $_.error + '）' }) -join '，') } else { 'MCP 服务器可启动，快照含 ref，填表/点击/等待都正常；工具调用 ' + $t3.toolCalls + ' 次' })
} else { $t3note = Fmt-Note $t3 '' '' }
$L += ('| 3 基础 | Playwright MCP 服务器自检（不用模型） | ' + (Fmt-Ok $t3) + ' | ' + $(if ($t3) { [string]$t3.totalMs } else { '' }) + ' ms | ' + $t3note + ' |')
$L += ''
$L += '## 模型测试（要在 Claude Code 里手动跑）'
$L += ''
$L += '在本目录打开 Claude Code（`claude`），依次输入：'
$L += ''
$L += '1. `/probe-img` —— 模型能不能看图（决定截图能否直接进上下文）'
$L += '2. `/probe-t25` —— 模型能不能照格式写场景文件并跑通（第二点五档）'
$L += '3. `/probe-t3` —— 模型能不能直接驱动 Playwright MCP 完成登录、数行、导出（第三档），建议跑 3 次'
$L += ''
$L += '跑完后执行 `powershell -ExecutionPolicy Bypass -File tools\score-model.ps1` 汇总。'
$L += ''
$L += '## 怎么判定'
$L += ''
$L += '| 现象 | 结论 |'
$L += '|---|---|'
$L += '| 第一档通过，第二档失败 | 没有可用的 Node 或 Edge 版本太老；先只能做静态截图 |'
$L += '| 第二档通过 | 登录、点击、像素比对、布局树、console 捕获全部可用，脚本化验证的底座成立 |'
$L += '| 第三档基础自检失败 | MCP 环境本身有问题（Node、Edge、.mcp.json 路径），/probe-t3 不用跑，先修环境 |'
$L += '| /probe-img 模型答对 | 截图可以直接给模型看，视觉判断可以交给模型 |'
$L += '| /probe-img 报错或答错 | 模型不能看图，走零图模式：diff 数字 + 布局树 + console 文本 |'
$L += '| /probe-t25 三次内跑通 | 模型能写场景文件，第二点五档成立 |'
$L += '| /probe-t3 12 次调用内完成 | 第三档可以留作探索性验证 |'
$L += '| /probe-t3 超过 25 次或没完成 | 第三档不适合这个模型，用第二点五档 |'
Write-TextFile -Path (Join-Path $resultDir 'summary.md') -Text ($L -join "`n")

$sw.Stop()
Write-Step ('完成，用时 ' + [int]$sw.Elapsed.TotalSeconds + ' 秒')
Write-Host ('  汇总：' + (Join-Path $resultDir 'summary.md')) -ForegroundColor Cyan
Write-Host ''
Write-Host '  下一步（模型测试）：在本目录运行 claude，然后依次输入 /probe-img、/probe-t25、/probe-t3' -ForegroundColor Cyan
Write-Host '  最后运行 tools\score-model.ps1 汇总模型测试结果' -ForegroundColor Cyan
