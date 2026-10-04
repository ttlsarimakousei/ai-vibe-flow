# Claude Code hook：把每次工具调用记一行，用来统计模型在一个用例上花了多少步、用了哪些工具。
# 日志路径由环境变量 PROBE_TOOLLOG 指定（runner 每个用例设一个）；没设就丢到包根 results\toolcalls.log。
# 任何异常都静默放行（exit 0），绝不影响被测模型正常工作。
param([string]$Event = 'PostToolUse')
try {
    $log = $env:PROBE_TOOLLOG
    if (-not $log) { $log = Join-Path (Split-Path -Parent $PSScriptRoot) 'results\toolcalls.log' }
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

    $raw = ''
    try {
        # Claude Code 以 UTF-8 传 JSON；PS 5.1 默认按系统代码页读 stdin，中文会乱码导致解析失败
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
        $raw = $reader.ReadToEnd()
    } catch { }

    $obj = $null
    try { if ($raw) { $obj = $raw | ConvertFrom-Json } } catch { }

    $name = ''
    $extra = ''
    if ($obj) {
        if ($obj.tool_name) { $name = [string]$obj.tool_name }
        if ($obj.hook_event_name) { $Event = [string]$obj.hook_event_name }
        # 记下 Bash 命令的前若干字符，便于事后看它是怎么验证的；其余工具记目标文件
        try {
            if ($obj.tool_input) {
                if ($obj.tool_input.command) { $extra = ([string]$obj.tool_input.command) -replace '\s+', ' ' }
                elseif ($obj.tool_input.file_path) { $extra = [string]$obj.tool_input.file_path }
                elseif ($obj.tool_input.pattern) { $extra = [string]$obj.tool_input.pattern }
            }
        } catch { }
        if ($extra.Length -gt 160) { $extra = $extra.Substring(0, 160) }
    }

    $stamp = Get-Date -Format 'HH:mm:ss'
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($log, ($stamp + "`t" + $Event + "`t" + $name + "`t" + $extra + "`r`n"), $enc)
} catch { }
exit 0
