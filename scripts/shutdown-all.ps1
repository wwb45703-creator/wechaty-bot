# [deprecated entry] Full shutdown with verification.
# Forwards to bot-ctl.ps1 stop (safe: kill switch flag + precise process kill).
# ASCII-only on purpose (PowerShell 5.1 reads BOM-less files as ANSI).
chcp 65001 >nul
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bot-ctl.ps1') stop
Write-Output 'Shutdown requested. Use bot-status.bat to verify.'
