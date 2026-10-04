# models.ps1 —— 模型清单：读 models.json（没有就从用户自己的模型路由配置导入），列出来让人选，按模型生成直连配置
# key 只在本机用：不打印，不写进报告和结果目录；带 key 的临时配置放在英文临时目录，用完即删。
# 由 model-compare.ps1、long-context.ps1 以 . 号引入（先引入 common.ps1）。

function Get-ModelsPath { return (Join-Path (Get-ProbeRoot) 'models.json') }

# 当目录名用的名字：只留字母、数字、汉字、点、横线、下划线
function Get-SafeName {
    param([string]$Name)
    $s = ($Name -replace '[^\w.-]', '_').Trim('_')
    if (-not $s) { $s = 'model' }
    return $s
}

# 用户的模型路由（model-router）在 ~/.claude/model-router.json 登记了安装目录，它的 config.json 里有各模型的地址和 key
function Import-RouterModels {
    $reg = Join-Path $env:USERPROFILE '.claude\model-router.json'
    if (-not (Test-Path -LiteralPath $reg)) { return }
    try {
        $r = Get-Content -LiteralPath $reg -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfgPath = Join-Path ([string]$r.path) 'config.json'
        if (-not (Test-Path -LiteralPath $cfgPath)) { return }
        $c = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $src = @()
        if ($c.providers) { $src = @($c.providers) } else { $src = @($c.routes) + @($c.default) }
        $seen = @{}
        foreach ($p in $src) {
            if (-not $p -or -not $p.name -or -not $p.api_key -or $seen.ContainsKey([string]$p.name)) { continue }
            $seen[[string]$p.name] = 1
            [ordered]@{ name = [string]$p.name; base_url = [string]$p.base_url; api_key = [string]$p.api_key }
        }
    } catch { }
}

# 读 models.json；第一次运行没有这个文件时，先试着从路由配置导入
function Read-Models {
    $path = Get-ModelsPath
    if (-not (Test-Path -LiteralPath $path)) {
        $imp = @(Import-RouterModels)
        if ($imp.Count) {
            $doc = [ordered]@{
                '说明' = '每个模型一项：name 随便起，报告里用它；base_url 是网关地址，不要带 /v1；api_key 是这个模型的 key；model 可以不填，网关要求特定模型名时再填。这个文件只在本机用，不会写进任何报告和结果目录。'
                models = $imp
            }
            Write-TextFile -Path $path -Text ($doc | ConvertTo-Json -Depth 5)
            Write-Ok ('已从你的模型路由配置里导入 ' + [string]$imp.Count + ' 个模型，写进了 models.json。路由里没配的 key，照同样的格式加进 models.json 就行')
        }
    }
    if (-not (Test-Path -LiteralPath $path)) { return }
    $j = Read-JsonFile $path
    if (-not $j -or -not $j.models) { Write-Bad 'models.json 不是合法的 JSON，或者里面没有 models'; return }
    $names = @{}
    foreach ($m in @($j.models)) {
        $n = ([string]$m.name).Trim()
        $u = ([string]$m.base_url).Trim().TrimEnd('/')
        $k = ([string]$m.api_key).Trim()
        if (-not $n -or -not $u -or -not $k) { continue }
        if ($k -match '你的|\.\.\.' -or $u -match '你的|网关地址') { continue }
        # Claude Code 会自己拼 /v1/messages，地址带了 /v1 就会变成 /v1/v1
        if ($u -match '/v1$') { $u = $u.Substring(0, $u.Length - 3) }
        $safe = Get-SafeName $n
        if ($names.ContainsKey($safe)) { $safe = $safe + '_' + [string]($names.Count + 1) }
        $names[$safe] = 1
        [ordered]@{ name = $n; base_url = $u; api_key = $k; model = ([string]$m.model).Trim(); safe = $safe }
    }
}

