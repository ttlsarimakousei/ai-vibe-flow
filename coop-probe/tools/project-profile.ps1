# project-profile.ps1 —— 项目体检：一次扫一批项目，认出类型，实测"快检 / 全量编译 / 跑起来"三个数
#   工作流里最要紧的一条是"改完就验证"。能不能成立，全看这三个数：
#     快检：改完一处、确认没编坏，要等多久。超过几秒模型就不会跑，这条规矩就是空的
#     全量：收尾时跑一次要多久
#     启动：Spring Boot 这类项目，从启动到健康检查通为止要多久，决定"让模型自己起服务验证"可不可行
#   认得出的类型：Maven（单模块／多模块／Spring Boot 2、3）、Gradle、前端（package.json）、没有 pom 的老式 Java Web、纯源码目录
#   只往临时目录编译，不改项目里的任何文件。启动验证有副作用（会连数据库），默认不做，要加 -Run。
# 参数：-Dir <目录>      放项目的上级目录，或者单个项目目录；不给则询问
#       -Run             额外测 Spring Boot 从启动到健康检查通要多久（会真的把服务跑起来）
#       -SkipFull        跳过全量编译，只认类型和测快检
#       -MaxProjects 12  最多体检几个项目
#       -ListOnly        只列出认出了哪些项目，不跑编译
param([string]$Dir = '', [switch]$Run, [switch]$SkipFull, [int]$MaxProjects = 12, [switch]$ListOnly)
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
Write-Host '项目体检：认类型，实测快检 / 全量编译 / 跑起来' -ForegroundColor Cyan
if (-not $Dir) { $Dir = ([string](Read-Host '放项目的上级目录，或者单个项目目录（可以把文件夹拖进这个窗口）')).Trim().Trim('"') }
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { Write-Bad ('目录不存在：' + $Dir); return }
$Dir = (Resolve-Path -LiteralPath $Dir).ProviderPath
$outDir = Join-Path $root ('results\project-profile-' + $ts)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$wr = Get-AsciiWorkRoot
$work = Join-Path $(if ($wr) { $wr } else { $env:TEMP }) ('profile-' + [string]$PID)
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ---------- 工具 ----------
function Find-Exe {
    param([string[]]$Names)
    foreach ($n in $Names) { $c = Get-Command $n -ErrorAction SilentlyContinue; if ($c) { return $c.Source } }
    return ''
}
$mvnExe = Find-Exe @('mvn.cmd', 'mvn')
$npmExe = Find-Exe @('npm.cmd', 'npm')
$javacExe = Resolve-JavacExe

# 所有构建命令都走 cmd /s /c：mvn 和 npm 都是批处理，不能直接起进程
function Invoke-Build {
    param([string]$Cmd, [string]$WorkDir, [int]$TimeoutSec = 900)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Native -Exe 'cmd.exe' -ArgLine ('/s /c "' + $Cmd + '"') -WorkDir $WorkDir -TimeoutSec $TimeoutSec
    $sw.Stop()
    $text = ([string]$r.stdout) + ([string]$r.stderr)
    $lines = @($text -split "`r?`n")
    $first = ''
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '(?i)error|ERROR|错误|BUILD FAILURE|npm ERR') {
            $first = $lines[$i].Trim()
            # Maven 的 "Some problems were encountered while processing the POMs:" 只是个标题，真正的原因在后面几行
            if ($first -match ':\s*$' -or $first -match 'problems were encountered') {
                # 标题后面常常先跟几行 [WARNING]，真正拦住构建的是 [ERROR] / [FATAL]，优先取它们
                $tail = @($lines[($i + 1)..([Math]::Min($lines.Count - 1, $i + 40))] | Where-Object { $_.Trim() })
                $more = @($tail | Where-Object { $_ -match '^\s*\[(ERROR|FATAL)\]\s*\S' -and $_ -notmatch 'problems were encountered|^\s*\[ERROR\]\s*$' } | Select-Object -First 2)
                if (-not $more.Count) { $more = @($tail | Select-Object -First 2) }
                if ($more.Count) { $first += ' ' + (($more | ForEach-Object { $_.Trim() }) -join ' ') }
            }
            break
        }
    }
    if ($first.Length -gt 300) { $first = $first.Substring(0, 300) + '…' }
    return [ordered]@{ cmd = $Cmd; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); exitCode = $r.exitCode; timedOut = $r.timedOut; firstError = $first; text = $text }
}

function Get-NewestJava {
    param([string[]]$Files)
    if (-not $Files.Count) { return '' }
    return [string](@($Files | Sort-Object { [IO.File]::GetLastWriteTimeUtc($_) } -Descending) | Select-Object -First 1)
}

