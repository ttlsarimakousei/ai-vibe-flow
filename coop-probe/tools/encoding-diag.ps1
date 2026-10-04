# encoding-diag.ps1 —— 编码诊断：javac 说某个文件"unmappable character"，而扫描说它是好好的 UTF-8，到底谁对
#   对一个文件做五件事：
#     1. 看原始字节：大小、有没有 BOM、开头 48 个字节的十六进制
#     2. .NET 的严格 UTF-8 / GBK 解码各自过不过
#     3. 让 Java 自己的严格 UTF-8 解码器读这个文件，报出第一个失败的字节偏移、所在行、前后 16 个字节
#     4. 用这台机器的 javac 单独编译这个文件，原样打印前几行输出
#     5. 对照：现写一个第 1 行带中文的 UTF-8 小文件，同样编译一次；再看 JAVA_TOOL_OPTIONS 这类环境变量
#   对照通过而目标文件失败，问题在文件；对照也失败，问题在这台机器的 javac 或环境。
# 参数：-File <文件>  不给则询问（可以把文件拖进窗口）
param([string]$File = '')
foreach ($dep in @('common.ps1', 'legacy-build.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $dep))) { Write-Host ('缺少 ' + (Join-Path $PSScriptRoot $dep) + '。这个脚本不能单独用，把它放进 coop-probe\tools 目录再运行。') -ForegroundColor Red; return }
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'legacy-build.ps1')
$root = Get-ProbeRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host '编码诊断：这个文件到底是什么编码，javac 为什么不认' -ForegroundColor Cyan
if (-not $File) { $File = ([string](Read-Host '要诊断的文件（可以把文件拖进这个窗口）')).Trim().Trim('"') }
if (-not $File -or -not (Test-Path -LiteralPath $File)) { Write-Bad ('文件不存在：' + $File); return }
$File = (Resolve-Path -LiteralPath $File).ProviderPath
$L = @()
$L += ('# 编码诊断 ' + $ts)
$L += ''
$L += ('- 文件：' + $File)

# ---------- 1. 原始字节 ----------
$b = [IO.File]::ReadAllBytes($File)
$hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
$head = (@($b | Select-Object -First 48 | ForEach-Object { $_.ToString('X2') })) -join ' '
Write-Step '原始字节'
Write-Info ('大小 ' + [string]$b.Length + ' 字节；' + $(if ($hasBom) { '开头有 UTF-8 BOM（EF BB BF）' } else { '没有 BOM' }))
Write-Info ('开头 48 字节：' + $head)
$L += ('- 大小：' + [string]$b.Length + ' 字节；' + $(if ($hasBom) { '开头有 UTF-8 BOM' } else { '没有 BOM' }))
$L += ('- 开头 48 字节：`' + $head + '`')

# ---------- 2. .NET 严格解码 ----------
$u8s = New-Object System.Text.UTF8Encoding($false, $true)
$gbk = [System.Text.Encoding]::GetEncoding(936, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
$u8ok = $true; $u8text = $null
try { $u8text = $u8s.GetString($b) } catch { $u8ok = $false }
$gbkok = $true; $gbktext = $null
try { $gbktext = $gbk.GetString($b) } catch { $gbkok = $false }
Write-Step '.NET 的严格解码'
Write-Info ('按 UTF-8 严格解：' + $(if ($u8ok) { '通过' } else { '失败' }) + '；按 GBK 严格解：' + $(if ($gbkok) { '通过' } else { '失败' }))
$firstLineU8 = $(if ($u8text) { ([string]($u8text -split "`r?`n" | Select-Object -First 1)) } else { '' })
$firstLineGbk = $(if ($gbktext) { ([string]($gbktext -split "`r?`n" | Select-Object -First 1)) } else { '' })
if ($firstLineU8.Length -gt 120) { $firstLineU8 = $firstLineU8.Substring(0, 120) + '…' }
if ($firstLineGbk.Length -gt 120) { $firstLineGbk = $firstLineGbk.Substring(0, 120) + '…' }
Write-Info ('第 1 行按 UTF-8 读：' + $firstLineU8)
Write-Info ('第 1 行按 GBK 读：' + $firstLineGbk)
$L += ('- .NET 按 UTF-8 严格解：' + $(if ($u8ok) { '通过' } else { '失败' }) + '；按 GBK 严格解：' + $(if ($gbkok) { '通过' } else { '失败' }))
$L += ('- 第 1 行按 UTF-8 读：`' + $firstLineU8 + '`')
$L += ('- 第 1 行按 GBK 读：`' + $firstLineGbk + '`')

# ---------- 3. Java 自己的严格解码 ----------
$javac = Resolve-JavacExe
$java = $(if ($javac) { Join-Path (Split-Path $javac -Parent) 'java.exe' } else { '' })
$wr = Get-AsciiWorkRoot
$work = Join-Path $(if ($wr) { $wr } else { $env:TEMP }) ('diag-' + [string]$PID)
New-Item -ItemType Directory -Force -Path $work | Out-Null
Write-Step 'Java 自己的严格 UTF-8 解码器怎么看这个文件'
if (-not $javac -or -not (Test-Path -LiteralPath $java)) {
    Write-Bad '没找到 javac / java，跳过 Java 侧的检查'
    $L += '- 没找到 javac / java，Java 侧的检查没做'
} else {
    # 探针源码只含 ASCII，编译它本身不会碰到编码问题
    $probe = @(
        'import java.nio.*; import java.nio.charset.*; import java.nio.file.*;',
        'public class Probe {',
        '  public static void main(String[] a) throws Exception {',
        '    byte[] b = Files.readAllBytes(Paths.get(a[0]));',
        '    CharsetDecoder d = Charset.forName("UTF-8").newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);',
        '    ByteBuffer in = ByteBuffer.wrap(b); CharBuffer out = CharBuffer.allocate(b.length + 16);',
        '    CoderResult r = d.decode(in, out, true);',
        '    if (r.isError()) {',
        '      int pos = in.position(); int line = 1; for (int i = 0; i < pos; i++) if (b[i] == 10) line++;',
        '      StringBuilder hex = new StringBuilder();',
        '      for (int i = Math.max(0, pos - 8); i < Math.min(b.length, pos + 8); i++) hex.append(String.format("%02X ", b[i] & 0xFF));',
        '      System.out.println("JAVA_DECODE malformed offset=" + pos + " line=" + line + " badLen=" + r.length() + " around=" + hex.toString().trim());',
        '    } else System.out.println("JAVA_DECODE ok chars=" + out.position());',
        '    System.out.println("JAVA_PROPS java.version=" + System.getProperty("java.version") + " file.encoding=" + System.getProperty("file.encoding") + " sun.jnu.encoding=" + System.getProperty("sun.jnu.encoding"));',
        '  }',
        '}')
    Write-TextFile -Path (Join-Path $work 'Probe.java') -Text ($probe -join "`n")
    $pc = Invoke-Native -Exe $javac -ArgLine ('-J-Duser.language=en -encoding US-ASCII -d "' + $work + '" "' + (Join-Path $work 'Probe.java') + '"') -TimeoutSec 120
    if ($pc.exitCode -ne 0) {
        Write-Bad ('探针编译失败：' + (([string]$pc.stdout + [string]$pc.stderr).Trim() -split "`r?`n" | Select-Object -First 2) -join ' / ')
        $L += ('- Java 探针没编过：' + (([string]$pc.stdout + [string]$pc.stderr).Trim() -split "`r?`n" | Select-Object -First 1))
    } else {
        $pr = Invoke-Native -Exe $java -ArgLine ('-cp "' + $work + '" Probe "' + $File + '"') -TimeoutSec 120
        $out = @((([string]$pr.stdout) + ([string]$pr.stderr)) -split "`r?`n" | Where-Object { $_ -match '^JAVA_' })
        foreach ($o in $out) { Write-Info $o; $L += ('- ' + $o) }
        if (-not $out.Count) { Write-Warn2 ('探针没有输出：' + (([string]$pr.stderr) -split "`r?`n" | Select-Object -First 1)) }
    }
}

# ---------- 4. 用这台机器的 javac 单独编译这个文件 ----------
Write-Step '用这台机器的 javac 单独编译这个文件（-encoding UTF-8）'
if ($javac) {
    $ver = Invoke-Native -Exe $javac -ArgLine '-version' -TimeoutSec 30
    $L += ('- javac：' + $javac + '（' + (([string]$ver.stderr + [string]$ver.stdout).Trim() -split "`r?`n" | Select-Object -First 1) + '）')
    $arg = Join-Path $work 'one.args'
    Write-JavacArgFile -Path $arg -ClassPath @() -Sources @($File)
    $jr = Invoke-Javac -Javac $javac -ArgFile $arg -OutDir (Join-Path $work 'out') -Encoding 'UTF-8' -TimeoutSec 300
    $lines = @(($jr.text -split "`r?`n") | Where-Object { $_.Trim() })
    $dg = Get-JavacDiagnosis $jr.text
    Write-Info ('退出码 ' + [string]$jr.exitCode + '，' + [string]$dg.errors + ' 个错误，其中编码错误 ' + [string]$dg.encodingErrors + ' 个，BOM 错误 ' + [string]$dg.bomFiles + ' 个')
    foreach ($ln in @($lines | Select-Object -First 8)) { Write-Host ('       ' + $ln) }
    $L += ('- 单独编译：退出码 ' + [string]$jr.exitCode + '，' + [string]$dg.errors + ' 个错误（编码错误 ' + [string]$dg.encodingErrors + '，BOM 错误 ' + [string]$dg.bomFiles + '）。缺同工程的类会报 cannot find symbol，那不算数')
    $L += '- javac 输出前 8 行：'
    $L += '```'
    $L += @($lines | Select-Object -First 8)
    $L += '```'
    $L += ('- 编译命令：`' + $jr.line + '`')

    # ---------- 5. 对照 ----------
    Write-Step '对照：现写一个第 1 行带中文的 UTF-8 文件，同样编一次'
    $ctlDir = Join-Path $work 'ctl'
    New-Item -ItemType Directory -Force -Path $ctlDir | Out-Null
    $ctlSrc = "/** " + [string][char]0x8BA2 + [string][char]0x5355 + [string][char]0x670D + [string][char]0x52A1 + " */`npublic class Ctl {`n    public String s() { return `"" + [string][char]0x5DF2 + [string][char]0x9000 + [string][char]0x6B3E + "`"; }`n}`n"
    Write-TextFile -Path (Join-Path $ctlDir 'Ctl.java') -Text $ctlSrc
    $arg2 = Join-Path $work 'ctl.args'
    Write-JavacArgFile -Path $arg2 -ClassPath @() -Sources @((Join-Path $ctlDir 'Ctl.java'))
    $cr = Invoke-Javac -Javac $javac -ArgFile $arg2 -OutDir (Join-Path $work 'ctlout') -Encoding 'UTF-8' -TimeoutSec 120
    $ctlOk = ($cr.exitCode -eq 0)
    if ($ctlOk) { Write-Ok '对照文件编过了：这台机器的 javac 读 UTF-8 中文没问题' } else { Write-Bad ('对照文件也编不过：' + $cr.firstLine + '。问题在这台机器的 javac 或环境，不在你的文件') }
    $L += ('- 对照（现写的 UTF-8 中文文件）：' + $(if ($ctlOk) { '编过了' } else { '也编不过：' + $cr.firstLine }))
}
Write-Step '环境变量'
foreach ($k in @('JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_HOME')) {
    $v = [Environment]::GetEnvironmentVariable($k)
    Write-Info ($k + ' = ' + $(if ($v) { $v } else { '（没设）' }))
    $L += ('- ' + $k + '：' + $(if ($v) { '`' + $v + '`' } else { '没设' }))
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 判读 ----------
$L += ''
$L += '## 怎么读'
$L += ''
$L += '- Java 解码器报 malformed 而 .NET 按 UTF-8 通过：两边对同一批字节判断不一致，看 around 里的十六进制就知道是什么字节。'
$L += '- Java 解码器也 ok、但 javac 单独编译报 unmappable：javac 读的不是这个文件的这些字节，多半是环境变量或 javac 本身的问题，看对照结果。'
$L += '- 两边都说是 GBK（.NET 按 UTF-8 失败、Java 报 malformed、第 1 行按 GBK 读是正常中文）：文件就是 GBK，扫描漏了它，这是我的工具的 bug，把这份报告给我。'
$outDir = Join-Path $root ('results\encoding-diag-' + $ts)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$rp = Join-Path $outDir '编码诊断.md'
Write-TextFile -Path $rp -Text ($L -join "`n")
$desk = ''
try { $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ('编码诊断-' + $ts + '.md'); Copy-Item $rp $desk -Force } catch { $desk = '' }
Write-Host ''
Write-Host ('  报告：' + $rp) -ForegroundColor Cyan
if ($desk) { Write-Host ('  桌面副本：' + $desk) -ForegroundColor Cyan }
