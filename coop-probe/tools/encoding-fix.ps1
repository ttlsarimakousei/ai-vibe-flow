# encoding-fix.ps1 —— 把工程里少数 GBK 文件统一成 UTF-8
#   混用编码有两个直接后果：javac 一条命令编不过（内网实测 100 处"编码对不上"全是这个），
#   以及 Claude Code 一改 GBK 文件就把整个文件的中文写坏。
#   默认只出清单、不动文件；确认后加 -Apply 才转换：转换前整份备份，转换后逐字校验，对不上就自动还原。
#   默认只转 .java：javac 按一种编码读全部源码，改完就能编过，风险也最小。
#   其他类型（.js .css .htm .jsp .properties 等）只列出来不转：它们可能被声明了 GBK 的页面引用，
#   或者按 ISO-8859-1 读，转码要连带改声明和读取方式。看过清单确认没问题，再加 -All。
# 参数：-Dir <工程目录>  不给则询问
#       -Apply           真正转换（不加只出清单）
#       -All             连非 .java 的一起转，并同步改 htm/jsp/css/xml 里的编码声明
param([string]$Dir = '', [switch]$Apply, [switch]$All)
# 这个脚本要和包里的 tools\common.ps1、tools\legacy-build.ps1 放在一起。单独拷出来运行时给一句人话，不要报一堆红字
foreach ($dep in @('common.ps1', 'legacy-build.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $dep))) {
        Write-Host ('缺少 ' + (Join-Path $PSScriptRoot $dep) + '。这个脚本不能单独用：把补丁里的文件覆盖进 coop-probe 目录（tools\ 下的放 tools\，bat 放根目录），再从那里运行。') -ForegroundColor Red
        return
    }
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'legacy-build.ps1')
$root = Get-ProbeRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host '统一编码：把工程里少数 GBK 文件转成 UTF-8' -ForegroundColor Cyan
if (-not $Dir) { $Dir = ([string](Read-Host '工程目录（可以把文件夹拖进这个窗口）')).Trim().Trim('"') }
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { Write-Bad ('目录不存在：' + $Dir); return }
$Dir = (Resolve-Path -LiteralPath $Dir).ProviderPath

$SAFE = @('*.java')
$OTHER = @('*.js', '*.css', '*.htm', '*.html', '*.jsp', '*.properties', '*.xml', '*.sql', '*.txt', '*.vue', '*.ts', '*.ftl', '*.vm')
$files = @(Get-FilesSkipping -Root $Dir -Patterns ($SAFE + $OTHER) -Max 30000)
Write-Info ('扫描了 ' + [string]$files.Count + ' 个文本文件')