# ---------- pom 解析 ----------
function Read-Pom {
    param([string]$PomPath)
    $o = [ordered]@{ artifactId = ''; packaging = 'jar'; modules = @(); boot = ''; javaVersion = ''; sourceEncoding = '' }
    $raw = ''
    try { $raw = Get-Content -LiteralPath $PomPath -Raw -Encoding UTF8 } catch { return $o }
    try {
        $x = [xml]$raw
        $p = $x.project
        if ($p) {
            $o.artifactId = [string]$p.artifactId
            if ($p.packaging) { $o.packaging = [string]$p.packaging }
            if ($p.modules -and $p.modules.module) { $o.modules = @($p.modules.module | ForEach-Object { [string]$_ }) }
            if ($p.parent -and ([string]$p.parent.artifactId) -eq 'spring-boot-starter-parent') { $o.boot = [string]$p.parent.version }
            if ($p.properties) {
                foreach ($n in $p.properties.ChildNodes) {
                    $nm = [string]$n.Name
                    $v = [string]$n.InnerText
                    if ((-not $o.javaVersion) -and ($nm -eq 'java.version' -or $nm -eq 'maven.compiler.source' -or $nm -eq 'maven.compiler.release')) { $o.javaVersion = $v }
                    if ((-not $o.sourceEncoding) -and $nm -eq 'project.build.sourceEncoding') { $o.sourceEncoding = $v }
                    if ((-not $o.boot) -and ($nm -eq 'spring-boot.version' -or $nm -eq 'spring.boot.version')) { $o.boot = $v }
                }
            }
        }
    } catch { }
    # XML 解析不到就退回正则，老项目的 pom 经常带 BOM 或者格式不规整
    if (-not $o.artifactId) { if ($raw -match '(?s)<artifactId>\s*([^<]+)\s*</artifactId>') { $o.artifactId = $matches[1].Trim() } }
    if (-not $o.boot -and $raw -match '(?s)spring-boot-starter-parent.*?<version>\s*([^<]+)\s*</version>') { $o.boot = $matches[1].Trim() }
    if (-not $o.boot -and $raw -match '(?s)<artifactId>\s*spring-boot-dependencies\s*</artifactId>\s*<version>\s*([^<]+)') { $o.boot = $matches[1].Trim() }
    if (-not $o.boot -and $raw -match 'spring-boot-starter') { $o.boot = '有 starter，版本在父 pom 里' }
    return $o
}

function Get-ServerPort {
    param([string]$ProjDir)
    foreach ($f in @('src\main\resources\application.properties', 'src\main\resources\application.yml', 'src\main\resources\application.yaml')) {
        $p = Join-Path $ProjDir $f
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $t = ''
        try { $t = Get-Content -LiteralPath $p -Raw -Encoding UTF8 } catch { continue }
        if ($t -match '(?m)^\s*server\.port\s*[=:]\s*(\d+)') { return [int]$matches[1] }
        if ($t -match '(?ms)^\s*server\s*:\s*.*?^\s+port\s*:\s*(\d+)') { return [int]$matches[1] }
    }
    return 8080
}

# 把 Spring Boot 起起来，轮询健康检查，通了就记时间，然后连同子进程一起杀掉。
# 有副作用（会连数据库、可能跑定时任务），所以只在 -Run 时做。404 也算起来了：Boot 没有根路由时就是 404
function Start-BootAndPing {
    param([string]$ProjDir, [int]$Port, [string]$LogFile, [int]$TimeoutSec = 300, [string]$MvnFlag = ' -o')
    $o = [ordered]@{ ok = $false; seconds = 0; url = ''; note = '' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/s /c "mvn' + $MvnFlag + ' -DskipTests spring-boot:run > ""' + $LogFile + '"" 2>&1"'
    $psi.WorkingDirectory = $ProjDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = $null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $urls = @(('http://127.0.0.1:' + [string]$Port + '/actuator/health'), ('http://127.0.0.1:' + [string]$Port + '/'))
        while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
            if ($proc.HasExited) { $o.note = '进程自己退出了（退出码 ' + [string]$proc.ExitCode + '），日志见 ' + $LogFile; break }
            foreach ($u in $urls) {
                try {
                    $wc = New-Object System.Net.WebClient
                    $wc.Proxy = $null
                    [void]$wc.DownloadString($u)
                    $o.ok = $true; $o.url = $u
                } catch {
                    $resp = $null
                    if ($_.Exception.Response) { $resp = $_.Exception.Response }
                    elseif ($_.Exception.InnerException -and $_.Exception.InnerException.Response) { $resp = $_.Exception.InnerException.Response }
                    if ($resp -and [int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 500) { $o.ok = $true; $o.url = $u + '（' + [string][int]$resp.StatusCode + '）' }
                }
                if ($o.ok) { break }
            }
            if ($o.ok) { break }
            Start-Sleep -Milliseconds 800
        }
        if (-not $o.ok -and -not $o.note) { $o.note = '等了 ' + [string]$TimeoutSec + ' 秒还没通，日志见 ' + $LogFile }
    } catch { $o.note = '起不来：' + $_.Exception.Message }
    finally {
        $sw.Stop()
        $o.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        if ($proc -and -not $proc.HasExited) { try { & cmd.exe /c ('taskkill /T /F /PID ' + [string]$proc.Id + ' >nul 2>nul') | Out-Null } catch { } }
    }
    return $o
}

