@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0toolsun-selftests.ps1"
echo.
pause
