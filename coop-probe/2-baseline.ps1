# 2-baseline.ps1 —— 地基测量：首字时延与提示缓存、中文编码链路、真实项目的反馈回路时延
# 三段互相隔离：任何一段出错只记下来并跳过，不影响其他段，也不会中断后面的模型测试。
# 所有外部程序一律经 Invoke-Native 调用。直接用 & exe 2>&1 的写法在内网实测崩过：
# javac 往 stderr 写了一行，PowerShell 5.1 把它当成致命错误，整轮体检当场退出。
# 参数：
#   -JavaProject <路径>  在真实项目上量"改完一处要等多久才知道对不对"
#   -BuildCmd "<命令>"   自己指定构建命令；不给就按 pom.xml / package.json / 没有 pom 的老式 Java 工程自动认
#   -TomcatHome <路径>   老工程编译要用 Tomcat 自带的 servlet-api，自动找不到时用它指定
#   -Only feedback       只跑其中几段：latency / encoding / feedback，逗号隔开
#   -AskProject          没给 -JavaProject 时当场询问（双击 bat 时用）
param([string]$JavaProject = '', [string]$BuildCmd = '', [string]$TomcatHome = '', [string]$Only = '', [switch]$AskProject)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
. (Join-Path $PSScriptRoot 'tools\legacy-build.ps1')
$root = Get-ProbeRoot
$standalone = -not $env:PROBE_RESULT_DIR
$out = New-ResultDir 'baseline'
$node = Resolve-NodeExe
$result = [ordered]@{}
$want = @('latency', 'encoding', 'feedback')
if ($Only) { $want = @($Only -split '[,\s]+' | Where-Object { $_ }) }
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($want -contains 'feedback' -and -not $JavaProject -and $AskProject) {
    Write-Host ''
    Write-Host '量一下真实项目"改完一处要等多久才知道对不对"。没有 pom 的老工程也行：自动认出源码、jar 和 Tomcat，只往临时目录编译，不动项目本身。' -ForegroundColor Cyan
    $JavaProject = ([string](Read-Host '项目目录（可以把文件夹拖进这个窗口；直接回车跳过）')).Trim().Trim('"')
}

# ---------- 1. 首字时延与提示缓存 ----------
if ($want -contains 'latency') {
    Write-Step '首字时延与提示缓存'
    try {
        if (-not $node) { Write-Bad '没有 Node，跳过' }
        else {
            & $node (Join-Path $root 'tools\latency-probe.js') --out (Join-Path $out 'latency')
            $result.latency = Read-JsonFile (Join-Path $out 'latency\latency.json')
        }
    } catch { Write-Bad ('时延探测出错，已跳过：' + $_.Exception.Message); $result.latencyError = $_.Exception.Message }
}

