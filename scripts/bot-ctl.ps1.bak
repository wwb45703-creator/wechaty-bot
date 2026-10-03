# bot-ctl.ps1: one-stop control for the WeChat bot
#   start  : remove kill-switch flag, run one supervisor round (starts bot+ollama), launch WeChat if needed
#   stop   : create kill-switch flag, kill supervisor/bot/ollama (WeChat untouched)
#   status : show panel
# Written as UTF-8 with BOM (see convert step) so Chinese output parses correctly on PS 5.1.

param(
    [Parameter(Position = 0)][string]$Action = 'status'
)

$botDir = 'E:\wechaty-bot'
$supScript = Join-Path $botDir 'scripts\supervisor.ps1'
$flagFile = Join-Path $botDir 'state\bot-disabled.flag'
$taskName = 'WechatyBotWatchdog'

function Get-BotProc {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*src\index.js*') })
}

function Get-SupProc {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*supervisor.ps1*' -and $_.ProcessId -ne $PID })
}

function Show-Status {
    $disabled = Test-Path $flagFile
    $bot = Get-BotProc
    $sup = Get-SupProc
    $ollama = @(Get-Process -Name 'ollama' -ErrorAction SilentlyContinue).Count
    $wechat = @(Get-Process -Name 'WeChat' -ErrorAction SilentlyContinue).Count
    $task = schtasks /query /tn $taskName 2>$null
    $taskOk = ($LASTEXITCODE -eq 0)

    Write-Output '================ 微信机器人状态 ================'
    if ($disabled) { Write-Output '  开关状态      : 已停用（bot-disabled.flag 存在，看门狗不会拉起）' }
    else { Write-Output '  开关状态      : 已启用' }
    Write-Output "  看门狗计划任务: $(if ($taskOk) { '已注册（每分钟体检）' } else { '未注册！' })"
    Write-Output "  机器人进程    : $(if ($bot.Count -gt 0) { '运行中' } else { '未运行' })"
    Write-Output "  Ollama AI     : $(if ($ollama -gt 0) { '运行中' } else { '未运行' })"
    Write-Output "  守护循环进程  : $(if ($sup.Count -gt 0) { '有 ' + $sup.Count + ' 个（旧循环模式残留，计划任务模式下无影响）' } else { '无（正常，看门狗为计划任务模式）' })"
    Write-Output "  微信客户端    : $(if ($wechat -gt 0) { '运行中' } else { '未运行（需要你手动登录微信）' })"
    Write-Output '------------------------------------------------'
    if (-not $disabled -and $bot.Count -eq 0) { Write-Output '  提示：等 1 分钟内看门狗会自动拉起机器人，或重跑 bot-start.bat' }
    if ($disabled) { Write-Output '  提示：重新启用请双击 bot-start.bat' }
    Write-Output '================================================'
}

switch ($Action.ToLower()) {
    'start' {
        if (Test-Path $flagFile) { Remove-Item $flagFile -Force }
        Write-Output '[start] 已启用开关，执行一轮体检（拉起机器人 + Ollama）...'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $supScript -Once
        if (@(Get-Process -Name 'WeChat' -ErrorAction SilentlyContinue).Count -eq 0) {
            $wechatExe = 'C:\Program Files\Tencent\WeChat\WeChat.exe'
            if (Test-Path $wechatExe) {
                Start-Process $wechatExe
                Write-Output '[start] 已启动微信客户端，请在微信窗口完成登录（如需要）'
            }
        }
        Start-Sleep -Seconds 2
        Show-Status
    }
    'stop' {
        New-Item -ItemType File -Path $flagFile -Force | Out-Null
        Write-Output '[stop] 已创建停用标记，看门狗从现在起不会再拉起任何东西'
        # kill legacy loop-mode supervisors
        Get-SupProc | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output "[stop] 已结束守护循环进程 $($_.ProcessId)" } catch {}
        }
        # kill bot node only (never other node.exe like MCP servers)
        Get-BotProc | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output "[stop] 已结束机器人进程 $($_.ProcessId)" } catch {}
        }
        # stop ollama
        if (@(Get-Process -Name 'ollama' -ErrorAction SilentlyContinue).Count -gt 0) {
            Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue
            Write-Output '[stop] 已停止 Ollama AI 服务'
        }
        Start-Sleep -Seconds 2
        Show-Status
        Write-Output '提示：微信客户端未受影响；重新启用请双击 bot-start.bat'
    }
    'status' {
        Show-Status
    }
    default {
        Write-Output "用法: bot-ctl.ps1 [start|stop|status]"
        exit 1
    }
}
