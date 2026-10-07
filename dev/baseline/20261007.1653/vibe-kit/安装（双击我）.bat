@echo off
cd /d "%~dp0"
if not exist "%~dp0install.js" (
  echo 找不到 install.js：多半是在压缩包里直接双击了。先把整个压缩包解压到一个文件夹，再双击解压出来的这个文件。
  pause
  exit /b 1
)
if not exist "%~dp0kit\hooks" (
  echo 安装包不完整，缺 kit 目录：先把整个压缩包解压出来，再双击解压出来的这个文件。
  pause
  exit /b 1
)
node -v >nul 2>nul
if errorlevel 1 (
  echo 没找到 node。需要先装 Node 18 以上，或者把它加进 PATH。
  pause
  exit /b 1
)
node "%~dp0install.js"
echo.
pause