$u8strict = New-Object System.Text.UTF8Encoding($false, $true)
$u8out = New-Object System.Text.UTF8Encoding($false)
$gbk = [System.Text.Encoding]::GetEncoding(936, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
$cjkPat = '[' + [char]0x4E00 + '-' + [char]0x9FFF + ']'
$q = [string][char]34
$sq = [string][char]39

# 文件里写死的编码声明。.java 里出现的多半是代码逻辑（比如 setContentType 里的 charset），不能顺手改
$DECL_PATTERNS = @(
    ('(?i)(charset\s*=\s*[' + $q + $sq + ']?)(gb2312|gbk|gb18030)'),
    ('(?i)(pageEncoding\s*=\s*[' + $q + $sq + '])(gb2312|gbk|gb18030)'),
    ('(?i)(@charset\s+[' + $q + $sq + '])(gb2312|gbk|gb18030)'),
    ('(?i)(encoding\s*=\s*[' + $q + $sq + '])(gb2312|gbk|gb18030)')
)
function Get-EncodingDecl {
    param([string]$Text)
    $d = @()
    foreach ($p in $DECL_PATTERNS) { foreach ($m in [regex]::Matches($Text, $p)) { $d += $m.Value.Trim() } }
    return (($d | Select-Object -Unique) -join '，')
}
function Set-EncodingDecl {
    param([string]$Text)
    $s = $Text
    foreach ($p in $DECL_PATTERNS) { $s = [regex]::Replace($s, $p, '${1}UTF-8') }
    return $s
}

$rows = @()
foreach ($f in $files) {
    $b = $null
    try { $b = [IO.File]::ReadAllBytes($f) } catch { continue }
    if ($b.Length -eq 0) { continue }
    # UTF-8 能严格解开的就不用动（纯英文文件也在此列）
    $isU8 = $true
    try { [void]$u8strict.GetString($b) } catch { $isU8 = $false }
    if ($isU8) { continue }
    $text = $null
    try { $text = $gbk.GetString($b) } catch { $text = $null }
    $ext = [IO.Path]::GetExtension($f).ToLower()
    $rel = $f
    if ($f.StartsWith($Dir)) { $rel = $f.Substring($Dir.Length).TrimStart([char]92) }
    $rows += [ordered]@{
        path = $f; rel = $rel; ext = $ext; bytes = $b.Length
        readable = ($null -ne $text)
        cjk = $(if ($text) { ([regex]::Matches($text, $cjkPat)).Count } else { 0 })
        decl = $(if ($text) { Get-EncodingDecl $text } else { '' })
        isJava = ($ext -eq '.java')
        text = $text
        state = ''
    }
}

$gbkRows = @($rows | Where-Object { $_.readable })
$badRows = @($rows | Where-Object { -not $_.readable })
$javaRows = @($gbkRows | Where-Object { $_.isJava })
$otherRows = @($gbkRows | Where-Object { -not $_.isJava })
Write-Info ('非 UTF-8 的文件：' + [string]$gbkRows.Count + ' 个（.java ' + [string]$javaRows.Count + ' 个，其他 ' + [string]$otherRows.Count + ' 个）' + $(if ($badRows.Count) { '；另有 ' + [string]$badRows.Count + ' 个两种编码都解不开' } else { '' }))
foreach ($r in $gbkRows) { Write-Host ('    ' + $r.rel + '    ' + [string]$r.cjk + ' 个汉字' + $(if ($r.decl) { '，里面写着 ' + $r.decl } else { '' })) }

$outDir = Join-Path $root ('results\encoding-fix-' + $ts)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$toFix = @(if ($All) { $gbkRows } else { $javaRows })
$changed = @()
$failed = @()

if (-not $Apply) {
    Write-Step '这次只出清单，没有动任何文件'
    Write-Info ('确认清单没问题后，加 -Apply 再跑一次就会转换' + $(if ($otherRows.Count -and -not $All) { '（默认只转 ' + [string]$javaRows.Count + ' 个 .java；非 .java 的要连带改引用它们的页面声明，确认后再加 -All）' } else { '' }))
} elseif (-not $toFix.Count) {
    Write-Ok '没有需要转换的文件'
} else {
    $backup = Join-Path $outDir 'backup'
    Write-Step ('转换 ' + [string]$toFix.Count + ' 个文件（先整份备份到 ' + $backup + '）')
    foreach ($r in $toFix) {
        $dst = Join-Path $backup $r.rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
        Copy-Item -LiteralPath $r.path -Destination $dst -Force
        # .java 只转编码，不动里面任何 charset 字样：那是代码逻辑，改了会改变运行时行为
        $expected = $(if ($r.isJava) { $r.text } else { Set-EncodingDecl $r.text })
        try {
            [IO.File]::WriteAllText($r.path, $expected, $u8out)
            $back = [IO.File]::ReadAllBytes($r.path)
            $reread = $null
            try { $reread = $u8strict.GetString($back) } catch { $reread = $null }
            if ($reread -ne $expected) { throw '写回后读出来和预期不一致' }
            $r.state = 'ok'
            $changed += $r
            Write-Ok ($r.rel + '    ' + [string]$r.cjk + ' 个汉字' + $(if ((-not $r.isJava) -and ($expected -ne $r.text)) { '，编码声明已同步改成 UTF-8' } else { '' }))
        } catch {
            Copy-Item -LiteralPath $dst -Destination $r.path -Force
            $r.state = 'failed'
            $failed += $r
            Write-Bad ($r.rel + ' 转换失败，已从备份还原：' + $_.Exception.Message)
        }
    }
}

# ---------- 报告 ----------
$L = @()
$L += ('# 编码统一报告 ' + $ts)
$L += ''
$L += ('- 工程：' + $Dir)
$L += ('- 扫描 ' + [string]$files.Count + ' 个文本文件，非 UTF-8 的 ' + [string]$gbkRows.Count + ' 个（.java ' + [string]$javaRows.Count + '，其他 ' + [string]$otherRows.Count + '）')
$L += ('- 本次' + $(if ($Apply) { '已转换 ' + [string]$changed.Count + ' 个' + $(if ($failed.Count) { '，失败并还原 ' + [string]$failed.Count + ' 个' } else { '' }) } else { '只出清单，没有动任何文件' }))
if ($Apply -and $changed.Count) { $L += ('- 备份：' + (Join-Path $outDir 'backup') + '（按原目录结构，原样字节）') }
$L += ''
$L += '## 非 UTF-8 的文件'
$L += ''
$L += '| 文件 | 类型 | 汉字数 | 里面写死的编码声明 | 本次 |'
$L += '|---|---|---|---|---|'
foreach ($r in $gbkRows) {
    $act = $(if (-not $Apply) { '未动' } elseif ($r.state -eq 'ok') { '已转 UTF-8' } elseif ($r.state) { '失败已还原' } else { '未转（默认只转 .java）' })
    $L += ('| ' + $r.rel + ' | ' + $r.ext + ' | ' + [string]$r.cjk + ' | ' + $(if ($r.decl) { $r.decl } else { '-' }) + ' | ' + $act + ' |')
}
if ($badRows.Count) {
    $L += ''
    $L += '## 两种编码都解不开的文件（没动，要人看一眼）'
    $L += ''
    foreach ($r in $badRows) { $L += ('- ' + $r.rel) }
}
$L += ''
$L += '## 转完之后要做的'
$L += ''
$L += '- IDE 里把工程编码设成 UTF-8（IDEA：Settings → Editor → File Encodings，Project 和 Properties Files 都设 UTF-8），否则下次保存又会写回 GBK。'
$L += '- 编译命令用 -encoding UTF-8。「量编译速度」会自己按文件内容判断，转完再跑一次就会用 UTF-8。'
$L += '- .java 里出现的 charset=GBK 之类的字样一律没动，那是运行时编码，属于代码逻辑。下面这些文件里有，改不改你自己定：'
$javaDecl = @($javaRows | Where-Object { $_.decl })
if ($javaDecl.Count) { foreach ($r in $javaDecl) { $L += ('  - ' + $r.rel + '：' + $r.decl) } } else { $L += '  - （没有）' }
if ($otherRows.Count) {
    $L += '- 非 .java 的那些先别急着转：.js 和 .css 如果被声明了 GBK 的页面引用，转成 UTF-8 后页面上会变乱码，要连页面声明一起改；.properties 在 Java 8 里按 ISO-8859-1 读，最稳的是把中文转成 \uXXXX 转义。确认过再用 -All。'
}
$rp = Join-Path $outDir '编码统一报告.md'
Write-TextFile -Path $rp -Text ($L -join "`n")
Write-TextFile -Path (Join-Path $outDir 'files.json') -Text (ConvertTo-Json -InputObject @($gbkRows | ForEach-Object { [ordered]@{ rel = $_.rel; ext = $_.ext; bytes = $_.bytes; cjk = $_.cjk; decl = $_.decl; state = $_.state } }) -Depth 5)
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('编码统一报告-' + $ts + '.md'); Copy-Item $rp $desk -Force } catch { $desk = '' }
Write-Host ''
Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