# ---------- 找项目 ----------
# -Strict：只认明确的标志文件。父目录底下有 .java 不等于它自己就是个项目，
# 不先按标志判断的话，扫一个放了好几个项目的目录时会把父目录整个当成一个项目
function Get-ProjectKind {
    param([string]$D, [switch]$Strict)
    if (Test-Path -LiteralPath (Join-Path $D 'pom.xml')) { return 'maven' }
    if ((Test-Path -LiteralPath (Join-Path $D 'build.gradle')) -or (Test-Path -LiteralPath (Join-Path $D 'build.gradle.kts'))) { return 'gradle' }
    if (Test-Path -LiteralPath (Join-Path $D 'package.json')) { return 'frontend' }
    foreach ($c in @('WebRoot\WEB-INF', 'WebContent\WEB-INF', 'web\WEB-INF', 'src\main\webapp\WEB-INF')) { if (Test-Path -LiteralPath (Join-Path $D $c)) { return 'legacy' } }
    if ((Test-Path -LiteralPath (Join-Path $D '.classpath')) -or (@(Get-ChildItem -LiteralPath $D -Filter *.iml -File -ErrorAction SilentlyContinue).Count -gt 0)) { return 'legacy' }
    if ($Strict) { return '' }
    # 非严格：目录里直接就有 .java（不看子目录）才算一个散的源码目录，否则继续往下找，别把上层目录整个吞掉
    try { if (@([IO.Directory]::GetFiles($D, '*.java')).Count -gt 0) { return 'java' } } catch { }
    return ''
}

