@echo off
cd /d "%~dp0"
if not exist "%~dp0publish.js" (
  echo 找不到 publish.js：多半是在压缩包里直接双击了。先把整个压缩包解压到一个文件夹，再双击解压出来的这个文件。
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
git --version >nul 2>nul
if errorlevel 1 (
  echo 没找到 git。发布要用 git，先装上，或者把它加进 PATH。
  pause
  exit /b 1
)
echo 这个脚本只给维护套件的人用。
echo 它先在这台电脑上装一遍，再把安装包发布到团队的 GitLab 仓库，同事的电脑会跟着自动更新。
echo 不想发布，现在直接关掉这个窗口。
echo.
pause
node "%~dp0publish.js" %*
echo.
pause
