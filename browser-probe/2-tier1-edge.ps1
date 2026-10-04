# 2-tier1-edge.ps1 —— 第一档：系统浏览器无头命令行（零依赖，只要有 Edge 或 Chrome）
# 能做：整页截图、导出 DOM 文本、（借 --enable-logging）抓 console。不能做：登录、点击、填表、取元素坐标与计算样式。
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$base = Get-SiteBase
$out = New-ResultDir 'tier1'
Write-Step '第一档：Edge/Chrome 无头命令行'

$report = [ordered]@{ tier = 1; name = '系统浏览器无头命令行'; browser = $null; headlessFlag = $null; ok = $false; steps = @(); capabilities = [ordered]@{}; out = $out }

function Save-Report {
    Write-TextFile -Path (Join-Path $out 'report.json') -Text ($report | ConvertTo-Json -Depth 6)
    $L = @('# 第一档：系统浏览器无头命令行', '', ('- 浏览器：' + $report.browser + '（' + $report.browserVersion + '）'), ('- 无头参数：' + $report.headlessFlag), ('- 结论：' + $(if ($report.ok) { '可用' } else { '不可用' })), '', '| 步骤 | 结果 | 耗时 | 说明 |', '|---|---|---|---|')
    foreach ($s in $report.steps) { $L += ('| ' + $s.name + ' | ' + $(if ($s.ok) { '通过' } else { '失败' }) + ' | ' + $s.ms + ' ms | ' + $s.note + ' |') }
    $L += @('', '## 能力', '', '| 能力 | 结果 |', '|---|---|')
    foreach ($k in $report.capabilities.Keys) { $L += ('| ' + $k + ' | ' + $report.capabilities[$k] + ' |') }
    Write-TextFile -Path (Join-Path $out 'report.md') -Text ($L -join "`n")
    Write-Info ('报告：' + (Join-Path $out 'report.md'))
}

$browser = Resolve-BrowserExe
if (-not $browser) {
    Write-Bad '找不到 Edge 或 Chrome，第一档无法运行'
    $report.error = '找不到浏览器'
    Save-Report
    return
}
$report.browser = $browser
$report.browserVersion = (Get-Item $browser).VersionInfo.ProductVersion
Write-Ok ('浏览器：' + $browser + '（' + $report.browserVersion + '）')

if (-not $env:PROBE_BASE) {
    $siteOut = Invoke-SiteScript '-Ensure'
    Write-Info $siteOut
    if ($siteOut -notmatch 'SITE_READY') { Write-Warn2 '演示站没起来（缺 Node？）。可设置 PROBE_BASE=http://内网某个不用登录的页面 后重跑第一档' }
}

