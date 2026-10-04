# legacy-build.ps1 —— 没有 pom 的老 Java Web 工程：认结构、判编码、拼 classpath，用 javac 直接编译
# 这类工程靠 IDE 里配的 Tomcat 启动，没有命令行构建方式。这里按 Eclipse / MyEclipse / IDEA 的常见布局，
# 把"源码在哪、jar 在哪、Tomcat 在哪、源码什么编码"认出来，拼成一条 javac 命令。
# 只往临时目录编译，不碰工程本身。由 2-baseline.ps1 与 encoding-census.ps1 以 . 号引入（先引入 common.ps1）。

$script:SkipDirNames = @('.git', '.svn', '.idea', '.settings', '.metadata', '.gradle', '.mvn', 'target', 'bin', 'build', 'out', 'classes', 'node_modules', 'dist', 'bower_components')

# 递归列文件，跳过版本库、编译输出、node_modules 这类目录，也不钻符号链接
function Get-FilesSkipping {
    param([string]$Root, [string[]]$Patterns = @('*.java'), [int]$Max = 20000)
    $res = New-Object System.Collections.Generic.List[string]
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return @() }
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push((Resolve-Path -LiteralPath $Root).ProviderPath)
    while ($stack.Count -gt 0 -and $res.Count -lt $Max) {
        $d = $stack.Pop()
        foreach ($p in $Patterns) { try { foreach ($f in [IO.Directory]::GetFiles($d, $p)) { $res.Add($f) } } catch { } }
        try {
            foreach ($sd in [IO.Directory]::GetDirectories($d)) {
                if ($script:SkipDirNames -contains [IO.Path]::GetFileName($sd)) { continue }
                try { if (([IO.File]::GetAttributes($sd) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue } } catch { continue }
                $stack.Push($sd)
            }
        } catch { }
    }
    # 不能写成 return ,$arr：调用方都用 @(...) 收集，多包一层会让整个数组变成一个元素
    return $res.ToArray()
}

# 按文件内容判断编码：先严格按 UTF-8 解，解不开再严格按 GBK 解。
# 不看配置文件怎么写，配置常常和实际不一致；配置另外读出来作参考。
function Get-SourceEncoding {
    param([string[]]$Files, [int]$MaxFiles = 5000)
    $u8 = New-Object System.Text.UTF8Encoding($false, $true)
    $gbk = [System.Text.Encoding]::GetEncoding(936, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
    $st = [ordered]@{ verdict = 'ascii'; javacEncoding = 'UTF-8'; checked = 0; ascii = 0; utf8 = 0; utf8Bom = 0; gbk = 0; unknown = 0; gbkTypes = @(); gbkSamples = @(); utf8Samples = @(); unknownSamples = @() }
    $gbkTypes = @{}
    foreach ($f in @($Files | Select-Object -First $MaxFiles)) {
        $b = $null
        try { $b = [IO.File]::ReadAllBytes($f) } catch { continue }
        $st.checked++
        $s = $null
        try { $s = $u8.GetString($b) } catch { $s = $null }
        if ($null -ne $s) {
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $st.utf8Bom++; $st.utf8++; if ($st.utf8Samples.Count -lt 3) { $st.utf8Samples += $f } }
            elseif ($s -match '[^\x00-\x7F]') { $st.utf8++; if ($st.utf8Samples.Count -lt 3) { $st.utf8Samples += $f } }
            else { $st.ascii++ }
            continue
        }
        $ok = $true
        try { [void]$gbk.GetString($b) } catch { $ok = $false }
        if ($ok) {
            $st.gbk++
            if ($st.gbkSamples.Count -lt 3) { $st.gbkSamples += $f }
            $gbkTypes[[IO.Path]::GetExtension($f).ToLower()] = 1
        } else { $st.unknown++; if ($st.unknownSamples.Count -lt 3) { $st.unknownSamples += $f } }
    }
    $st.gbkTypes = @($gbkTypes.Keys | Sort-Object)
    if ($st.gbk -gt 0 -and $st.utf8 -gt 0) { $st.verdict = 'mixed' }
    elseif ($st.gbk -gt 0) { $st.verdict = 'gbk' }
    elseif ($st.utf8 -gt 0) { $st.verdict = 'utf8' }
    $st.javacEncoding = $(if ($st.gbk -gt $st.utf8) { 'GBK' } else { 'UTF-8' })
    return $st
}

