@echo off
rem Stop the WeChat bot stack completely (one click). ASCII-only batch.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bot-ctl.ps1" stop
echo.
pause
