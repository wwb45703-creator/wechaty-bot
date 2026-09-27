# 机器人守护进程：每 30 秒检查机器人是否存活，死了自动拉起
# 日志：E:\wechaty-bot\logs\supervisor.log

$botDir = 'E:\wechaty-bot'
$nodeExe = Join-Path $botDir 'runtime\node18\node.exe'
$consoleLog = Join-Path $botDir 'logs\bot-console.log'
$errLog = Join-Path $botDir 'logs\bot-console.err.log'
$supLog = Join-Path $botDir 'logs\supervisor.log'

if (-not (Test-Path $nodeExe)) { $nodeExe = 'node.exe' }

function Log($msg) {
    Add-Content -Path $supLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" -Encoding UTF8
}

Log "supervisor started (pid $PID)"

while ($true) {
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and ($_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*src\index.js*') })
        if ($procs.Count -eq 0) {
            Log "bot not running, starting..."
            $p = Start-Process -FilePath $nodeExe `
                -ArgumentList 'src/index.js' `
                -WorkingDirectory $botDir `
                -RedirectStandardOutput $consoleLog -RedirectStandardError $errLog `
                -PassThru -WindowStyle Hidden
            if ($p) { Log "bot started, pid=$($p.Id)" }
            else { Log "Start-Process returned null!" }
        }
    }
    catch {
        Log "check error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 30
}