function Get-EncodingText {
    param($E)
    $n = '（按内容逐个判断了 ' + [string]$E.checked + ' 个文件：GBK ' + [string]$E.gbk + ' 个，UTF-8 ' + [string]$E.utf8 + ' 个，纯英文 ' + [string]$E.ascii + ' 个' + $(if ($E.unknown) { '，两种都解不开 ' + [string]$E.unknown + ' 个' } else { '' }) + '）'
    switch ([string]$E.verdict) {
        'gbk'   { return ('GBK' + $n) }
        'utf8'  { return ('UTF-8' + $n) }
        'mixed' { return ('GBK 和 UTF-8 混着用' + $n) }
        default { return ('没有中文，编码不影响' + $n) }
    }
}

# 工程配置里声明的编码，只作参考
function Get-DeclaredEncoding {
    param([string]$Dir)
    $hints = @()
    $p = Join-Path $Dir '.settings\org.eclipse.core.resources.prefs'
    if (Test-Path -LiteralPath $p) {
        foreach ($line in [IO.File]::ReadAllLines($p)) {
            if ($line -match '^encoding/(.*)=(.+)$') { $hints += ('Eclipse ' + $(if ($matches[1] -eq '<project>') { '工程' } else { $matches[1] }) + ' = ' + $matches[2].Trim()) }
        }
    }
    $p = Join-Path $Dir '.idea\encodings.xml'
    if (Test-Path -LiteralPath $p) {
        $x = [IO.File]::ReadAllText($p)
        foreach ($m in [regex]::Matches($x, '<file url="([^"]*)" charset="([^"]+)"')) { $hints += ('IDEA ' + $m.Groups[1].Value.Replace('file://$PROJECT_DIR$', '') + ' = ' + $m.Groups[2].Value) }
    }
    return $hints
}

# 工程自己的 lib 里也可能放着 servlet-api.jar，所以还要有 Tomcat 自己的 catalina.jar 或 bootstrap.jar 才算
function Test-TomcatHome {
    param([string]$D)
    if (-not $D -or -not (Test-Path -LiteralPath (Join-Path $D 'lib\servlet-api.jar'))) { return $false }
    return [bool]((Test-Path -LiteralPath (Join-Path $D 'lib\catalina.jar')) -or (Test-Path -LiteralPath (Join-Path $D 'bin\bootstrap.jar')))
}

# 在一段文字里找 Windows 路径，看它本身或它的上两级是不是 Tomcat 目录
function Find-TomcatInText {
    param([string]$Text)
    foreach ($m in [regex]::Matches($Text, '[A-Za-z]:[/\x5C][^"<>|?*\r\n=;]+')) {
        $d = $m.Value.Replace('/', [string][char]92).TrimEnd([char]92)
        $d = ($d -replace '(?i)\x5Clib\x5C[^\x5C]+\.jar.*$', '')
        for ($i = 0; $i -lt 3 -and $d; $i++) {
            if (Test-TomcatHome $d) { return $d }
            $d = Split-Path $d -Parent
        }
    }
    return ''
}