# ---------- 2. 中文编码链路 ----------
# 真实痛点：Java 与 Maven 默认按系统编码 GBK 输出，模型那边按 UTF-8 读，中文报错到模型手里就是一片乱码，
# 表现为"模型看不懂错误"，实际是编码坏了。这里逐条量：哪条链路坏、加什么能修好、修法会不会伤到别的东西。
$marker = '中文错误信息：连接失败（达梦）'
# 只改 Java 的标准输出和标准错误编码，不动 file.encoding，所以不会影响源码读取和文件读写
$OUT_PROPS = '-Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8'
if ($want -contains 'encoding') {
Write-Step '中文编码链路'
$enc = [ordered]@{ cases = @(); recommend = @() }

function Add-EncCase {
    param([string]$Name, [string]$Group, $Run, [switch]$MarkerMode)
    $text = ([string]$Run.stdout) + ([string]$Run.stderr)
    $first = [string](@($text.Trim() -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^(Picked up|NOTE: Picked up)' }) | Select-Object -First 1)
    if ($Run.error) { $v = 'failed'; $first = '启动失败：' + $Run.error }
    elseif ($Run.timedOut) { $v = 'failed'; $first = '超时' }
    elseif ($MarkerMode) {
        if (($text -replace '\s', '').Contains(($marker -replace '\s', ''))) { $v = 'intact' }
        elseif ((Get-CjkVerdict $text) -eq 'garbled') { $v = 'garbled' }
        else { $v = 'failed' }
    } else { $v = Get-CjkVerdict $text }
    $enc.cases += [ordered]@{ name = $Name; group = $Group; verdict = $v; exitCode = $Run.exitCode; sample = $first }
    switch ($v) {
        'intact'  { Write-Ok ($Name + '：中文完整') }
        'ascii'   { Write-Ok ($Name + '：输出是英文，不受编码影响') }
        'garbled' { Write-Bad ($Name + '：中文乱码 → ' + $first) }
        default   { Write-Warn2 ($Name + '：没拿到有效输出（退出码 ' + [string]$Run.exitCode + '）' + $(if ($first) { ' → ' + $first } else { '' })) }
    }
}

$wr = Get-AsciiWorkRoot
$scratch = Join-Path $(if ($wr) { $wr } else { $env:TEMP }) ('enc-' + [string]$PID)
try {
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null

    # Node：对照组，正常应当完整
    if ($node) {
        $js = Join-Path $scratch 'say.js'
        Write-TextFile -Path $js -Text ("process.stdout.write('" + $marker + "\n'); process.stderr.write('" + $marker + "\n');")
        Add-EncCase -Name 'Node 直接输出' -Group 'node' -Run (Invoke-Native -Exe $node -ArgLine ('"' + $js + '"') -TimeoutSec 60) -MarkerMode
    }

    # Java：优先用 JAVA_HOME（Maven 用的就是它），其次 PATH
    $javaExe = $null; $javacExe = $null
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { $javaExe = Join-Path $env:JAVA_HOME 'bin\java.exe' }
    if (-not $javaExe) { $c = Get-Command java.exe -ErrorAction SilentlyContinue; if ($c) { $javaExe = $c.Source } }
    $javacExe = Resolve-JavacExe

    if (-not $javaExe) {
        Write-Warn2 '没找到 java，跳过 Java 相关用例。内网有 Java 时这几条最关键'
        $enc.javaSkipped = $true
    } else {
        $ver = Invoke-Native -Exe $javaExe -ArgLine '-version' -TimeoutSec 30
        $enc.java = [ordered]@{ path = $javaExe; version = [string](@((([string]$ver.stderr) + ([string]$ver.stdout)) -split "`r?`n" | Where-Object { $_ -match 'version' }) | Select-Object -First 1) }
        Write-Info ('用的 Java：' + $javaExe + '  ' + $enc.java.version)

        # 随包带的探针是预编译好的 Java 6 字节码，源码只含 ASCII，目标机不需要 javac，也不存在"编译中文源码"这一步
        Copy-Item (Join-Path $root 'tools\javaprobe\Say.class') $scratch -Force
        $cp = '-cp "' + $scratch + '" Say'
        Add-EncCase -Name 'Java 程序输出（默认）' -Group 'java-default' -Run (Invoke-Native -Exe $javaExe -ArgLine $cp -TimeoutSec 60) -MarkerMode
        Add-EncCase -Name 'Java 程序输出（只加输出编码参数）' -Group 'java-outprops' -Run (Invoke-Native -Exe $javaExe -ArgLine ($OUT_PROPS + ' ' + $cp) -TimeoutSec 60) -MarkerMode
        Add-EncCase -Name 'Java 程序输出（加 file.encoding=UTF-8）' -Group 'java-fileenc' -Run (Invoke-Native -Exe $javaExe -ArgLine ('-Dfile.encoding=UTF-8 ' + $cp) -TimeoutSec 60) -MarkerMode
        Add-EncCase -Name 'Java 程序输出（用 JAVA_TOOL_OPTIONS 设输出编码）' -Group 'java-toolopts' -Run (Invoke-Native -Exe $javaExe -ArgLine $cp -ExtraEnv @{ JAVA_TOOL_OPTIONS = $OUT_PROPS } -TimeoutSec 60) -MarkerMode
    }

    # javac 报错信息：编译失败时模型读到的就是这个，是实际最要紧的一条。
    # 故意编译一个类型错误的文件（源码纯 ASCII），看中文诊断信息到模型手里是什么样
    if ($javacExe) {
        $bad = Join-Path $scratch 'Bad.java'
        Write-TextFile -Path $bad -Text 'public class Bad { void f() { int x = "s"; } }'
        $jc = '-d "' + $scratch + '" "' + $bad + '"'
        $jOut = (($OUT_PROPS -split ' ') | ForEach-Object { '-J' + $_ }) -join ' '
        Add-EncCase -Name 'javac 报错信息（默认）' -Group 'javac-default' -Run (Invoke-Native -Exe $javacExe -ArgLine $jc -TimeoutSec 120)
        Add-EncCase -Name 'javac 报错信息（只加输出编码参数）' -Group 'javac-outprops' -Run (Invoke-Native -Exe $javacExe -ArgLine ($jOut + ' ' + $jc) -TimeoutSec 120)
        Add-EncCase -Name 'javac 报错信息（加 file.encoding=UTF-8）' -Group 'javac-fileenc' -Run (Invoke-Native -Exe $javacExe -ArgLine ('-J-Dfile.encoding=UTF-8 ' + $jc) -TimeoutSec 120)
        Add-EncCase -Name 'javac 报错信息（改用英文提示）' -Group 'javac-en' -Run (Invoke-Native -Exe $javacExe -ArgLine ('-J-Duser.language=en -J-Duser.country=US ' + $jc) -TimeoutSec 120)
    } elseif ($javaExe) {
        Write-Warn2 '只有 java 没有 javac（装的是 JRE），跳过 javac 报错信息用例'
    }

    # Git Bash：Claude Code 的 Bash 工具走这条。按 Claude Code 的找法定位，避开 System32 里那个 WSL 的 bash
    $bashExe = $null
    if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path $env:CLAUDE_CODE_GIT_BASH_PATH)) { $bashExe = $env:CLAUDE_CODE_GIT_BASH_PATH }
    if (-not $bashExe) {
        $g = Resolve-GitExe
        if ($g) {
            $gr = Split-Path (Split-Path $g -Parent) -Parent
            foreach ($cand in @((Join-Path $gr 'bin\bash.exe'), (Join-Path (Split-Path $gr -Parent) 'bin\bash.exe'))) { if (Test-Path $cand) { $bashExe = $cand; break } }
        }
    }
    if (-not $bashExe) { foreach ($cand in @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe")) { if ($cand -and (Test-Path $cand)) { $bashExe = $cand; break } } }
    if ($bashExe) {
        $sh = Join-Path $scratch 'say.sh'
        Write-TextFile -Path $sh -Text ("#!/bin/sh`nprintf '%s\n' '" + $marker + "'`n")
        Add-EncCase -Name 'Git Bash 输出（Claude 的 Bash 工具走这条）' -Group 'bash' -Run (Invoke-Native -Exe $bashExe -ArgLine ('"' + $sh.Replace([string][char]92, '/') + '"') -TimeoutSec 60) -MarkerMode
    } else { Write-Warn2 '没找到 Git Bash，跳过' }
} catch {
    Write-Bad ('编码测试出错，已跳过剩余用例：' + $_.Exception.Message)
    $enc.error = $_.Exception.Message
} finally {
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

# 结论与修法：只推荐实测修好了的那个最小改动。
# 环境变量一律建议写进 ~/.claude/settings.json 的 env 段：只影响 Claude Code 启动的进程，IDE 里启动的 Tomcat 不受影响
$gv = @{}
foreach ($c in $enc.cases) { $gv[$c.group] = $c.verdict }
if ($gv['java-default'] -eq 'garbled') {
    if ($gv['java-toolopts'] -eq 'intact' -or $gv['java-outprops'] -eq 'intact') { $enc.recommend += ('Java 程序输出乱码（Tomcat 日志、程序打印的中文）：在 ~/.claude/settings.json 的 env 段加 JAVA_TOOL_OPTIONS = ' + $OUT_PROPS + '。只改输出编码，不影响源码和文件读写') }
    elseif ($gv['java-fileenc'] -eq 'intact') { $enc.recommend += 'Java 程序输出乱码，而且只有 -Dfile.encoding=UTF-8 能修好。它会改变 Java 的默认编码，GBK 源码的老工程会因此出问题，先在一个项目上试' }
    else { $enc.recommend += 'Java 程序输出乱码，试过的参数都没修好，需要单独排查' }
}
if ($gv['javac-default'] -eq 'garbled') {
    if ($gv['javac-en'] -eq 'ascii' -or $gv['javac-fileenc'] -eq 'intact') {
        $enc.recommend += 'javac 报错乱码，没有 Maven 的老工程：编译命令加 -J-Duser.language=en -J-Dfile.encoding=UTF-8，报错变英文并按 UTF-8 输出，报错里回显的中文源码行也不乱；源码编码用 -encoding 显式指定，不受影响。「量编译速度」生成的命令已经带上'
        $enc.recommend += 'Maven 工程：在 ~/.claude/settings.json 的 env 段加 MAVEN_OPTS = -Duser.language=en -Duser.country=US，报错改成英文'
    } elseif ($gv['javac-outprops'] -eq 'intact') { $enc.recommend += ('javac 报错乱码：编译命令加 ' + $jOut) }
}
$garbled = @($enc.cases | Where-Object { $_.verdict -eq 'garbled' })
$enc.verdict = $(if ($garbled.Count) { '有 ' + [string]$garbled.Count + ' 条链路的中文到模型手里是乱码' } elseif ($enc.cases.Count) { '中文都能完整到达模型' } else { '没有跑成任何用例' })
$result.encoding = $enc
Write-Info $enc.verdict
foreach ($rcm in $enc.recommend) { Write-Info ('修法：' + $rcm) }
}

# ---------- 3. 反馈回路时延 ----------
$GBK_RISK = 'Claude Code 读写文件只认 UTF-8（本机 2.1.258 和 2.1.260 实测，内网的 2.1.259 夹在中间）：用 Edit 改 GBK 文件里的一个数字，数字改对了，但整个文件的中文全部变成乱码写回磁盘，工具照常返回成功，没有任何提醒；用 Write 重写，整个文件被悄悄转成 UTF-8，GBK 工程再编译就读错。在这类工程上让 AI 改代码之前，要先加一道编码保护。'
if ($want -contains 'feedback') {
Write-Step '反馈回路时延（改完一处要等多久才知道对不对）'
$fb = [ordered]@{}
$bdir = ''
try {
    if (-not $JavaProject) {
        Write-Warn2 '没给项目目录，跳过。这一项必须在你的真实项目上量，否则"让模型自己验证"的设计都没有依据'
        Write-Info '双击「量编译速度（双击我）.bat」，把项目文件夹拖进窗口就行'
        $fb.skipped = $true
    } elseif (-not (Test-Path -LiteralPath $JavaProject)) {
        Write-Bad ('目录不存在：' + $JavaProject); $fb.error = '目录不存在：' + $JavaProject
    } else {
        $JavaProject = (Resolve-Path -LiteralPath $JavaProject).ProviderPath
        $fb.project = $JavaProject
        $cmd = $BuildCmd
        $kind = 'custom'
        if (-not $cmd) {
            if (Test-Path -LiteralPath (Join-Path $JavaProject 'pom.xml')) { $cmd = 'mvn -o -q clean compile'; $kind = 'maven' }
            elseif (Test-Path -LiteralPath (Join-Path $JavaProject 'package.json')) { $cmd = 'npm run build'; $kind = 'npm' }
            else { $kind = 'javac' }
        }
        $fb.kind = $kind

        if ($kind -eq 'javac') {
            # 没有 pom 的老工程：自己认结构，用 javac 直接编译到临时目录
            $javac = Resolve-JavacExe
            if (-not $javac) { throw '没找到 javac（装的是 JRE，或者没配 JAVA_HOME），老工程只能靠 javac 编译' }
            Write-Info '没有 pom.xml / package.json，按老式 Java 工程处理：自己认源码、jar 和 Tomcat，用 javac 直接编译'
            $plan = Get-JavaBuildPlan -Dir $JavaProject -TomcatHome $TomcatHome -BundledLib (Join-Path $root 'tools\javaprobe\lib')
            if (-not $plan.sourceCount) { throw '工程里没找到 .java 源码' }
            $ver = Invoke-Native -Exe $javac -ArgLine '-version' -TimeoutSec 30
            $jv = [string](@((([string]$ver.stderr) + ([string]$ver.stdout)).Trim() -split "`r?`n") | Select-Object -First 1)
            $rel = { param($p) if ($p.StartsWith($JavaProject)) { $r = $p.Substring($JavaProject.Length).TrimStart([char]92); if ($r) { $r } else { '工程根目录' } } else { $p } }
            $fb.javac = $javac + '（' + $jv + '）'
            $fb.layout = $plan.layout
            $fb.srcDirs = @($plan.srcDirs | ForEach-Object { & $rel $_ })
            $fb.sourceCount = $plan.sourceCount
            $fb.webRoot = $(if ($plan.webRoot) { & $rel $plan.webRoot } else { '' })
            $fb.jarCount = $plan.jarCount
            $fb.servletApi = $plan.servletApi
            $fb.tomcatHome = $plan.tomcatHome
            $fb.encoding = $plan.encoding
            $fb.encodingText = Get-EncodingText $plan.encoding
            $fb.declared = @($plan.declared)
            $fb.notes = @($plan.notes)
            $fb.gbkRisk = ($plan.encoding.verdict -eq 'gbk' -or $plan.encoding.verdict -eq 'mixed')
            Write-Info ('结构：' + $plan.layout)
            Write-Info ('源码：' + [string]$plan.sourceCount + ' 个 .java，在 ' + ($fb.srcDirs -join '、'))
            Write-Info ('源码编码：' + $fb.encodingText + $(if ($fb.declared.Count) { '；配置里写的是 ' + ($fb.declared -join '，') } else { '' }))
            Write-Info ('依赖：' + [string]$plan.jarCount + ' 个 jar；Servlet 接口：' + $plan.servletApi)
            Write-Info ('编译器：' + $fb.javac)
            foreach ($n in $plan.notes) { Write-Info ('备注：' + $n) }

            $wr = Get-AsciiWorkRoot
            $bdir = Join-Path $(if ($wr) { $wr } else { $env:TEMP }) ('build-' + [string]$PID)
            New-Item -ItemType Directory -Force -Path (Join-Path $bdir 'empty') | Out-Null
            $argFile = Join-Path $bdir 'javac.args'
            Write-JavacArgFile -Path $argFile -ClassPath $plan.jars -Sources $plan.sources
            $encName = $plan.encoding.javacEncoding
            $runs = @()
            $lastText = ''
            foreach ($i in 1, 2) {
                $r = Invoke-Javac -Javac $javac -ArgFile $argFile -OutDir (Join-Path $bdir ('classes-' + $i)) -Encoding $encName
                Write-TextFile -Path (Join-Path $out ('build-' + $i + '.log')) -Text $r.text
                $dg = Get-JavacDiagnosis $r.text
                $runs += [ordered]@{ run = $i; seconds = $r.seconds; exitCode = $r.exitCode; timedOut = $r.timedOut; errors = $dg.errors; firstLine = $r.firstLine; outputLines = @($r.text -split "`n").Count }
                $lastText = $r.text
                $msg = '整体编译第 ' + [string]$i + ' 次：' + [string]$r.seconds + ' 秒，' + $(if ($r.timedOut) { '超时被终止' } elseif ($r.exitCode -eq 0) { '通过' } elseif ($dg.errors) { '有 ' + [string]$dg.errors + ' 个错误' } else { '失败：' + $r.firstLine })
                if ($r.exitCode -eq 0) { Write-Ok $msg } else { Write-Warn2 $msg }
            }
            if (($runs | Where-Object { $_.exitCode -ne 0 -and -not $_.errors }).Count) { $fb.failLine = $runs[0].firstLine }
            $fb.runs = $runs
            $diag = Get-JavacDiagnosis $lastText
            $fb.errors = $diag.errors
            $fb.missingPackages = @($diag.missingPackages)
            $fb.missingSymbols = @($diag.missingSymbols)
            $fb.hints = @($diag.hints)
            $fb.outputVerdict = Get-CjkVerdict $lastText

            # 只编译最近改过的那一个文件，依赖从刚编译好的类和 jar 里找：模拟模型改完一处后的快速检查。
            # 这一步单独兜住，出错不影响上面整体编译的数据
            try {
                $one = [string](@($plan.sources | Sort-Object { [IO.File]::GetLastWriteTimeUtc($_) } -Descending) | Select-Object -First 1)
                $argOne = Join-Path $bdir 'javac-one.args'
                Write-JavacArgFile -Path $argOne -ClassPath (@((Join-Path $bdir 'classes-1')) + @($plan.jars)) -Sources @($one)
                $r1 = Invoke-Javac -Javac $javac -ArgFile $argOne -OutDir (Join-Path $bdir 'classes-one') -Encoding $encName -TimeoutSec 300
                Write-TextFile -Path (Join-Path $out 'build-one.log') -Text $r1.text
                $d1 = Get-JavacDiagnosis $r1.text
                $fb.oneFile = & $rel $one
                $fb.oneSeconds = $r1.seconds
                $fb.oneErrors = $d1.errors
                Write-Ok ('只编译最近改过的一个文件（' + $fb.oneFile + '）：' + [string]$r1.seconds + ' 秒' + $(if ($d1.errors) { '，' + [string]$d1.errors + ' 个错误' } else { '' }))
            } catch { Write-Warn2 ('只编译一个文件这一步出错：' + $_.Exception.Message); $fb.oneError = $_.Exception.Message }

            $okRuns = @($runs | Where-Object { -not $_.timedOut } | ForEach-Object { $_.seconds })
            if ($okRuns.Count) {
                $best = ($okRuns | Measure-Object -Minimum).Minimum
                $fb.bestSeconds = $best
                $v1 = $(if ($null -eq $fb.oneSeconds) { '' } elseif ($fb.oneSeconds -le 5) { '只编译改动的文件要 ' + [string]$fb.oneSeconds + ' 秒，模型每改一处都可以自己编译检查一遍；' } else { '只编译一个文件也要 ' + [string]$fb.oneSeconds + ' 秒，大头是启动编译器和读 jar；' })
                $v2 = $(if ($best -le 30) { '整体编译 ' + [string]$best + ' 秒，做完一块跑一次整体编译' } else { '整体编译要 ' + [string]$best + ' 秒，只在收尾时跑，平时靠只编译改动的文件' })
                $fb.verdict = $v1 + $v2 + '。'
                Write-Info $fb.verdict
            }
            if ($diag.errors) {
                $why = $(if (@($fb.missingPackages).Count -or @($fb.missingSymbols).Count) { '错误多半是 classpath 不全，下面是缺的东西' } elseif ($diag.encodingErrors) { '错误来自源码编码不一致，不是代码本身的问题' } else { '具体看结果目录里的 build-1.log' })
                Write-Warn2 ('编译有 ' + [string]$diag.errors + ' 个错误，时间数据照样有效；' + $why)
                if ($fb.missingPackages.Count) { Write-Info ('缺的包：' + ($fb.missingPackages -join '，')) }
                if ($fb.missingSymbols.Count) { Write-Info ('找不到的类：' + ($fb.missingSymbols -join '，')) }
                foreach ($h in $fb.hints) { Write-Info ('提示：' + $h) }
            }
            if ($fb.gbkRisk) { Write-Bad ('这个工程的源码是 ' + $(if ($plan.encoding.verdict -eq 'mixed') { 'GBK 和 UTF-8 混用' } else { 'GBK' }) + '。' + $GBK_RISK) }

            # 这次用的编译命令留一份，以后可以直接交给模型用（内容只含英文，避免 cmd 读中文出错）
            $keep = Join-Path $out 'javac-build'
            New-Item -ItemType Directory -Force -Path $keep | Out-Null
            Copy-Item $argFile (Join-Path $keep 'javac.args') -Force
            $cmdText = '@echo off' + "`r`n" + 'rem compile check only: classes go to %TEMP%\javac-check-classes, the project itself is not touched' + "`r`n" +
                'if not exist "%TEMP%\javac-check-classes" mkdir "%TEMP%\javac-check-classes"' + "`r`n" +
                '"' + $javac + '" -J-Duser.language=en -J-Duser.country=US -J-Dfile.encoding=UTF-8 -encoding ' + $encName + ' -nowarn -g -d "%TEMP%\javac-check-classes" @"%~dp0javac.args"' + "`r`n"
            [IO.File]::WriteAllText((Join-Path $keep 'javac-build.cmd'), $cmdText, [Text.Encoding]::Default)
            $fb.buildScript = Join-Path $keep 'javac-build.cmd'
        } else {
            Write-Info ('在 ' + $JavaProject + ' 执行：' + $cmd)
            $fb.cmd = $cmd
            $runs = @()
            foreach ($i in 1, 2) {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $r = Invoke-Native -Exe 'cmd.exe' -ArgLine ('/s /c "' + $cmd + '"') -WorkDir $JavaProject -TimeoutSec 900
                $sw.Stop()
                $text = ([string]$r.stdout) + ([string]$r.stderr)
                Write-TextFile -Path (Join-Path $out ('build-' + $i + '.log')) -Text $text
                $lines = @($text -split "`n").Count
                $ov = Get-CjkVerdict $text
                $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                $runs += [ordered]@{ run = $i; seconds = $secs; exitCode = $r.exitCode; timedOut = $r.timedOut; outputLines = $lines; outputVerdict = $ov }
                Write-Ok ('第 ' + [string]$i + ' 次：' + [string]$secs + ' 秒，退出码 ' + [string]$r.exitCode + '，输出 ' + [string]$lines + ' 行' + $(if ($r.timedOut) { '，超时被终止' } else { '' }))
            }
            $fb.runs = $runs
            $okRuns = @($runs | Where-Object { -not $_.timedOut } | ForEach-Object { $_.seconds })
            if ($okRuns.Count) {
                $best = ($okRuns | Measure-Object -Minimum).Minimum
                $fb.bestSeconds = $best
                $fb.verdict = $(if ($best -le 10) { '反馈很快，可以每一步都跑，设成硬闸门' } elseif ($best -le 45) { '反馈可接受，适合每完成一小块跑一次，不适合每次编辑都跑' } else { '反馈太慢，模型不会主动跑，需要一条更快的语法级通道（比如只编译改动的那几个文件），否则"让它自己验证"必然落空' })
                Write-Info $fb.verdict
            }
            $maxLines = ($runs | ForEach-Object { $_.outputLines } | Measure-Object -Maximum).Maximum
            if ($maxLines -gt 200) { Write-Warn2 ('构建输出 ' + [string]$maxLines + ' 行，直接给模型是纯噪声，需要一个只留 ERROR 及其文件行号的包装脚本') }
            $fb.outputVerdict = $runs[0].outputVerdict
            switch ($fb.outputVerdict) {
                'garbled' { Write-Bad '构建输出里的中文到模型手里是乱码，编译报错它会看不懂，修法见编码一节' }
                'intact'  { Write-Ok '构建输出里的中文完整' }
                'ascii'   { Write-Info '构建输出全是英文，这次看不出编码问题（编译失败时的中文报错另见编码一节的 javac 用例）' }
            }
        }
    }
} catch { Write-Bad ('反馈回路测量出错，已跳过：' + $_.Exception.Message); $fb.error = $_.Exception.Message }
finally { if ($bdir) { Remove-Item -LiteralPath $bdir -Recurse -Force -ErrorAction SilentlyContinue } }
$result.feedback = $fb
}

Write-TextFile -Path (Join-Path $out 'baseline.json') -Text ($result | ConvertTo-Json -Depth 8)

# ---------- 报告片段：体检总报告直接嵌进去；单独运行时另存一份到桌面 ----------
$M = New-Object System.Collections.Generic.List[string]
if ($want -contains 'latency') {
    $lat = $result.latency
    if ($lat -and $lat.rows) {
        $M.Add('**首字时延与提示缓存**'); $M.Add('')
        $M.Add('| 上下文字符 | 第几次 | 首个文本 ms | 总耗时 ms | 状态 |'); $M.Add('|---|---|---|---|---|')
        foreach ($row in @($lat.rows)) { $M.Add('| ' + [string]$row.size + ' | ' + [string]$row.run + ' | ' + $(if ($null -eq $row.ttftMs) { '-' } else { [string]$row.ttftMs }) + ' | ' + $(if ($null -eq $row.totalMs) { '-' } else { [string]$row.totalMs }) + ' | ' + $(if ($row.status -eq 200) { 'OK' } else { [string]$row.status }) + ' |') }
        $M.Add('')
        foreach ($n in @($lat.notes)) { $M.Add('- ' + $n) }
        $M.Add('')
    } else { $M.Add('**首字时延与提示缓存**：没测成' + $(if ($result.latencyError) { '（' + $result.latencyError + '）' } else { '' })); $M.Add('') }
}
if ($want -contains 'encoding' -and $result.encoding) {
    $e = $result.encoding
    $M.Add('**中文编码链路**：' + $e.verdict); $M.Add('')
    foreach ($c in @($e.cases)) {
        $t = switch ([string]$c.verdict) { 'intact' { '完整' } 'ascii' { '输出是英文，不受编码影响' } 'garbled' { '乱码，实际拿到 ' + $c.sample } default { '没拿到有效输出' + $(if ($c.sample) { '（' + $c.sample + '）' } else { '' }) } }
        $M.Add('- ' + $c.name + '：' + $t)
    }
    if (@($e.recommend).Count) { $M.Add(''); $M.Add('修法：'); $M.Add(''); foreach ($r in @($e.recommend)) { $M.Add('- ' + $r) } }
    $M.Add('')
}
if ($want -contains 'feedback') {
    $f = $result.feedback
    if ($f.skipped) { $M.Add('**反馈回路时延**：本次跳过。这一项要在真实项目上量：双击「量编译速度（双击我）.bat」，把项目文件夹拖进窗口。') }
    elseif ($f.kind -eq 'javac') {
        $M.Add('**反馈回路时延**：' + $(if ($f.verdict) { $f.verdict } elseif ($f.error) { '没测完（' + $f.error + '）' } else { '没测完' })); $M.Add('')
        $M.Add('- 工程：' + $f.project + $(if ($f.layout) { '（' + $f.layout + '）' } else { '' }))
        if ($f.layout) {
            $M.Add('- 源码：' + [string]$f.sourceCount + ' 个 .java，在 ' + ($f.srcDirs -join '、'))
            $M.Add('- 源码编码：' + $f.encodingText + $(if (@($f.declared).Count) { '；工程配置里写的是 ' + ($f.declared -join '，') } else { '' }))
            $M.Add('- 依赖：' + [string]$f.jarCount + ' 个 jar；Servlet 接口：' + $f.servletApi)
            $M.Add('- 编译器：' + $f.javac)
        }
        if (@($f.runs).Count) { $M.Add('- 整体编译：' + ((@($f.runs) | ForEach-Object { '第 ' + [string]$_.run + ' 次 ' + [string]$_.seconds + ' 秒' }) -join '，') + '；错误 ' + [string]$f.errors + ' 个' + $(if ($f.failLine) { '；javac 报：' + $f.failLine } else { '' })) }
        if ($null -ne $f.oneSeconds) { $M.Add('- 只编译最近改过的一个文件（' + $f.oneFile + '）：' + [string]$f.oneSeconds + ' 秒' + $(if ($f.oneErrors) { '，错误 ' + [string]$f.oneErrors + ' 个' } else { '' })) }
        elseif ($f.oneError) { $M.Add('- 只编译一个文件这一步出错：' + $f.oneError) }
        if (@($f.missingPackages).Count) { $M.Add('- 缺的包：' + ($f.missingPackages -join '，')) }
        if (@($f.missingSymbols).Count) { $M.Add('- 找不到的类：' + ($f.missingSymbols -join '，')) }
        foreach ($h in @($f.hints)) { $M.Add('- 提示：' + $h) }
        foreach ($n in @($f.notes)) { $M.Add('- 备注：' + $n) }
        if ($f.buildScript) { $M.Add('- 这次用的编译命令存在 ' + $f.buildScript + '，以后可以直接交给模型做编译检查') }
        if ($f.gbkRisk) { $M.Add(''); $M.Add('**注意编码**：这个工程的源码是 ' + $(if ($f.encoding.verdict -eq 'mixed') { 'GBK 和 UTF-8 混用' } else { 'GBK' }) + '。' + $GBK_RISK) }
    }
    elseif ($f.bestSeconds) { $M.Add('**反馈回路时延**：' + $f.cmd + ' 最快 ' + [string]$f.bestSeconds + ' 秒。' + $f.verdict) }
    else { $M.Add('**反馈回路时延**：没测出（' + $f.error + '）') }
    $M.Add('')
}
Write-TextFile -Path (Join-Path $out 'baseline.md') -Text ($M -join "`n")
Write-Info ('地基测量结果：' + (Join-Path $out 'baseline.json'))

if ($standalone) {
    $title = $(if ($want.Count -eq 1 -and $want[0] -eq 'feedback') { '编译速度报告' } else { '地基测量报告' })
    $H = @(('# ' + $title + ' ' + $ts), '', ('- 结果目录：' + $out), '')
    $rp = Join-Path $out ($title + '.md')
    Write-TextFile -Path $rp -Text ((@($H) + @($M)) -join "`n")
    Write-Host ''
    Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
    try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($title + '-' + $ts + '.md'); Copy-Item $rp $desk -Force; Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan } catch { }
}
