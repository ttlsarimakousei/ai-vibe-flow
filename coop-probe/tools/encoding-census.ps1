# encoding-census.ps1 —— 摸清家底：一个目录下各个工程的源码是什么编码
#   Claude Code 读写文件只认 UTF-8。GBK 的源码它一读，中文就是乱码；一改，整个文件的中文都被写坏
#   （本机 2.1.258、2.1.260 实测，内网的 2.1.259 夹在中间）。先看哪些工程是 GBK，再决定要不要给它们加编码保护。
# 参数：-Dir <目录>  放工程的上级目录，或者单个工程目录；不给则询问
param([string]$Dir = '')
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'legacy-build.ps1')
$root = Get-ProbeRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host '源码编码普查：哪些工程是 GBK' -ForegroundColor Cyan
if (-not $Dir) { $Dir = ([string](Read-Host '放工程的上级目录，或者单个工程目录（可以把文件夹拖进这个窗口）')).Trim().Trim('"') }
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { Write-Bad ('目录不存在：' + $Dir); return }
$Dir = (Resolve-Path -LiteralPath $Dir).ProviderPath

# 会写中文、AI 也会去改的文件类型
$types = @('*.java', '*.jsp', '*.js', '*.vue', '*.ts', '*.html', '*.htm', '*.xml', '*.properties', '*.sql', '*.css', '*.ftl', '*.vm')

function Test-ProjectDir {
    param([string]$D)
    foreach ($m in @('pom.xml', '.classpath', '.project', 'package.json', 'build.gradle', 'src', 'WebRoot', 'WebContent')) { if (Test-Path -LiteralPath (Join-Path $D $m)) { return $true } }
    return (@(Get-ChildItem -LiteralPath $D -Filter *.iml -File -ErrorAction SilentlyContinue).Count -gt 0)
}

$projects = @()
if (Test-ProjectDir $Dir) { $projects = @($Dir) }
else { $projects = @(Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue | Where-Object { Test-ProjectDir $_.FullName } | ForEach-Object { $_.FullName }) }
if (-not $projects.Count) { Write-Warn2 '这个目录下没认出工程（看的是 pom.xml / .classpath / .project / package.json / src 这类标志）'; return }
Write-Info ('共 ' + [string]$projects.Count + ' 个工程，逐个按文件内容判断编码')

$rows = @()
foreach ($p in $projects) {
    $files = @(Get-FilesSkipping -Root $p -Patterns $types -Max 8000)
    $e = Get-SourceEncoding -Files $files -MaxFiles 8000
    $name = [IO.Path]::GetFileName($p)
    $label = switch ([string]$e.verdict) { 'gbk' { 'GBK' } 'utf8' { 'UTF-8' } 'mixed' { 'GBK 与 UTF-8 混用' } default { '没有中文' } }
    $rows += [ordered]@{ name = $name; path = $p; verdict = [string]$e.verdict; label = $label; gbk = $e.gbk; utf8 = $e.utf8; ascii = $e.ascii; unknown = $e.unknown; checked = $e.checked; gbkTypes = @($e.gbkTypes); gbkSamples = @($e.gbkSamples); declared = @(Get-DeclaredEncoding -Dir $p) }
    $line = $name + '：' + $label + '（GBK ' + [string]$e.gbk + '，UTF-8 ' + [string]$e.utf8 + '，纯英文 ' + [string]$e.ascii + $(if ($e.gbkTypes.Count) { '；GBK 的文件类型 ' + ($e.gbkTypes -join ' ') } else { '' }) + '）'
    if ($e.verdict -eq 'gbk' -or $e.verdict -eq 'mixed') { Write-Bad $line } else { Write-Ok $line }
}

$nG = @($rows | Where-Object { $_.verdict -eq 'gbk' }).Count
$nM = @($rows | Where-Object { $_.verdict -eq 'mixed' }).Count
$nU = @($rows | Where-Object { $_.verdict -eq 'utf8' }).Count
$nA = @($rows | Where-Object { $_.verdict -eq 'ascii' }).Count
$sum = [string]$rows.Count + ' 个工程：GBK ' + [string]$nG + ' 个，混用 ' + [string]$nM + ' 个，UTF-8 ' + [string]$nU + ' 个，没有中文 ' + [string]$nA + ' 个'
Write-Step '结论'
Write-Host ('  ' + $sum) -ForegroundColor Cyan
if ($nG + $nM) { Write-Info 'GBK 和混用的工程，在加上编码保护之前不要让 AI 直接改代码' }

$L = @()
$L += ('# 源码编码普查 ' + $ts)
$L += ''
$L += ('- 目录：' + $Dir)
$L += ('- ' + $sum)
$L += ''
$L += '为什么要查：Claude Code 读写文件只认 UTF-8（本机 2.1.258、2.1.260 实测，内网的 2.1.259 夹在中间）。GBK 文件它一读，中文就是乱码；用 Edit 改其中一处，整个文件的中文全部变成乱码写回磁盘，工具照常返回成功，没有任何提醒；用 Write 重写，整个文件被悄悄转成 UTF-8，GBK 工程再编译就读错。'
$L += ''
$L += '| 工程 | 编码 | GBK 文件 | UTF-8 文件 | 纯英文 | GBK 的文件类型 | 工程配置里写的 |'
$L += '|---|---|---|---|---|---|---|'
foreach ($r in $rows) {
    $L += ('| ' + $r.name + ' | ' + $r.label + ' | ' + [string]$r.gbk + ' | ' + [string]$r.utf8 + ' | ' + [string]$r.ascii + ' | ' + $(if ($r.gbkTypes.Count) { $r.gbkTypes -join ' ' } else { '-' }) + ' | ' + $(if ($r.declared.Count) { ($r.declared -join '；') -replace '\|', '/' } else { '-' }) + ' |')
}
$L += ''
$L += '判断方法：每个文件先严格按 UTF-8 解，解不开再严格按 GBK 解，看的是文件实际内容，不看配置怎么写。跳过 .git、target、bin、build、out、node_modules、dist 这类目录。'
$outDir = Join-Path $root ('results\encoding-' + $ts)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$md = Join-Path $outDir 'encoding.md'
Write-TextFile -Path $md -Text ($L -join "`n")
Write-TextFile -Path (Join-Path $outDir 'encoding.json') -Text (ConvertTo-Json -InputObject @($rows) -Depth 5)
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('源码编码普查-' + $ts + '.md'); Copy-Item $md $desk -Force } catch { $desk = '' }
Write-Host ''
Write-Host ('  报告：' + $md) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
