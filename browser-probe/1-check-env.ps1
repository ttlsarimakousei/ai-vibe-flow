# 1-check-env.ps1 —— 内网环境检查，并按本机绝对路径生成 .mcp.json 与 .claude\settings.json
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot
$info = [ordered]@{}

Write-Step '环境检查'
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $info.os = ($os.Caption + ' ' + $os.Version)
} catch { $info.os = [Environment]::OSVersion.VersionString }
$info.powershell = $PSVersionTable.PSVersion.ToString()
Write-Ok ('系统：' + $info.os + '；PowerShell ' + $info.powershell)

$node = Resolve-NodeExe
if ($node) {
    $info.node = (& $node -v)
    $info.nodePath = $node
    Write-Ok ('Node ' + $info.node + '  (' + $node + ')')
} else {
    $info.node = $null
    Write-Bad 'Node 不可用：PATH 里没有 node.exe，offline\node\ 里也没有。第二档、第二点五档、第三档和演示站都需要 Node；第一档本身不需要'
}

$browser = Resolve-BrowserExe
if ($browser) {
    $info.browser = $browser
    $info.browserVersion = (Get-Item $browser).VersionInfo.ProductVersion
    Write-Ok ('浏览器：' + $browser + '  (' + $info.browserVersion + ')')
} else {
    $info.browser = $null
    Write-Bad '找不到 Edge 或 Chrome。可设置环境变量 PROBE_BROWSER_PATH 指向 msedge.exe 后重跑'
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
    $cv = ''
    try { $cv = ((& claude --version 2>$null) | Select-Object -First 1) } catch { $cv = '?' }
    $info.claude = [string]$cv
    Write-Ok ('Claude Code：' + $cv)
} else {
    $info.claude = $null
    Write-Warn2 '未找到 claude 命令；模型测试（/probe-img /probe-t25 /probe-t3）需要它，脚本测试不需要'
}

$mods = @('playwright', '@playwright/mcp', 'pngjs', 'pixelmatch')
$missing = @()
foreach ($m in $mods) { if (-not (Test-Path (Join-Path $root ('node_modules\' + $m + '\package.json')))) { $missing += $m } }
if ($missing.Count -eq 0) {
    $pv = (Get-Content (Join-Path $root 'node_modules\playwright\package.json') -Raw | ConvertFrom-Json).version
    $mv = (Get-Content (Join-Path $root 'node_modules\@playwright\mcp\package.json') -Raw | ConvertFrom-Json).version
    $info.playwright = $pv
    $info.playwrightMcp = $mv
    Write-Ok ('node_modules 完整（playwright ' + $pv + '，@playwright/mcp ' + $mv + '）')
} else {
    Write-Bad ('node_modules 缺少：' + ($missing -join '，') + '。请在外网机器运行 0-prepare-online.ps1 后把整个目录拷过来')
}

$port = Get-SitePort
$info.port = $port
if (Test-HttpOk ('http://127.0.0.1:' + $port + '/api/health')) {
    Write-Warn2 ('端口 ' + $port + ' 上已有演示站在运行')
} else {
    $busy = $false
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $busy = $true; $c.Close() } catch { }
    if ($busy) { Write-Warn2 ('端口 ' + $port + ' 被其他程序占用，可设置环境变量 PROBE_PORT 换端口') } else { Write-Ok ('端口 ' + $port + ' 空闲') }
}

# ---- 生成 .mcp.json（第三档：Playwright MCP）----
Write-Step '生成 Claude Code 配置（绝对路径）'
$cli = Join-Path $root 'node_modules\@playwright\mcp\cli.js'
$mcpArgs = @($cli)
if ($browser -and $browser -match 'msedge') { $mcpArgs += @('--browser', 'msedge') }
elseif ($browser -and $browser -match 'chrome') { $mcpArgs += @('--browser', 'chrome') }
elseif ($browser) { $mcpArgs += @('--browser', 'chromium', '--executable-path', $browser) }
else { $mcpArgs += @('--browser', 'msedge') }
$mcpArgs += @('--headless', '--isolated', '--output-dir', (Join-Path $root 'results\model\mcp'))
$mcpCmd = $(if ($node) { $node } else { 'node' })
$mcp = [ordered]@{ mcpServers = [ordered]@{ playwright = [ordered]@{ command = $mcpCmd; args = $mcpArgs } } }
Write-TextFile -Path (Join-Path $root '.mcp.json') -Text ($mcp | ConvertTo-Json -Depth 6)
Write-Ok '.mcp.json 已生成（想看着模型操作浏览器，把里面的 "--headless" 删掉即可）'

# ---- 生成 .claude\settings.json（权限放行 + 计数 hook）----
$hookPs1 = Join-Path $root 'tools\hook-toolcount.ps1'
$hookCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $hookPs1 + '"'
$settings = [ordered]@{
    enableAllProjectMcpServers = $true
    permissions = [ordered]@{
        allow = @('mcp__playwright', 'Bash(node:*)', 'Bash(powershell:*)', 'Read', 'Write', 'Edit')
    }
    hooks = [ordered]@{
        UserPromptSubmit = @(
            [ordered]@{ hooks = @([ordered]@{ type = 'command'; command = ($hookCmd + ' -Mark') }) }
        )
        PostToolUse = @(
            [ordered]@{ matcher = 'mcp__playwright__.*'; hooks = @([ordered]@{ type = 'command'; command = $hookCmd }) }
        )
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $root '.claude') | Out-Null
Write-TextFile -Path (Join-Path $root '.claude\settings.json') -Text ($settings | ConvertTo-Json -Depth 8)
Write-Ok '.claude\settings.json 已生成（放行 MCP/node/powershell + MCP 调用计数 hook）'

$dir = New-ResultDir
Write-TextFile -Path (Join-Path $dir 'env.json') -Text ($info | ConvertTo-Json -Depth 4)
Write-Info ('环境信息已写入 ' + (Join-Path $dir 'env.json'))