# 某个模型测过的所有结果摘要，新的在前（results\models\<模型>\<时间>\summary.json）
function Get-ModelRuns {
    param([string]$Safe)
    $d = Join-Path (Get-ProbeRoot) ('results\models\' + $Safe)
    if (-not (Test-Path -LiteralPath $d)) { return }
    foreach ($r in @(Get-ChildItem -LiteralPath $d -Directory | Sort-Object Name -Descending)) {
        $s = Read-JsonFile (Join-Path $r.FullName 'summary.json')
        if ($s) { $s }
    }
}

function Get-StatusText {
    param($S)
    if (-not $S) { return '还没测过' }
    switch ([string]$S.status) {
        'done'        { return ('已测完（' + [string]$S.ts + '）') }
        'partial'     { return ('没测完，中途不可用（' + [string]$S.ts + '）') }
        'unavailable' { return ('上次不可用（' + [string]$S.ts + '）') }
        default       { return ('上次状态未知（' + [string]$S.ts + '）') }
    }
}

# 列出模型让人选。直接回车 = 所有还没测完的（没测过、上次不可用、上次没测完）
function Select-Models {
    param($List)
    Write-Host ''
    Write-Host '可以测的模型：' -ForegroundColor Cyan
    for ($i = 0; $i -lt $List.Count; $i++) {
        $h = @(Get-ModelRuns $List[$i].safe) | Select-Object -First 1
        Write-Host ('  ' + [string]($i + 1) + '. ' + $List[$i].name + '    ' + (Get-StatusText $h))
    }
    $in = ([string](Read-Host '要测哪几个？输入编号，用逗号隔开；输入 all 全部重测；直接回车 = 所有还没测完的')).Trim()
    if (-not $in) {
        return @($List | Where-Object { $h = @(Get-ModelRuns $_.safe) | Select-Object -First 1; (-not $h) -or ([string]$h.status -ne 'done') })
    }
    if ($in -match '^(all|a|全部)$') { return @($List) }
    $idx = @($in -split '[,，\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ - 1 } | Where-Object { $_ -ge 0 -and $_ -lt $List.Count } | Select-Object -Unique)
    return @($idx | ForEach-Object { $List[$_] })
}

# 在体检用的配置（权限、计数 hook）上加 env 段，让 Claude Code 直连这个模型。
# 必须走 --settings：本机 2.1.266 实测，只设进程环境变量会被用户 settings.json 里指向路由的配置盖回去；
# --settings 的 env 能压过用户配置。两种鉴权都设成同一把 key：只设 API_KEY 时，请求里还会残留用户配置里的 Bearer 占位符
function New-ModelSettings {
    param($Model, [string]$BaseSettings, [int]$MaxRetries = 4)
    $s = [ordered]@{}
    $base = Read-JsonFile $BaseSettings
    if ($base) { foreach ($p in $base.PSObject.Properties) { $s[$p.Name] = $p.Value } }
    $envs = [ordered]@{
        ANTHROPIC_BASE_URL = $Model.base_url
        ANTHROPIC_AUTH_TOKEN = $Model.api_key
        ANTHROPIC_API_KEY = $Model.api_key
        # 模型被关时少重试几次，早点判为不可用，不在一道题上干等十几次退避
        CLAUDE_CODE_MAX_RETRIES = [string]$MaxRetries
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    }
    if ($Model.model) { foreach ($k in @('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL')) { $envs[$k] = $Model.model } }
    $s['env'] = $envs
    $wr = Get-AsciiWorkRoot
    $path = Join-Path $(if ($wr) { $wr } else { $env:TEMP }) ('model-' + [string]$PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
    Write-TextFile -Path $path -Text ($s | ConvertTo-Json -Depth 12)
    return $path
}

# 直连这个模型时给 Node 探针的环境变量。PROBE_IGNORE_SETTINGS 让探针不去读 ~/.claude/settings.json 里指向路由的配置
function Get-DirectEnv {
    param($Model)
    $e = @{ ANTHROPIC_BASE_URL = $Model.base_url; ANTHROPIC_AUTH_TOKEN = $Model.api_key; ANTHROPIC_API_KEY = $Model.api_key; STREAM_CHECK_TOKEN = $Model.api_key; PROBE_IGNORE_SETTINGS = '1' }
    if ($Model.model) { $e['ANTHROPIC_MODEL'] = $Model.model }
    return $e
}

# 探针请求里写的模型名。网关按 key 认模型，名字一般无所谓；网关要求特定名字时在 models.json 里填 model
function Get-ProbeModelName { param($Model) if ($Model.model) { return $Model.model }; return 'claude-opus-5' }

function Get-UnavailableReason {
    param([int]$Code, [string]$Err)
    $e = ([string]$Err).Trim()
    if ($e.Length -gt 160) { $e = $e.Substring(0, 160) + '…' }
    $why = ''
    if ($Code -eq 401) { $why = 'key 不对（401）' }
    elseif ($Code -eq 403) { $why = '没有权限，或者额度用完了（403）' }
    elseif ($Code -eq 404) { $why = '地址不对，或者网关不是 Anthropic 格式（404）' }
    elseif ($Code -eq 429) { $why = '限流或额度用完（429）' }
    elseif ($Code -ge 500) { $why = '网关或模型出错（' + [string]$Code + '）' }
    elseif ($Code -eq 0) { $why = '连不上' }
    else { $why = '状态 ' + [string]$Code }
    if ($e -match '(?i)model') { $why += '；可能是模型名不对，可以在 models.json 里给它加 model 字段' }
    if ($e) { $why += '：' + $e }
    return $why
}

# 用户的路由在测试期间有没有被经过：看它 /stats 的累计请求数。路由没装或没开时返回 $null
function Get-RouterTotal {
    $reg = Join-Path $env:USERPROFILE '.claude\model-router.json'
    if (-not (Test-Path -LiteralPath $reg)) { return $null }
    try {
        $r = Get-Content -LiteralPath $reg -Raw -Encoding UTF8 | ConvertFrom-Json
        $port = 15730
        if ($r.port) { $port = [int]$r.port }
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = $null
        $wc.Encoding = [System.Text.Encoding]::UTF8
        $txt = $wc.DownloadString('http://127.0.0.1:' + [string]$port + '/stats')
        return [int](($txt | ConvertFrom-Json).total)
    } catch { return $null }
}
