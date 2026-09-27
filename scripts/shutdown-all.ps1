$ErrorActionPreference = 'SilentlyContinue'

# 停掉所有 supervisor 守护进程（含管理员权限启动的）
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*supervisor*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 停掉机器人
Stop-Process -Name 'node' -Force

Start-Sleep 35  # 等 35 秒确认没有守护进程把它拉起来

$node = (Get-Process -Name 'node' -ErrorAction SilentlyContinue | Measure-Object).Count
$sup  = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*supervisor*' } | Measure-Object).Count
$result = "RESULT node=$node supervisor=$sup"
$result | Out-File 'E:\wechaty-bot\logs\shutdown-status.txt' -Encoding utf8
Write-Output $result
