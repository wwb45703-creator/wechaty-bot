@echo off
rem [deprecated] use bot-stop.bat instead. Kept for compatibility.
chcp 65001 >nul
cd /d "%~dp0"
echo [hint] stop-bot.bat has been replaced by bot-stop.bat, running it for you...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bot-ctl.ps1" stop
echo.
pause
