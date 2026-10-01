@echo off
rem Start the WeChat bot stack (one click). ASCII-only batch, see bot-ctl.ps1
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bot-ctl.ps1" start
echo.
pause
