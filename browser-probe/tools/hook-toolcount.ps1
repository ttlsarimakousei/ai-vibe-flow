# Claude Code hook：统计模型调用了多少次 Playwright MCP 工具（第三档体检的客观指标）。
#   UserPromptSubmit 事件 → 本脚本 -Mark：写一条 PROMPT 分隔行
#   PostToolUse 事件（matcher mcp__playwright__.*）→ 本脚本：写一条工具名
# 日志：results\model\toolcalls.log。任何异常都静默放行（exit 0），绝不影响 Claude 正常工作。
param([switch]$Mark)
try {
    $root = Split-Path -Parent $PSScriptRoot
    $log = Join-Path $root 'results\model\toolcalls.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $raw = ''
    try {
        # Claude Code 以 UTF-8 传 JSON；PS 5.1 默认按系统代码页读 stdin，中文会乱码导致 JSON 解析失败，所以显式按 UTF-8 读
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
        $raw = $reader.ReadToEnd()
    } catch { }
    $obj = $null
    try { if ($raw) { $obj = $raw | ConvertFrom-Json } } catch { }
    $enc = New-Object System.Text.UTF8Encoding($false)
    if ($Mark) {
        $prompt = ''
        if ($obj -and $obj.prompt) { $prompt = ([string]$obj.prompt) -replace '\s+', ' ' }
        if ($prompt.Length -gt 60) { $prompt = $prompt.Substring(0, 60) }
        [System.IO.File]::AppendAllText($log, ($stamp + "`tPROMPT`t" + $prompt + "`r`n"), $enc)
    } else {
        $name = ''
        if ($obj -and $obj.tool_name) { $name = [string]$obj.tool_name }
        [System.IO.File]::AppendAllText($log, ($stamp + "`t" + $name + "`r`n"), $enc)
    }
} catch { }
exit 0
