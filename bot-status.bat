@echo off
rem Show the WeChat bot stack status. ASCII-only batch.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bot-ctl.ps1" status
echo.
pause