# 找 Tomcat：参数 → 环境变量 → IDEA 全局配置 → Eclipse 工作空间配置 → 各盘符下浅找一遍
function Find-TomcatHome {
    param([string]$ProjectDir, [string]$Given = '')
    if ($Given) { if (Test-TomcatHome $Given) { return @{ home = $Given; from = '参数指定' } } }
    foreach ($v in @('CATALINA_HOME', 'CATALINA_BASE', 'TOMCAT_HOME')) {
        $d = [Environment]::GetEnvironmentVariable($v)
        if (Test-TomcatHome $d) { return @{ home = $d; from = ('环境变量 ' + $v) } }
    }
    # IDEA 把配过的应用服务器记在全局配置里，文件名各版本不一样，所以把 options 下的 xml 都扫一遍
    $xmlDirs = @()
    if ($env:APPDATA -and (Test-Path -LiteralPath (Join-Path $env:APPDATA 'JetBrains'))) {
        $xmlDirs += @(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'JetBrains') -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'options' })
    }
    $xmlDirs += @(Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\.(IntelliJIdea|IdeaIC)' } | ForEach-Object { Join-Path $_.FullName 'config\options' })
    foreach ($xd in $xmlDirs) {
        if (-not (Test-Path -LiteralPath $xd)) { continue }
        foreach ($xf in @(Get-ChildItem -LiteralPath $xd -Filter *.xml -File -ErrorAction SilentlyContinue)) {
            $t = ''
            try { $t = [IO.File]::ReadAllText($xf.FullName) } catch { continue }
            if ($t -notmatch '(?i)tomcat|servlet-api') { continue }
            $d = Find-TomcatInText $t
            if ($d) { return @{ home = $d; from = ('IDEA 配置 ' + $xf.Name) } }
        }
    }
    # Eclipse / MyEclipse：工作空间一般是工程的上一级或上两级，服务器运行时记在 .metadata 里（路径里的冒号和反斜杠被转义过）
    $bs = [string][char]92
    $parent = Split-Path $ProjectDir -Parent
    foreach ($w in @($parent, $(if ($parent) { Split-Path $parent -Parent } else { '' })) | Where-Object { $_ }) {
        $sd = Join-Path $w '.metadata\.plugins\org.eclipse.core.runtime\.settings'
        if (-not (Test-Path -LiteralPath $sd)) { continue }
        foreach ($pf in @(Get-ChildItem -LiteralPath $sd -Filter *.prefs -File -ErrorAction SilentlyContinue)) {
            $t = ''
            try { $t = [IO.File]::ReadAllText($pf.FullName) } catch { continue }
            if ($t -notmatch '(?i)tomcat') { continue }
            $t = $t.Replace($bs + $bs, $bs).Replace($bs + ':', ':').Replace($bs + '=', '=')
            $d = Find-TomcatInText $t
            if ($d) { return @{ home = $d; from = ('Eclipse 工作空间配置 ' + $pf.Name) } }
        }
    }
    # 最后在各个盘符下浅找：一级目录，和名字像软件目录的二级、三级目录，最多 15 秒
    $sw = [Diagnostics.Stopwatch]::StartNew()
    foreach ($drv in @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady })) {
        $l1 = @(); try { $l1 = [IO.Directory]::GetDirectories($drv.RootDirectory.FullName) } catch { }
        foreach ($d1 in $l1) {
            if ($sw.Elapsed.TotalSeconds -gt 15) { return @{ home = ''; from = '' } }
            $n1 = [IO.Path]::GetFileName($d1)
            if ($n1 -match '(?i)tomcat' -and (Test-TomcatHome $d1)) { return @{ home = $d1; from = '磁盘上找到的' } }
            if ($n1 -match '(?i)^(Windows|\$Recycle\.Bin|System Volume Information|Recovery|PerfLogs|ProgramData|Users|Documents and Settings)$') { continue }
            $l2 = @(); try { $l2 = [IO.Directory]::GetDirectories($d1) } catch { }
            foreach ($d2 in $l2) {
                $n2 = [IO.Path]::GetFileName($d2)
                if ($n2 -match '(?i)tomcat' -and (Test-TomcatHome $d2)) { return @{ home = $d2; from = '磁盘上找到的' } }
                if ($n2 -match '(?i)apache|server|soft|tool|env|dev|java|web|program|middleware') {
                    $l3 = @(); try { $l3 = [IO.Directory]::GetDirectories($d2) } catch { }
                    foreach ($d3 in $l3) { if ([IO.Path]::GetFileName($d3) -match '(?i)tomcat' -and (Test-TomcatHome $d3)) { return @{ home = $d3; from = '磁盘上找到的' } } }
                }
            }
        }
    }
    return @{ home = ''; from = '' }
}

