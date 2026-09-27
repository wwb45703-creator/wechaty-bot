@echo off
rem ============================================================
rem  Wechaty WeChat Bot launcher (ASCII-only on purpose:
rem  cmd batch files are parsed with the legacy codepage before
rem  chcp takes effect, so keep this file pure ASCII)
rem  The bot runs on the bundled Node 18 (runtime\node18):
rem  the frida native binding shipped with wechaty-puppet-xp
rem  does not support newer Node ABIs.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_CMD=%~dp0runtime\node18\node.exe"
if not exist "%NODE_CMD%" set "NODE_CMD=node"

echo [start.bat] using node: %NODE_CMD%
"%NODE_CMD%" src\index.js

echo.
echo [start.bat] bot exited.
pause
