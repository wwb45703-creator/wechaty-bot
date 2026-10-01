# [deprecated entry] Stop the WeChat bot stack safely.
# Forwards to bot-ctl.ps1 stop (kills ONLY the bot node process by command line,
# never other node.exe like MCP servers). ASCII-only on purpose.
chcp 65001 >nul
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bot-ctl.ps1') stop
