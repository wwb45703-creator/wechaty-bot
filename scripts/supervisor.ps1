# Bot supervisor: single-round (-Once, used by scheduled task every minute)
# or loop mode (default). Auto-starts two things if down:
#   1) wechaty bot (node src/index.js)
#   2) local Ollama AI service (serve, port 11434)
# Kill switch: if state\bot-disabled.flag exists, do NOTHING and exit.
# Log: E:\wechaty-bot\logs\supervisor.log
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI;
#       Chinese comments here previously broke parsing and killed the script)

param(
    [switch]$Once
)

$botDir = 'E:\wechaty-bot'
$nodeExe = Join-Path $botDir 'runtime\node18\node.exe'
$ollamaExe = 'E:\Ollama\ollama.exe'
$consoleLog = Join-Path $botDir 'logs\bot-console.log'
$errLog = Join-Path $botDir 'logs\bot-console.err.log'
$ollamaLog = Join-Path $botDir 'logs\ollama.log'
$supLog = Join-Path $botDir 'logs\supervisor.log'
$flagFile = Join-Path $botDir 'state\bot-disabled.flag'

if (-not (Test-Path $nodeExe)) { $nodeExe = 'node.exe' }

function Log($msg) {
    Add-Content -Path $supLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" -Encoding UTF8
}

function Test-PortListening([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

# kill switch: disabled by flag file (created by bot-stop / bot-ctl.ps1 stop)
if (Test-Path $flagFile) {
    if (-not $Once) { Log "disabled flag present, supervisor exits without doing anything" }
    exit
}

# single instance guard: never run two supervisors (would double-start the bot)
$mutex = New-Object System.Threading.Mutex($false, 'Global\WechatyBotSupervisor')
if (-not $mutex.WaitOne(0)) {
    exit
}

# Start a process with zero window flash: .NET ProcessStartInfo + CreateNoWindow.
# stdout/stderr are discarded (the bot writes its own per-day log files via logger.js;
# ollama output is diagnostic only). Returns the PID or 0.
function Start-HiddenProcess([string]$exe, [string]$argList, [string]$workDir) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argList
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    return $proc
}

function Start-Guarded {
    # guard the wechaty bot
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*src\index.js*') })
    if ($procs.Count -eq 0) {
        Log "bot not running, starting..."
        $p = Start-HiddenProcess $nodeExe 'src/index.js' $botDir
        if ($p) { Log "bot started, pid=$($p.Id)" }
        else { Log "start failed!" }
    }

    # guard local Ollama
    $ollamaAlive = Test-PortListening 11434
    if (-not $ollamaAlive) {
        $ollamaProc = Get-Process -Name 'ollama' -ErrorAction SilentlyContinue
        if (-not $ollamaProc) {
            Log "ollama not running, starting..."
            $op = Start-HiddenProcess $ollamaExe 'serve' 'E:\Ollama'
            if ($op) { Log "ollama started, pid=$($op.Id)" }
        }
    }
}

if ($Once) {
    Start-Guarded
}
else {
    Log "supervisor started (pid $PID), guarding node bot + ollama"
    while ($true) {
        try {
            Start-Guarded
        }
        catch {
            Log "check error: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 30
    }
}