function Add-Unique { param($List, [string]$Item) if ($Item -and -not ($List -contains $Item)) { [void]$List.Add($Item) } }

# 认出工程结构，给出 javac 需要的全部输入
function Get-JavaBuildPlan {
    param([string]$Dir, [string]$TomcatHome = '', [string]$BundledLib = '')
    $Dir = (Resolve-Path -LiteralPath $Dir).ProviderPath
    $plan = [ordered]@{ projectDir = $Dir; layout = ''; srcDirs = @(); sourceCount = 0; webRoot = ''; libDirs = @(); jars = @(); jarCount = 0; tomcatHome = ''; tomcatFrom = ''; servletApi = ''; encoding = $null; declared = @(); notes = @() }
    $srcDirs = New-Object System.Collections.ArrayList
    $libDirs = New-Object System.Collections.ArrayList
    $jars = New-Object System.Collections.ArrayList
    $layout = @()

    # Eclipse / MyEclipse：.classpath 里写着源码目录和额外的 jar
    $cpFile = Join-Path $Dir '.classpath'
    if (Test-Path -LiteralPath $cpFile) {
        $layout += 'Eclipse/MyEclipse'
        $x = [IO.File]::ReadAllText($cpFile)
        foreach ($m in [regex]::Matches($x, '<classpathentry\b[^>]*>')) {
            $e = $m.Value
            $kind = ''; if ($e -match '\bkind="([^"]+)"') { $kind = $matches[1] }
            $path = ''; if ($e -match '\bpath="([^"]+)"') { $path = $matches[1] }
            if (-not $path) { continue }
            if ($kind -eq 'src') {
                if ($path.StartsWith('/')) { $plan.notes += ('依赖另一个 Eclipse 工程 ' + $path + '，它的类这里编译不到'); continue }
                $full = Join-Path $Dir $path
                if (Test-Path -LiteralPath $full) { Add-Unique $srcDirs $full }
            } elseif ($kind -eq 'lib') {
                $full = $path
                if ($path.StartsWith('/')) { $full = Join-Path (Split-Path $Dir -Parent) $path.TrimStart('/') }
                elseif (-not [IO.Path]::IsPathRooted($path)) { $full = Join-Path $Dir $path }
                if (Test-Path -LiteralPath $full) { Add-Unique $jars $full }
            } elseif ($kind -eq 'con' -and $path -match '(?i)tomcat') { $plan.notes += ('Eclipse 里绑定的服务器运行时：' + ($path -replace '^.*/', '')) }
        }
    }

    # IDEA：.iml 里写着源码目录；jar 可能写在 .iml 里，也可能在 .idea\libraries 里
    foreach ($iml in @(Get-ChildItem -LiteralPath $Dir -Filter *.iml -File -ErrorAction SilentlyContinue)) {
        if (-not ($layout -contains 'IDEA')) { $layout += 'IDEA' }
        $x = [IO.File]::ReadAllText($iml.FullName)
        $md = $iml.DirectoryName
        foreach ($m in [regex]::Matches($x, '<sourceFolder url="file://\$MODULE_DIR\$/?([^"]*)"([^>]*)>')) {
            if ($m.Groups[2].Value -match 'isTestSource="true"|java-resource|java-test-resource') { continue }
            $full = $(if ($m.Groups[1].Value) { Join-Path $md $m.Groups[1].Value } else { $md })
            if (Test-Path -LiteralPath $full) { Add-Unique $srcDirs $full }
        }
        foreach ($m in [regex]::Matches($x, 'jar://\$MODULE_DIR\$/([^"!]+\.jar)!/')) { $j = Join-Path $md $m.Groups[1].Value; if (Test-Path -LiteralPath $j) { Add-Unique $jars $j } }
        foreach ($m in [regex]::Matches($x, '<jarDirectory url="file://\$MODULE_DIR\$/([^"]+)"')) { $d = Join-Path $md $m.Groups[1].Value; if (Test-Path -LiteralPath $d) { Add-Unique $libDirs $d } }
    }
    $ideaLib = Join-Path $Dir '.idea\libraries'
    if (Test-Path -LiteralPath $ideaLib) {
        foreach ($lf in @(Get-ChildItem -LiteralPath $ideaLib -Filter *.xml -File -ErrorAction SilentlyContinue)) {
            $x = [IO.File]::ReadAllText($lf.FullName)
            foreach ($m in [regex]::Matches($x, 'jar://\$PROJECT_DIR\$/([^"!]+\.jar)!/')) { $j = Join-Path $Dir $m.Groups[1].Value; if (Test-Path -LiteralPath $j) { Add-Unique $jars $j } }
            foreach ($m in [regex]::Matches($x, '(?:<root|<jarDirectory) url="file://\$PROJECT_DIR\$/([^"]+)"')) { $d = Join-Path $Dir $m.Groups[1].Value; if (Test-Path -LiteralPath $d) { Add-Unique $libDirs $d } }
        }
    }

    # 两种配置都没写源码目录，就按常见布局猜
    if (-not $srcDirs.Count) {
        foreach ($c in @('src\main\java', 'src', 'source', 'java')) { $full = Join-Path $Dir $c; if (Test-Path -LiteralPath $full) { Add-Unique $srcDirs $full; break } }
        if (-not $srcDirs.Count) { Add-Unique $srcDirs $Dir; $plan.notes += '没认出源码目录，按整个工程目录收集 .java' }
    }

    # Web 根目录：下面有 WEB-INF 的那个
    foreach ($c in @('WebRoot', 'WebContent', 'web', 'src\main\webapp', 'webapp', 'WebApp', 'public_html')) {
        $full = Join-Path $Dir $c
        if (Test-Path -LiteralPath (Join-Path $full 'WEB-INF')) { $plan.webRoot = $full; break }
    }
    if (-not $plan.webRoot) {
        $wi = @(Get-ChildItem -LiteralPath $Dir -Directory -Recurse -Depth 3 -Filter 'WEB-INF' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '(?i)\x5C(target|out|build|bin|node_modules)\x5C' } | Select-Object -First 1)
        if ($wi.Count) { $plan.webRoot = Split-Path $wi[0].FullName -Parent }
    }
    if ($plan.webRoot) {
        $layout += ('Web 根目录 ' + [IO.Path]::GetFileName($plan.webRoot))
        $wl = Join-Path $plan.webRoot 'WEB-INF\lib'
        if (Test-Path -LiteralPath $wl) { Add-Unique $libDirs $wl }
    }
    foreach ($c in @('lib', 'libs', 'jar', 'jars', 'WEB-INF\lib')) { $full = Join-Path $Dir $c; if (Test-Path -LiteralPath $full) { Add-Unique $libDirs $full } }

    # Tomcat 自带的 servlet-api 这类包，工程里一般没有，编译得靠它
    $tc = Find-TomcatHome -ProjectDir $Dir -Given $TomcatHome
    if ($tc.home) { $plan.tomcatHome = $tc.home; $plan.tomcatFrom = $tc.from; Add-Unique $libDirs (Join-Path $tc.home 'lib') }

    # 把目录展开成一个个 jar：不依赖 javac 对通配符的支持，各版本 JDK 行为一致
    $all = New-Object System.Collections.ArrayList
    foreach ($d in $libDirs) { foreach ($j in @(Get-ChildItem -LiteralPath $d -Filter *.jar -File -ErrorAction SilentlyContinue)) { Add-Unique $all $j.FullName } }
    foreach ($j in $jars) { Add-Unique $all $j }
    $hasServlet = @($all | Where-Object { [IO.Path]::GetFileName($_) -match '(?i)servlet-api|javaee|j2ee|geronimo-servlet' }).Count -gt 0
    if ($tc.home) { $plan.servletApi = 'Tomcat 自带（' + $tc.from + '：' + $tc.home + '）' }
    elseif ($hasServlet) { $plan.servletApi = '工程自带' }
    elseif ($BundledLib -and (Test-Path -LiteralPath $BundledLib)) {
        foreach ($j in @(Get-ChildItem -LiteralPath $BundledLib -Filter *.jar -File -ErrorAction SilentlyContinue)) { Add-Unique $all $j.FullName }
        $plan.servletApi = '没找到 Tomcat，用随包的 Servlet 3.1 / JSP / EL 接口包代替'
    } else { $plan.servletApi = '没有（没找到 Tomcat，编译会缺 javax.servlet）' }

    $sources = @()
    foreach ($sd in $srcDirs) { $sources += @(Get-FilesSkipping -Root $sd -Patterns @('*.java')) }
    $sources = @($sources | Select-Object -Unique)
    $plan.layout = $(if ($layout.Count) { $layout -join '，' } else { '普通 Java 源码目录' })
    $plan.srcDirs = @($srcDirs)
    $plan.sources = $sources
    $plan.sourceCount = $sources.Count
    $plan.libDirs = @($libDirs)
    $plan.jars = @($all)
    $plan.jarCount = $all.Count
    $plan.encoding = Get-SourceEncoding -Files $sources
    $plan.declared = Get-DeclaredEncoding -Dir $Dir
    return $plan
}

