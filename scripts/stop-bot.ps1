# Stop the wechaty bot and its supervisor. ASCII-only on purpose:
# Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI, which garbles
# Chinese comments/strings and can even break parsing.
$ErrorActionPreference = 'SilentlyContinue'

# 1. Stop the supervisor (if running) - it would respawn the bot every 30s
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*supervisor.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. Stop the bot
Stop-Process -Name 'node' -Force

# 3. Verify after 3s (supervisor ticks every 30s)
Start-Sleep 3
$node = (Get-Process -Name 'node' -ErrorAction SilentlyContinue | Measure-Object).Count
$supervisor = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*supervisor.ps1*' } | Measure-Object).Count

Write-Output "================================"
if ($node -eq 0) {
    Write-Output "Bot stopped OK."
} else {
    Write-Output "Bot still running - the supervisor was likely started as Administrator."
    Write-Output "Right-click stop-bot.bat and choose 'Run as administrator', then retry."
}
if ($supervisor -gt 0) {
    Write-Output "Note: $supervisor supervisor process(es) still running (they auto-restart the bot)."
}
Write-Output "================================"