$profileDir = Join-Path $env:TEMP ('probe-edge-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

function Invoke-Headless {
    param([string]$Url, [string[]]$Extra, [string]$StdOut, [string]$StdErr, [string]$HeadlessFlag = '--headless')
    $list = @(
        $HeadlessFlag, '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', ('--user-data-dir="' + $profileDir + '"'),
        '--force-device-scale-factor=1', '--window-size=1440,900', '--virtual-time-budget=3000'
    ) + $Extra + @('"' + $Url + '"')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $sp = @{ FilePath = $browser; ArgumentList = $list; Wait = $true; PassThru = $true; WindowStyle = 'Hidden' }
    if ($StdOut) { $sp.RedirectStandardOutput = $StdOut }
    if ($StdErr) { $sp.RedirectStandardError = $StdErr }
    $p = Start-Process @sp
    $sw.Stop()
    return [int]$sw.ElapsedMilliseconds
}

function Add-Step { param([string]$Name, [bool]$Ok, [int]$Ms, [string]$Note)
    $report.steps += [ordered]@{ name = $Name; ok = $Ok; ms = $Ms; note = $Note }
    if ($Ok) { Write-Ok ($Name + '（' + $Ms + ' ms）' + $Note) } else { Write-Bad ($Name + '（' + $Ms + ' ms）' + $Note) }
}
function Test-Png { param([string]$P) return ((Test-Path $P) -and ((Get-Item $P).Length -gt 1000)) }

# 1. 登录页截图（先试经典 --headless，不行再试 --headless=new）
$png1 = Join-Path $out 'login.png'
$ms = Invoke-Headless -Url ($base + '/login.html') -Extra @('--screenshot="' + $png1 + '"')
$ok1 = Test-Png $png1
if ($ok1) { $report.headlessFlag = '--headless' } else {
    $ms = Invoke-Headless -Url ($base + '/login.html') -Extra @('--screenshot="' + $png1 + '"') -HeadlessFlag '--headless=new'
    $ok1 = Test-Png $png1
    if ($ok1) { $report.headlessFlag = '--headless=new' }
}
Add-Step '登录页截图' $ok1 $ms $(if ($ok1) { 'login.png ' + (Get-Item $png1).Length + ' 字节' } else { '两种无头参数都没生成截图文件' })
$flag = $(if ($report.headlessFlag) { $report.headlessFlag } else { '--headless' })

# 2. 用户管理页截图（免登录预览路由）
$png2 = Join-Path $out 'users-preview.png'
$ms = Invoke-Headless -Url ($base + '/dashboard.html?preview=1#users') -Extra @('--screenshot="' + $png2 + '"') -HeadlessFlag $flag
$ok2 = Test-Png $png2
Add-Step '用户管理页截图（免登录预览）' $ok2 $ms $(if ($ok2) { 'users-preview.png ' + (Get-Item $png2).Length + ' 字节' } else { '未生成截图文件' })

# 3. 导出 DOM 并解析表格行数（异步数据靠 --virtual-time-budget 等待）
$dom = Join-Path $out 'users-dom.html'
$ms = Invoke-Headless -Url ($base + '/dashboard.html?preview=1#users') -Extra @('--dump-dom') -StdOut $dom -StdErr (Join-Path $out 'users-stderr.log') -HeadlessFlag $flag
$html = ''
if (Test-Path $dom) { $html = Get-Content $dom -Raw -Encoding UTF8 }
$rows = 0
if ($html -match '(?s)<tbody>(.*?)</tbody>') { $rows = ([regex]::Matches($Matches[1], '<tr')).Count }
$ok3 = ($html.Length -gt 500)
Add-Step 'DOM 导出并解析表格行数' $ok3 $ms ('DOM ' + $html.Length + ' 字符，tbody 行数 = ' + $rows + '（期望 5；0 说明异步数据没等到）')

# 4. console 捕获：设置页会故意报错，用 --enable-logging=stderr 抓
$dom2 = Join-Path $out 'settings-dom.html'
$err2 = Join-Path $out 'settings-stderr.log'
$ms = Invoke-Headless -Url ($base + '/dashboard.html?preview=1#settings') -Extra @('--dump-dom', '--enable-logging=stderr', '--v=0') -StdOut $dom2 -StdErr $err2 -HeadlessFlag $flag
$consoleLines = @()
if (Test-Path $err2) { $consoleLines = @(Get-Content $err2 -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match 'CONSOLE' }) }
$ok4 = ($consoleLines.Count -gt 0)
Add-Step 'console 错误捕获（--enable-logging）' $ok4 $ms ('抓到 ' + $consoleLines.Count + ' 条 CONSOLE 日志' + $(if ($ok4) { '：' + (($consoleLines | Select-Object -First 2) -join ' / ') } else { '' }))
if ($ok4) { Write-TextFile -Path (Join-Path $out 'console.txt') -Text ($consoleLines -join "`n") }

Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

$report.ok = ($ok1 -and $ok2)
$report.capabilities = [ordered]@{
    '整页截图' = $(if ($ok1 -and $ok2) { '可以' } else { '不可以' })
    'DOM 文本' = $(if ($ok3) { '可以' } else { '不可以' })
    '等待异步数据后再截' = $(if ($rows -eq 5) { '可以（virtual-time-budget 生效）' } else { '不稳定（行数 ' + $rows + '）' })
    'console 错误' = $(if ($ok4) { '可以（stderr 日志）' } else { '不可以' })
    '登录 / 点击 / 填表' = '不可以（需要免登录预览路由）'
    '元素坐标与计算样式' = '不可以'
    '像素比对' = '本档不带；第二档的 pixel-diff.js 可以对本档截图做比对'
}
Save-Report
