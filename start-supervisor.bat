@echo off
rem [deprecated] use bot-start.bat instead. Kept for compatibility.
chcp 65001 >nul
cd /d "%~dp0"
echo [hint] start-supervisor.bat has been replaced by bot-start.bat, starting it for you...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bot-ctl.ps1" start
echo.
pause
