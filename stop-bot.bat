@echo off
rem Stop the wechaty bot (and its supervisor if running). ASCII-only on purpose.
rem If the supervisor was started as Administrator, run this as Administrator too.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stop-bot.ps1"
pause
