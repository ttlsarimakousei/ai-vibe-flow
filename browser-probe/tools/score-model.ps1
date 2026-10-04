# 汇总模型测试（img / t25 / t3）的结果：MCP 工具调用次数 + 模型自己写的结果文件
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-ProbeRoot
$dir = Join-Path $root 'results\model'
$log = Join-Path $dir 'toolcalls.log'

Write-Step '模型测试汇总'
if (-not (Test-Path $dir)) { Write-Warn2 '还没有任何模型测试结果（results\model 不存在）。先在 Claude Code 里运行 /probe-img、/probe-t25、/probe-t3'; return }

# 1. MCP 调用统计（第三档）
if (Test-Path $log) {
    $runs = @()
    $cur = $null
    foreach ($line in (Get-Content $log -Encoding UTF8)) {
        $parts = $line.TrimStart([char]0xFEFF) -split "`t"
        if ($parts.Count -lt 2) { continue }
        if ($parts[1] -eq 'PROMPT') {
            $cur = [ordered]@{ time = $parts[0]; prompt = $(if ($parts.Count -ge 3) { $parts[2] } else { '' }); calls = 0; tools = @{} }
            $runs += $cur
        } elseif ($cur -ne $null -and $parts[1]) {
            $cur.calls++
            $t = $parts[1] -replace '^mcp__playwright__', ''
            if ($cur.tools.ContainsKey($t)) { $cur.tools[$t]++ } else { $cur.tools[$t] = 1 }
        }
    }
    $withCalls = @($runs | Where-Object { $_.calls -gt 0 })
    if ($withCalls.Count -eq 0) {
        Write-Warn2 'toolcalls.log 里没有 MCP 调用记录：要么还没跑 /probe-t3，要么 hook 没生效（检查 .claude\settings.json 是否由 1-check-env.ps1 生成）'
    } else {
        Write-Host ''
        Write-Host '  第三档（模型直接驱动 Playwright MCP）每轮工具调用次数：'
        Write-Host '  | 时间 | 提示词 | MCP 调用次数 | 明细 |'
        Write-Host '  |---|---|---|---|'
        foreach ($r in $withCalls) {
            $detail = ($r.tools.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $_.Key + ' x' + $_.Value }) -join '，'
            Write-Host ('  | ' + $r.time + ' | ' + $r.prompt + ' | ' + $r.calls + ' | ' + $detail + ' |')
        }
        Write-Host ''
        Write-Info '判定参考：12 次以内完成登录+数行+导出 = 顺畅；12~25 次 = 能用但啰嗦；25 次以上或没完成 = 第三档不适合这个模型'
    }
} else {
    Write-Warn2 '没有 toolcalls.log（hook 未触发或还没跑 /probe-t3）'
}

# 2. 模型写的结果文件
Write-Host ''
Write-Host '  模型写的结果文件：'
$files = Get-ChildItem $dir -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name
if (-not $files) { Write-Info '（无）' }
foreach ($f in $files) {
    Write-Host ''
    Write-Host ('  --- ' + $f.Name + ' ---') -ForegroundColor Cyan
    Get-Content $f.FullName -Encoding UTF8 | ForEach-Object { Write-Host ('  ' + $_) }
}

# 3. 图片测试的标准答案
$ans = Join-Path $root 'assets\probe-image.answer.txt'
if (Test-Path $ans) { Write-Host ''; Write-Host ('  图片测试标准答案：' + (Get-Content $ans -Encoding UTF8 -Raw).Trim()) }
