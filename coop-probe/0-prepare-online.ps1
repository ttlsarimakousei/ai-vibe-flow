# 0-prepare-online.ps1 —— 在能上网的机器上跑一次，把包准备成可以整目录拷进内网的离线包
#   -SkipNode   不带便携版 Node（内网确定有 Node 时可加）
#   -SkipCheck  跳过判定自检
#   -Zip        打包到上级目录
param([switch]$SkipNode, [string]$NodeVersion = '', [switch]$SkipCheck, [switch]$Zip)
. (Join-Path $PSScriptRoot 'tools\common.ps1')
$root = Get-ProbeRoot

Write-Step '1/4 便携版 Node'
$nodeDir = Join-Path $root 'offline\node'
if ($SkipNode) { Write-Warn2 '已跳过。内网机器必须自己有 Node 18+' }
elseif (Test-Path (Join-Path $nodeDir 'node.exe')) { Write-Ok ('已存在（' + (& (Join-Path $nodeDir 'node.exe') -v) + '）') }
else {
    $local = Get-Command node.exe -ErrorAction SilentlyContinue
    $ver = $NodeVersion
    if (-not $ver -and $local) { $ver = ((& node -v) -replace '^v', '') }
    if (-not $ver) { Write-Bad '本机没有 Node，也没给 -NodeVersion，无法准备便携版' }
    else {
        $url = 'https://nodejs.org/dist/v' + $ver + '/node-v' + $ver + '-win-x64.zip'
        $nodeZip = Join-Path $root 'offline\node.zip'
        $tmp = Join-Path $root 'offline\node-tmp'
        Write-Info ('下载 ' + $url)
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            New-Item -ItemType Directory -Force -Path (Split-Path $nodeZip) | Out-Null
            Invoke-WebRequest -Uri $url -OutFile $nodeZip -UseBasicParsing
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-Archive -Path $nodeZip -DestinationPath $tmp -Force
            $exe = Get-ChildItem $tmp -Recurse -Filter node.exe | Select-Object -First 1
            New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
            Copy-Item $exe.FullName (Join-Path $nodeDir 'node.exe') -Force
            Remove-Item $tmp -Recurse -Force; Remove-Item $nodeZip -Force
            Write-Ok ('便携版 Node v' + $ver + ' 已就位')
        } catch { Write-Warn2 ('下载失败：' + $_.Exception.Message + '。可手动下载 ' + $url + '，解压出 node.exe 放到 ' + $nodeDir) }
    }
}

Write-Step '2/4 用例完整性检查'
$cases = @(Get-ChildItem (Join-Path $root 'tests') -Directory -ErrorAction SilentlyContinue)
$need = @('meta.json', 'task.md', 'verify.js', 'selftest.js', 'README.md')
$bad = @()
# 这几个工具文件缺了，内网跑到对应一步才会发现，所以打包前先查
foreach ($must in @('tools\javaprobe\Say.class', 'tools\javaprobe\lib\javax.servlet-api-3.1.0.jar', 'tools\node-shim.js', 'tools\latency-probe.js', 'tools\common.ps1', 'tools\legacy-build.ps1', 'tools\stream-check.js', 'tools\encoding-census.ps1', 'tools\models.ps1', 'tools\vision-check.js', 'tools\long-context.js', 'tools\encoding-fix.ps1', 'tools\project-profile.ps1', 'tools\encoding-diag.ps1', 'tools\vision\basic.png', 'tools\vision\table.png', 'tools\vision\diff-design.png', 'tools\vision\diff-impl.png', 'model-compare.ps1', 'long-context.ps1', 'models.example.json')) {
    if (-not (Test-Path (Join-Path $root $must))) { $bad += ('缺少工具文件 ' + $must); Write-Bad ('缺少工具文件：' + $must) }
}
foreach ($c in $cases) {
    $miss = @($need | Where-Object { -not (Test-Path (Join-Path $c.FullName $_)) })
    if (-not (Test-Path (Join-Path $c.FullName 'fixture'))) { $miss += 'fixture/' }
    if (-not (Test-Path (Join-Path $c.FullName 'selftest\pass'))) { $miss += 'selftest/pass/' }
    if (-not (Test-Path (Join-Path $c.FullName 'selftest\fail'))) { $miss += 'selftest/fail/' }
    # fixture 里不能混进 .git 或 task.md，否则工作区会被污染
    if (Test-Path (Join-Path $c.FullName 'fixture\.git')) { $miss += 'fixture 里混进了 .git' }
    if (Test-Path (Join-Path $c.FullName 'fixture\task.md')) { $miss += 'fixture 里混进了 task.md' }
    if ($miss.Count) { $bad += ($c.Name + '：缺 ' + ($miss -join '，')); Write-Bad ($c.Name + '：缺 ' + ($miss -join '，')) }
    else { Write-Ok $c.Name }
}
if (-not $cases.Count) { Write-Bad 'tests\ 下没有用例' }

Write-Step '3/4 判定自检'
if ($SkipCheck) { Write-Warn2 '已跳过' } else { & (Join-Path $root 'tools\run-selftests.ps1') }

Write-Step '4/4 打包'
if (-not $Zip) { Write-Info '未指定 -Zip，跳过。直接把整个 coop-probe 目录拷进内网也一样' }
else {
    $dest = Join-Path (Split-Path $root -Parent) ('coop-probe-' + (Get-Date -Format 'yyyyMMdd') + '.zip')
    $staging = Join-Path $env:TEMP ('coop-probe-staging-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path $dest) { Remove-Item $dest -Force }
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $staging 'coop-probe') | Out-Null
        # models.json 里是各模型的 key，只留在本机，绝不能打进包
        & robocopy $root (Join-Path $staging 'coop-probe') /E /XD results .git node-tmp /XF settings.json models.json /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw ('robocopy 退出码 ' + $LASTEXITCODE) }
        # 不用 Compress-Archive：PS 5.1 的它不给中文名打 UTF-8 标记，换台机器解压 bat 名会乱码
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
        [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $dest, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
        Write-Ok ('已打包：' + $dest + '（' + [int]((Get-Item $dest).Length / 1MB) + ' MB）')
    } catch { Write-Warn2 ('打包失败：' + $_.Exception.Message) }
    finally { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($bad.Count) { Write-Warn2 ('有 ' + $bad.Count + ' 个用例不完整，内网跑起来会缺项') }
Write-Host '准备完成。把整个 coop-probe 目录（或 zip）拷进内网，双击「全自动体检（双击我）.bat」。' -ForegroundColor Cyan
