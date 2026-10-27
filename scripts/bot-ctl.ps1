# bot-ctl.ps1: one-stop control for the WeChat bot
#   start  : remove kill-switch flag, run one supervisor round (starts bot+ollama), launch WeChat if needed
#   stop   : create kill-switch flag, kill supervisor/bot/ollama (WeChat untouched)
#   status : show panel
# Written as UTF-8 with BOM (see convert step) so Chinese output parses correctly on PS 5.1.

param(
    [Parameter(Position = 0)][string]$Action = 'status'
)

$botDir = 'D:\wechaty-bot'
$supScript = Join-Path $botDir 'scripts\supervisor.ps1'
$flagFile = Join-Path $botDir 'state\bot-disabled.flag'
$taskName = 'WechatyBotWatchdog'

function Get-BotProc {
    @(Get-Process -Name 'node' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like ($botDir + '\*') })
}

function Get-SupProc {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine -like '*supervisor.ps1*' -and $_.ProcessId -ne $PID })
}

function Show-Status {
    $disabled = Test-Path $flagFile
    $bot = Get-BotProc
    $sup = Get-SupProc
    $ollama = @(Get-Process -Name 'ollama' -ErrorAction SilentlyContinue).Count
    $llamaRunners = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
    $llamaMemMB = if ($llamaRunners.Count -gt 0) { [math]::Round(($llamaRunners | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB, 1) } else { 0 }
    $wechat = @(Get-Process -Name 'WeChat' -ErrorAction SilentlyContinue).Count
    $task = schtasks /query /tn $taskName 2>$null
    $taskOk = ($LASTEXITCODE -eq 0)

    Write-Output '================ 微信机器人状态 ================'
    if ($disabled) { Write-Output '  开关状态      : 已停用（bot-disabled.flag 存在，看门狗不会拉起）' }
    else { Write-Output '  开关状态      : 已启用' }
    Write-Output "  看门狗计划任务: $(if ($taskOk) { '已注册（每分钟体检）' } else { '未注册！' })"
    Write-Output "  机器人进程    : $(if ($bot.Count -gt 0) { '运行中' } else { '未运行' })"
    $ollamaStatus = if ($ollama -gt 0) {
        if ($llamaRunners.Count -gt 1) {
            "运行中（警告：检测到 $($llamaRunners.Count) 个推理引擎进程，共占 ${llamaMemMB}MB，可能有残留）"
        } elseif ($llamaRunners.Count -eq 1) {
            "运行中（含 1 个活跃推理引擎，占用 ${llamaMemMB}MB）"
        } else {
            '运行中（空闲，未加载模型）'
        }
    } else {
        if ($llamaRunners.Count -gt 0) {
            "未运行（警告：发现 $($llamaRunners.Count) 个游离推理引擎进程，占 ${llamaMemMB}MB！）"
        } else {
            '未运行'
        }
    }
    Write-Output "  Ollama AI     : $ollamaStatus"
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
            $botId = if ($_.Id) { $_.Id } else { $_.ProcessId }
            try { Stop-Process -Id $botId -Force -ErrorAction Stop; Write-Output "[stop] 已结束机器人进程 $botId" } catch {}
        }
        # stop ollama and all inference runners
        $ollamaProcs = @(Get-Process -Name 'ollama', 'llama-server' -ErrorAction SilentlyContinue)
        if ($ollamaProcs.Count -gt 0) {
            $ollamaProcs | Stop-Process -Force -ErrorAction SilentlyContinue
            Write-Output '[stop] 已停止 Ollama AI 服务及所有推理引擎'
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