# 项目常常套在一层"仓库目录"底下（AI-OA\sjytoa、CZXT\SmartTreasuryPlatform 这种），所以往下找三层：
# 有明确标志的目录算一个项目；没有标志就再往下找；再往下也没有，才把它当成一个纯源码目录
function Find-Projects {
    param([string]$D, [int]$Depth, [string]$Base)
    $found = @()
    foreach ($c in @(Get-ChildItem -LiteralPath $D -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($script:SkipDirNames -contains $c.Name) { continue }
        $rel = $c.FullName.Substring($Base.Length).TrimStart([char]92)
        $k = Get-ProjectKind -D $c.FullName -Strict
        if ($k) { $found += [ordered]@{ dir = $c.FullName; name = $rel; kind = $k }; continue }
        $nested = @()
        if ($Depth -gt 1) { $nested = @(Find-Projects -D $c.FullName -Depth ($Depth - 1) -Base $Base) }
        if ($nested.Count) { $found += $nested; continue }
        $k2 = Get-ProjectKind -D $c.FullName
        if ($k2) { $found += [ordered]@{ dir = $c.FullName; name = $rel; kind = $k2 } }
    }
    return $found
}
$projects = @()
$selfKind = Get-ProjectKind -D $Dir -Strict
if ($selfKind) { $projects += [ordered]@{ dir = $Dir; name = [IO.Path]::GetFileName($Dir); kind = $selfKind } }
else {
    $projects = @(Find-Projects -D $Dir -Depth 4 -Base $Dir)
    # 底下一个项目都没认出来，但确实有 .java：把整个目录当一棵源码树
    if (-not $projects.Count -and @(Get-FilesSkipping -Root $Dir -Patterns @('*.java') -Max 5).Count -gt 0) {
        $projects += [ordered]@{ dir = $Dir; name = [IO.Path]::GetFileName($Dir); kind = 'java' }
    }
}
$projects = @($projects | Select-Object -First $MaxProjects)
# 文件名里用的名字：把路径分隔符这些换掉
foreach ($p in $projects) { $p.safe = ($p.name -replace '[^\w.-]', '_') }
if ($ListOnly) {
    if (-not $projects.Count) { Write-Bad '这个目录下没认出项目'; return }
    Write-Info ('认出 ' + [string]$projects.Count + ' 个项目（只列出，不跑）：')
    foreach ($p in $projects) { Write-Host ('    ' + $p.name.PadRight(40) + $p.kind) }
    return
}
if (-not $projects.Count) { Write-Bad '这个目录下没认出项目（往下找了四层，看的是 pom.xml / build.gradle / package.json / WEB-INF / .classpath / *.iml / 直接放着的 .java）'; return }
Write-Info ('认出 ' + [string]$projects.Count + ' 个项目：' + (($projects | ForEach-Object { $_.name + '(' + $_.kind + ')' }) -join '，'))

# ---------- 逐个体检 ----------
$rows = @()
foreach ($p in $projects) {
    Write-Step ($p.name + '（' + $p.kind + '）')
    $r = [ordered]@{ name = $p.name; dir = $p.dir; kind = $p.kind; label = ''; encoding = ''; full = $null; fast = $null; prep = $null; run = $null; notes = @(); recipe = [ordered]@{} }
    try {
        if ($p.kind -eq 'maven') {
            $pom = Read-Pom (Join-Path $p.dir 'pom.xml')
            $isMulti = @($pom.modules).Count -gt 0
            $bootLabel = $(if ($pom.boot) { 'Spring Boot ' + $pom.boot } else { '普通 Maven' })
            $r.label = $bootLabel + $(if ($isMulti) { '，多模块（' + [string]@($pom.modules).Count + ' 个）' } else { '，单模块' }) + $(if ($pom.javaVersion) { '，Java ' + $pom.javaVersion } else { '' }) + $(if ($pom.packaging -ne 'jar') { '，打包 ' + $pom.packaging } else { '' })
            Write-Info $r.label
            if (-not $mvnExe) { $r.notes += '没找到 mvn，没法测'; $rows += $r; continue }
            # 源码目录：多模块时逐个模块找
            $srcDirs = @()
            if ($isMulti) { foreach ($m in $pom.modules) { $md = Join-Path $p.dir ($m -replace '/', [string][char]92); if (Test-Path -LiteralPath (Join-Path $md 'src\main\java')) { $srcDirs += (Join-Path $md 'src\main\java') } } }
            if (Test-Path -LiteralPath (Join-Path $p.dir 'src\main\java')) { $srcDirs += (Join-Path $p.dir 'src\main\java') }
            $javaFiles = @()
            foreach ($sd in $srcDirs) { $javaFiles += @(Get-FilesSkipping -Root $sd -Patterns @('*.java') -Max 8000) }
            $enc = Get-SourceEncoding -Files $javaFiles -MaxFiles 2000
            $r.encoding = Get-EncodingText $enc
            $r.sourceCount = $javaFiles.Count
            Write-Info ('源码 ' + [string]$javaFiles.Count + ' 个 .java；编码 ' + $(if ($pom.sourceEncoding) { 'pom 里写的是 ' + $pom.sourceEncoding + '，实际内容是 ' } else { '' }) + $r.encoding)

            # 先离线试。内网有私服的项目，父 pom 和公司内部依赖常常只在私服上，离线必然解析不到，这时去掉 -o 走私服再来一次
            $mvnO = ' -o'
            if (-not $SkipFull) {
                Write-Info '全量编译（mvn -o -q -DskipTests compile）……'
                $r.full = Invoke-Build -Cmd 'mvn -o -q -DskipTests compile' -WorkDir $p.dir -TimeoutSec 1800
                if ($r.full.exitCode -ne 0 -and $r.full.text -match 'offline mode|has not been downloaded|Non-resolvable|Could not find artifact|Could not resolve dependencies') {
                    Write-Warn2 '离线解析不到依赖（父 pom 或内部构件只在私服上），去掉 -o 走私服再编一次'
                    $r.fullOffline = $r.full
                    $r.full = Invoke-Build -Cmd 'mvn -q -DskipTests compile' -WorkDir $p.dir -TimeoutSec 1800
                    $mvnO = ''
                    $r.notes += '这个项目离线（-o）编不了：父 pom 或公司内部依赖不在本地仓库，要连私服。配方里的命令已经去掉 -o'
                }
                if ($r.full.exitCode -eq 0) { Write-Ok ('全量编译 ' + [string]$r.full.seconds + ' 秒') }
                else { Write-Warn2 ('全量编译没过（' + [string]$r.full.seconds + ' 秒，退出码 ' + [string]$r.full.exitCode + '）：' + $r.full.firstError) }
            }
            # 快检：先把依赖 classpath 导出来（这一步只做一次，可以缓存），再用 javac 只编一个文件
            $one = Get-NewestJava $javaFiles
            if ($one -and $javacExe) {
                $modDir = $p.dir
                foreach ($sd in $srcDirs) { if ($one.StartsWith($sd)) { $modDir = (Split-Path (Split-Path (Split-Path $sd -Parent) -Parent) -Parent); break } }
                $cpFile = Join-Path $work ('cp-' + $p.safe + '.txt')
                # 多模块要从根目录带 -pl <模块> -am 导：子模块依赖兄弟模块，单独在子模块里导会解析不到
                $modRel = ''
                if ($modDir -ne $p.dir -and $modDir.StartsWith($p.dir)) { $modRel = $modDir.Substring($p.dir.Length).TrimStart([char]92).Replace([string][char]92, '/') }
                # 命令里要先走一遍 compile 再导：直接调插件目标时，兄弟模块还没产出构件，依赖解析不到
                $cpTail = ' -q -DskipTests -DincludeScope=compile "-Dmdep.outputFile=' + $cpFile + '" compile dependency:build-classpath'
                $cpPl = $(if ($modRel) { ' -pl ' + $modRel + ' -am' } else { '' })
                Write-Info '导出依赖 classpath（一次性，之后可以缓存复用）……'
                $r.prep = Invoke-Build -Cmd ('mvn' + $mvnO + $cpPl + $cpTail) -WorkDir $p.dir -TimeoutSec 900
                # 离线导不出多半是本地仓库里没有 maven-dependency-plugin：退回联网/私服再试一次，并写明原因
                if ($r.prep.exitCode -ne 0 -or -not (Test-Path -LiteralPath $cpFile)) {
                    Write-Warn2 ('离线导 classpath 没成功（' + $r.prep.firstError + '），改用私服/联网再试一次')
                    $r.prep2 = Invoke-Build -Cmd ('mvn' + $cpPl + $cpTail) -WorkDir $p.dir -TimeoutSec 900
                    if ($r.prep2.exitCode -eq 0 -and (Test-Path -LiteralPath $cpFile)) {
                        $r.notes += '本地仓库里没有 maven-dependency-plugin，离线导不出 classpath；走私服取过一次之后就能离线用了'
                        $r.prep = $r.prep2
                    } else {
                        $r.notes += ('导 classpath 失败，离线和联网都不行：' + $r.prep2.firstError + '。没有它就只能退回 mvn compile 当快检')
                    }
                }
                if ((Test-Path -LiteralPath $cpFile) -and $r.prep.exitCode -eq 0) {
                    $cp = @((Get-Content -LiteralPath $cpFile -Raw).Trim() -split ';' | Where-Object { $_ })
                    $classes = Join-Path $modDir 'target\classes'
                    if (Test-Path -LiteralPath $classes) { $cp = @($classes) + $cp }
                    $argFile = Join-Path $work ('one-' + $p.safe + '.args')
                    Write-JavacArgFile -Path $argFile -ClassPath $cp -Sources @($one)
                    $encName = $(if ($pom.sourceEncoding) { $pom.sourceEncoding } else { $enc.javacEncoding })
                    $jr = Invoke-Javac -Javac $javacExe -ArgFile $argFile -OutDir (Join-Path $work ('oneout-' + $p.safe)) -Encoding $encName -TimeoutSec 300
                    $dg = Get-JavacDiagnosis $jr.text
                    $r.fast = [ordered]@{ cmd = 'javac -cp <缓存的 classpath>;target\classes -d <临时目录> <改动的那个文件>'; seconds = $jr.seconds; exitCode = $jr.exitCode; errors = $dg.errors; firstError = $jr.firstLine; file = $one; text = $jr.text }
                    if ($jr.exitCode -eq 0) { Write-Ok ('快检（只编一个文件）' + [string]$jr.seconds + ' 秒') }
                    else { Write-Warn2 ('快检 ' + [string]$jr.seconds + ' 秒，但有 ' + [string]$dg.errors + ' 个错误：' + $jr.firstLine) }
                } else { $r.notes += ('导出 classpath 失败（' + [string]$r.prep.seconds + ' 秒）：' + $r.prep.firstError) }
            } elseif (-not $javacExe) { $r.notes += '没找到 javac，测不了快检' }

            if ($Run -and $pom.boot) {
                $port = Get-ServerPort $p.dir
                Write-Info ('启动验证：mvn' + $mvnO + ' spring-boot:run，等 ' + [string]$port + ' 端口上的健康检查通……')
                $r.run = Start-BootAndPing -ProjDir $p.dir -Port $port -LogFile (Join-Path $outDir ($p.safe + '-boot.log')) -MvnFlag $mvnO
                if ($r.run.ok) { Write-Ok ('启动到能访问 ' + [string]$r.run.seconds + ' 秒（' + $r.run.url + '）') }
                else {
                    Write-Warn2 ('没等到服务起来（' + [string]$r.run.seconds + ' 秒）：' + $r.run.note)
                    # 实测过的一个坑：项目路径里有中文时，spring-boot:run 传 classpath 的临时参数文件会编码出错，报找不到主类
                    if (-not (Test-AsciiPath $p.dir)) { $r.notes += '项目路径里有中文。spring-boot:run 会把 classpath 写进临时参数文件，中文路径在这一步容易编码出错，表现就是"找不到主类"。把项目放到纯英文路径再试' }
                }
            }
            $r.recipe = [ordered]@{
                full = 'mvn' + $mvnO + ' -q -DskipTests compile'
                fast = 'javac -encoding ' + $(if ($pom.sourceEncoding) { $pom.sourceEncoding } else { $enc.javacEncoding }) + ' -cp "@cp.txt;target/classes" -d %TEMP%\fastcheck <改动的文件>'
                prep = 'mvn' + $mvnO + ' -q -DincludeScope=compile -Dmdep.outputFile=cp.txt dependency:build-classpath  （依赖变了才要重跑）'
                test = 'mvn' + $mvnO + ' -q -Dtest=<类名> test'
                run = $(if ($pom.boot) { 'mvn' + $mvnO + ' spring-boot:run' } else { '（不是 Spring Boot，看项目怎么部署）' })
            }
        }
        elseif ($p.kind -eq 'frontend') {
            $pkg = $null
            try { $pkg = Get-Content -LiteralPath (Join-Path $p.dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            $deps = @{}
            foreach ($sec in @('dependencies', 'devDependencies')) { if ($pkg -and $pkg.$sec) { foreach ($d in $pkg.$sec.PSObject.Properties) { $deps[$d.Name] = [string]$d.Value } } }
            $fw = @()
            if ($deps.ContainsKey('vue')) { $fw += 'Vue ' + $deps['vue'] }
            if ($deps.ContainsKey('react')) { $fw += 'React ' + $deps['react'] }
            if ($deps.ContainsKey('vite')) { $fw += 'Vite' }
            if ($deps.ContainsKey('webpack') -or $deps.ContainsKey('@vue/cli-service')) { $fw += 'webpack/vue-cli' }
            if ($deps.ContainsKey('typescript')) { $fw += 'TypeScript' }
            if ($deps.ContainsKey('element-plus')) { $fw += 'Element Plus' }
            $r.label = $(if ($fw.Count) { $fw -join '，' } else { '前端项目' })
            Write-Info $r.label
            $hasModules = Test-Path -LiteralPath (Join-Path $p.dir 'node_modules')
            if (-not $hasModules) { $r.notes += 'node_modules 不在，装了依赖才能测'; Write-Warn2 'node_modules 不在，跳过编译测量' }
            elseif (-not $npmExe) { $r.notes += '没找到 npm' }
            else {
                if (-not $SkipFull -and $pkg -and $pkg.scripts -and $pkg.scripts.build) {
                    Write-Info '全量构建（npm run build）……'
                    $r.full = Invoke-Build -Cmd 'npm run build' -WorkDir $p.dir -TimeoutSec 1800
                    if ($r.full.exitCode -eq 0) { Write-Ok ('全量构建 ' + [string]$r.full.seconds + ' 秒') } else { Write-Warn2 ('构建没过：' + $r.full.firstError) }
                }
                # 前端分两个数：eslint 查单个文件当快检（改完一处用），vue-tsc/tsc 是全量类型检查（收尾用）
                $one = Get-NewestJava (@(Get-FilesSkipping -Root (Join-Path $p.dir 'src') -Patterns @('*.vue', '*.ts', '*.js') -Max 3000))
                if ($deps.ContainsKey('eslint') -and $one) {
                    $rel = $one.Substring($p.dir.Length).TrimStart([char]92)
                    $fastCmd = 'npx --no-install eslint "' + $rel + '"'
                    Write-Info ('快检（' + $fastCmd + '）……')
                    $r.fast = Invoke-Build -Cmd $fastCmd -WorkDir $p.dir -TimeoutSec 600
                    $r.fast.cmd = $fastCmd
                    $r.fast.file = $one
                }
                $tcCmd = ''
                if ($deps.ContainsKey('vue-tsc')) { $tcCmd = 'npx --no-install vue-tsc --noEmit' }
                elseif ($deps.ContainsKey('typescript')) { $tcCmd = 'npx --no-install tsc --noEmit' }
                if ($tcCmd) {
                    Write-Info ('全量类型检查（' + $tcCmd + '）……')
                    $r.typecheck = Invoke-Build -Cmd $tcCmd -WorkDir $p.dir -TimeoutSec 900
                    $r.typecheck.cmd = $tcCmd
                    # 类型检查现在就是红的，就不能直接拿来当闸门：得先把现有错误记下来，只拦新增的
                    if ($r.typecheck.exitCode -ne 0 -and $r.typecheck.firstError -match 'error TS') { $r.notes += ('类型检查现在就是红的（' + $r.typecheck.firstError + '），不能直接当闸门，要先记下现有错误、只拦新增的') }
                }
                if (-not $r.fast) {
                    $r.notes += $(if ($r.typecheck) { '没装 eslint，没有单文件级的快检；vue-tsc 是全量类型检查，' + [string]$r.typecheck.seconds + ' 秒，改一处等这么久不现实，前端改完更适合靠 dev server 热更新加浏览器验证' } else { '没有 eslint 也没有类型检查，前端改完只能靠构建或者浏览器验证' })
                }
                $shown = @()
                foreach ($m in @($r.fast, $r.typecheck)) {
                    if (-not $m) { continue }
                    if ($shown -contains $m.cmd) { continue }
                    $shown += $m.cmd
                    if ($m.exitCode -eq 0) { Write-Ok ($m.cmd + '：' + [string]$m.seconds + ' 秒') }
                    elseif ($m.firstError -match 'missing packages|could not determine executable|not found') { Write-Warn2 ($m.cmd + '：这个工具没装在项目里（' + [string]$m.seconds + ' 秒）'); $r.notes += ($m.cmd + ' 跑不了：工具没装进 node_modules') }
                    else { Write-Warn2 ($m.cmd + '：' + [string]$m.seconds + ' 秒，有问题：' + $m.firstError) }
                }
            }
            $r.recipe = [ordered]@{
                full = 'npm run build'
                fast = $(if ($r.fast) { $r.fast.cmd } else { '（没有单文件快检，靠 dev server 热更新加浏览器验证）' })
                typecheck = $(if ($r.typecheck) { $r.typecheck.cmd + '  （全量，收尾时跑；现有错误先记基线，只拦新增）' } else { '（没有）' })
                run = $(if ($pkg -and $pkg.scripts -and $pkg.scripts.dev) { 'npm run dev' } else { 'npm start' })
            }
        }
        elseif ($p.kind -eq 'gradle') {
            $wrapper = Test-Path -LiteralPath (Join-Path $p.dir 'gradlew.bat')
            $r.label = 'Gradle' + $(if ($wrapper) { '（带 wrapper）' } else { '' })
            Write-Info $r.label
            $g = $(if ($wrapper) { 'gradlew.bat' } else { 'gradle' })
            if (-not $SkipFull) {
                Write-Info '全量编译（compileJava --offline）……'
                $r.full = Invoke-Build -Cmd ($g + ' compileJava --offline -q') -WorkDir $p.dir -TimeoutSec 1800
                if ($r.full.exitCode -eq 0) { Write-Ok ('全量编译 ' + [string]$r.full.seconds + ' 秒') } else { Write-Warn2 ('没过：' + $r.full.firstError) }
            }
            $r.notes += 'Gradle 的快检通道还没做：它的 classpath 导出方式和 Maven 不同，等你确认有 Gradle 项目再补'
            $r.recipe = [ordered]@{ full = $g + ' compileJava --offline'; fast = '（待补）'; run = $g + ' bootRun --offline' }
        }
        elseif ($p.kind -eq 'legacy' -or $p.kind -eq 'java') {
            if (-not $javacExe) { $r.notes += '没找到 javac'; $rows += $r; continue }
            $plan = Get-JavaBuildPlan -Dir $p.dir -BundledLib (Join-Path $root 'tools\javaprobe\lib')
            $r.label = $plan.layout + '，' + [string]$plan.sourceCount + ' 个 .java，' + [string]$plan.jarCount + ' 个 jar；Servlet 接口：' + $plan.servletApi
            $r.encoding = Get-EncodingText $plan.encoding
            $r.sourceCount = $plan.sourceCount
            Write-Info $r.label
            Write-Info ('编码：' + $r.encoding)
            if ($plan.sourceCount -gt 0) {
                $argFile = Join-Path $work ('all-' + $p.safe + '.args')
                Write-JavacArgFile -Path $argFile -ClassPath $plan.jars -Sources $plan.sources
                $encName = $plan.encoding.javacEncoding
                if (-not $SkipFull) {
                    Write-Info '全量编译（javac 全部源码）……'
                    $jr = Invoke-Javac -Javac $javacExe -ArgFile $argFile -OutDir (Join-Path $work ('allout-' + $p.safe)) -Encoding $encName -TimeoutSec 1800
                    $dg = Get-JavacDiagnosis $jr.text
                    $r.full = [ordered]@{ cmd = 'javac @全部源码'; seconds = $jr.seconds; exitCode = $jr.exitCode; errors = $dg.errors; firstError = $jr.firstLine; text = $jr.text }
                    if ($jr.exitCode -eq 0) { Write-Ok ('全量编译 ' + [string]$jr.seconds + ' 秒') } else { Write-Warn2 ('全量编译 ' + [string]$jr.seconds + ' 秒，' + [string]$dg.errors + ' 个错误：' + $jr.firstLine) }
                    foreach ($h in $dg.hints) { $r.notes += $h }
                }
                $one = Get-NewestJava $plan.sources
                $argOne = Join-Path $work ('one-' + $p.safe + '.args')
                Write-JavacArgFile -Path $argOne -ClassPath (@((Join-Path $work ('allout-' + $p.safe))) + @($plan.jars)) -Sources @($one)
                $jr1 = Invoke-Javac -Javac $javacExe -ArgFile $argOne -OutDir (Join-Path $work ('oneout-' + $p.safe)) -Encoding $encName -TimeoutSec 300
                $dg1 = Get-JavacDiagnosis $jr1.text
                $r.fast = [ordered]@{ cmd = 'javac -cp <全部 jar>;<上次编译的输出> -d <临时目录> <改动的那个文件>'; seconds = $jr1.seconds; exitCode = $jr1.exitCode; errors = $dg1.errors; firstError = $jr1.firstLine; file = $one; text = $jr1.text }
                Write-Ok ('快检（只编一个文件）' + [string]$jr1.seconds + ' 秒' + $(if ($dg1.errors) { '，' + [string]$dg1.errors + ' 个错误' } else { '' }))
                # 老工程的快检靠上一次全量编译的产物找同工程的类，跳过了全量就必然报找不到符号，那个错误数不作数
                if ($SkipFull -and $dg1.errors) { $r.notes += '这次跳过了全量编译，快检找不到同工程的其他类，错误数不作数；时间数照样有效' }
                $r.recipe = [ordered]@{ full = 'javac @sources.args（见「量编译速度」生成的 javac-build.cmd）'; fast = 'javac -cp <jar 列表>;<输出目录> -d %TEMP%\fastcheck <改动的文件>'; run = '在 IDE 里配 Tomcat 启动，或者用 catalina.bat' }
            }
        }
    } catch {
        $r.notes += ('体检这个项目时出错：' + $_.Exception.Message)
        Write-Bad ('出错：' + $_.Exception.Message)
    }
    # 每一步的原始输出都留成文件：报告里只放第一行错误，真要查原因得看全文
    foreach ($k in @('full', 'fast', 'prep', 'typecheck')) {
        $m = $r[$k]
        if ($m -and $m.text) { Write-TextFile -Path (Join-Path $outDir ($p.safe + '-' + $k + '.log')) -Text ([string]$m.text); $m.log = ($p.safe + '-' + $k + '.log') }
    }
    foreach ($n in $r.notes) { Write-Info ('备注：' + $n) }
    $rows += $r
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 报告 ----------
function Cell { param($M) if (-not $M) { return '-' }; $t = [string]$M.seconds + ' 秒'; if ($M.exitCode -ne 0) { $t += '（没过）' }; return $t }
$L = @()
$L += ('# 项目体检报告 ' + $ts)
$L += ''
$L += ('- 目录：' + $Dir + '；认出 ' + [string]$rows.Count + ' 个项目')
$L += '- 快检 = 改完一处、只检查这一处要多久；全量 = 收尾时整体编译一次要多久。快检超过几秒，"改完就验证"这条规矩就立不住。'
$L += ''
$L += '| 项目 | 类型 | 规模 | 源码编码 | 快检 | 全量 | 启动到能访问 |'
$L += '|---|---|---|---|---|---|---|'
foreach ($r in $rows) {
    $size = $(if ($r.sourceCount) { [string]$r.sourceCount + ' 个 .java' } else { '-' })
    $L += ('| ' + $r.name + ' | ' + $r.kind + '：' + $r.label + ' | ' + $size + ' | ' + $(if ($r.encoding) { ($r.encoding -replace '（.*', '') } else { '-' }) + ' | ' + (Cell $r.fast) + ' | ' + (Cell $r.full) + ' | ' + $(if ($r.run) { $(if ($r.run.ok) { [string]$r.run.seconds + ' 秒' } else { '没起来' }) } else { '-' }) + ' |')
}
$L += ''
foreach ($r in $rows) {
    $L += ('## ' + $r.name)
    $L += ''
    $L += ('- 类型：' + $r.kind + '，' + $r.label)
    if ($r.encoding) { $L += ('- 源码编码：' + $r.encoding) }
    if ($r.fast) { $L += ('- 快检：' + [string]$r.fast.seconds + ' 秒，命令 `' + $r.fast.cmd + '`' + $(if ($r.fast.errors) { '；这次有 ' + [string]$r.fast.errors + ' 个错误：' + $r.fast.firstError } elseif ($r.fast.exitCode -ne 0) { '；这次没过：' + $r.fast.firstError } else { '' }) + $(if ($r.fast.log) { '（全文见 ' + $r.fast.log + '）' } else { '' })) }
    if ($r.typecheck) { $L += ('- 全量类型检查：' + [string]$r.typecheck.seconds + ' 秒，命令 `' + $r.typecheck.cmd + '`' + $(if ($r.typecheck.exitCode -ne 0) { '；这次没过：' + $r.typecheck.firstError } else { '' })) }
    if ($r.prep) { $L += ('- 快检要先导一次 classpath：' + [string]$r.prep.seconds + ' 秒，之后可以缓存复用') }
    if ($r.full) { $L += ('- 全量：' + [string]$r.full.seconds + ' 秒' + $(if ($r.full.exitCode -ne 0) { '，没过：' + $r.full.firstError } else { '' }) + $(if ($r.full.log) { '（全文见 ' + $r.full.log + '）' } else { '' })) }
    if ($r.run) { $L += ('- 启动验证：' + $(if ($r.run.ok) { [string]$r.run.seconds + ' 秒后 ' + $r.run.url + ' 返回 200' } else { '没等到（' + [string]$r.run.seconds + ' 秒）：' + $r.run.note })) }
    foreach ($n in $r.notes) { $L += ('- 备注：' + $n) }
    if ($r.recipe.Keys.Count) {
        $L += '- 这个项目的命令配方：'
        foreach ($k in $r.recipe.Keys) { $L += ('  - ' + $k + '：`' + $r.recipe[$k] + '`') }
    }
    $L += ''
}
$L += '## 怎么用这份报告'
$L += ''
$L += '- 快检在 5 秒以内的项目，可以把"改完就跑一次快检"写成硬规矩，模型每改一处都会自己验证。'
$L += '- 快检超过 10 秒的，改成"做完一小块跑一次"，别指望每次编辑都跑。'
$L += '- 全量编译只在收尾跑一次。'
$L += '- 每个项目的命令配方，后面会落成项目里的一个小配置文件，模型照着用，不用每次自己猜。'
$rp = Join-Path $outDir '项目体检报告.md'
Write-TextFile -Path $rp -Text ($L -join "`n")
Write-TextFile -Path (Join-Path $outDir 'profile.json') -Text (ConvertTo-Json -InputObject @($rows | ForEach-Object { $x = [ordered]@{}; foreach ($k in $_.Keys) { $x[$k] = $_[$k] }; foreach ($k in @('full', 'fast', 'prep', 'prep2', 'typecheck')) { if ($x[$k] -and $x[$k].Contains('text')) { $x[$k].Remove('text') } }; $x }) -Depth 8)
$L += ('- 每一步的原始输出在 ' + $outDir + ' 下的 *.log 里，报告里只放了第一行错误。')
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('项目体检报告-' + $ts + '.md'); Copy-Item $rp $desk -Force } catch { $desk = '' }
Write-Host ''
Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
