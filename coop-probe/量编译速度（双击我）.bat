@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp02-baseline.ps1" -Only feedback -AskProject
echo.
pause