# 找 javac：JAVA_HOME 优先，其次 PATH
function Resolve-JavacExe {
    if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) { return (Join-Path $env:JAVA_HOME 'bin\javac.exe') }
    $c = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

# 写 javac 参数文件：路径一律正斜杠加引号。JDK 8 读参数文件时会把引号里的反斜杠当转义符，
# 读文件用的是 file.encoding，所以调用时固定加 -J-Dfile.encoding=UTF-8，参数文件按 UTF-8 写
function Write-JavacArgFile {
    param([string]$Path, [string[]]$ClassPath, [string[]]$Sources)
    $bs = [string][char]92
    $L = New-Object System.Collections.Generic.List[string]
    if ($ClassPath.Count) { $L.Add('-cp "' + ((@($ClassPath | ForEach-Object { $_.Replace($bs, '/') })) -join ';') + '"') }
    foreach ($s in $Sources) { $L.Add('"' + $s.Replace($bs, '/') + '"') }
    Write-TextFile -Path $Path -Text (($L.ToArray()) -join "`r`n")
}

# 跑一次 javac。报错信息固定成英文、按 UTF-8 输出：英文报错模型读得最准，
# 报错里回显的源码行带中文时也不会乱码；源码本身用 -encoding 显式指定，不受影响
function Invoke-Javac {
    param([string]$Javac, [string]$ArgFile, [string]$OutDir, [string]$Encoding, [int]$TimeoutSec = 900)
    if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $line = '-J-Duser.language=en -J-Duser.country=US -J-Dfile.encoding=UTF-8 -encoding ' + $Encoding + ' -nowarn -g -d "' + $OutDir + '" @"' + $ArgFile + '"'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Native -Exe $Javac -ArgLine $line -TimeoutSec $TimeoutSec
    $sw.Stop()
    $text = ([string]$r.stdout) + ([string]$r.stderr)
    $first = [string](@($text -split "`r?`n" | Where-Object { $_.Trim() -and $_ -notmatch '^(Picked up|NOTE: Picked up|Note:)' }) | Select-Object -First 1)
    if ($r.error) { $first = '启动 javac 失败：' + $r.error }
    return [ordered]@{ seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); exitCode = $r.exitCode; timedOut = $r.timedOut; error = $r.error; text = $text; firstLine = $first; line = $line }
}

# 从 javac 的英文输出里读出：多少个错误、缺哪些包、找不到哪些类、有没有编码问题
function Get-JavacDiagnosis {
    param([string]$Text)
    $d = [ordered]@{ errors = 0; missingPackages = @(); missingSymbols = @(); encodingErrors = 0; bomFiles = 0; hints = @() }
    $lines = @($Text -split "`r?`n")
    $pk = @{}; $sy = @{}
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $ln = $lines[$i]
        if ($ln -match '\.java:\d+: error: (.+)$') {
            $d.errors++
            $msg = $matches[1]
            if ($msg -match '^package (\S+) does not exist') {
                $p = (@($matches[1] -split '\.') | Select-Object -First 3) -join '.'
                $pk[$p] = 1 + [int]$pk[$p]
            } elseif ($msg -match '^cannot find symbol') {
                for ($k = $i + 1; $k -lt [Math]::Min($lines.Count, $i + 5); $k++) { if ($lines[$k] -match '^\s*symbol:\s+(class|interface)\s+(\S+)') { $sy[$matches[2]] = 1 + [int]$sy[$matches[2]]; break } }
            } elseif ($msg -match 'unmappable character') { $d.encodingErrors++ }
            elseif ($msg -match "illegal character: '\\ufeff'") { $d.bomFiles++ }
        } elseif ($ln -match '^(\d+) errors?$') { $d.errors = [Math]::Max($d.errors, [int]$matches[1]) }
    }
    $d.missingPackages = @($pk.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object { $_.Key + '（' + [string]$_.Value + ' 处）' })
    $d.missingSymbols = @($sy.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object { $_.Key + '（' + [string]$_.Value + ' 处）' })
    $pkText = ($pk.Keys -join ' ')
    $syText = ($sy.Keys -join ' ')
    if ($pkText -match 'javax\.servlet') { $d.hints += '缺 javax.servlet：Servlet 接口包没找到，用 -TomcatHome 指定 Tomcat 目录重跑' }
    # JDK 9 以后 sun.misc 包还在，只是 BASE64Encoder 这些类没了，报的是"找不到符号"而不是"包不存在"
    if ($pkText -match 'sun\.misc|com\.sun' -or $syText -match 'BASE64(En|De)coder' -or $Text -match 'location: package (sun|com\.sun)\.') { $d.hints += '用了 JDK 8 才有的内部类（sun.misc.BASE64Encoder 这类），要用 JDK 8 编译：先把 JAVA_HOME 指到 JDK 8 再跑' }
    if ($pkText -match 'org\.junit|org\.testng|org\.mockito') { $d.hints += '测试代码和主代码放在一起，缺测试框架的 jar，不影响主代码' }
    $others = @($pk.Keys | Where-Object { $_ -notmatch '^(javax\.servlet|sun\.|com\.sun|org\.junit|org\.testng|org\.mockito)' })
    if ($others.Count) { $d.hints += ('缺 ' + ($others -join '、') + ' 说明 classpath 不全：这些 jar 可能放在工程外的目录、别的工程，或者 IDE 的全局库里') }
    # 内网实测踩过：源码被透明加密软件加了密，javac.exe 不在放行名单里，读到的是密文，
    # 表现和"编码对不上"一模一样，但每个文件都错在第 1 行，回显里能看到加密软件的文件头
    if ($Text -match 'E-SafeNet') {
        $d.encrypted = $true
        $d.hints += 'javac 读到的是加密软件的密文（输出里有 E-SafeNet 文件头），不是编码问题。让 javac.exe 走放行策略之后重跑，这些错误会全部消失；时间数照样有效'
    }
    elseif ($d.encodingErrors) { $d.hints += ('有 ' + [string]$d.encodingErrors + ' 处编码对不上：GBK 和 UTF-8 混用的工程，一条 javac 命令只能按一种编码读；Eclipse 能编过，是因为它按文件记编码') }
    if ($d.bomFiles) { $d.hints += ('有 ' + [string]$d.bomFiles + ' 个文件开头带 BOM，javac 会报 illegal character，要把 BOM 去掉') }
    return $d
}
