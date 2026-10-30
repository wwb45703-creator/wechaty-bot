# Installed controller actions. ASCII-only for Windows PowerShell 5.1.
param(
    [ValidateSet('start', 'stop', 'status', 'start-ollama', 'stop-ollama')]
    [string]$Action = 'status',
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$projectRoot = if ($env:BOT_PROJECT_ROOT) { [IO.Path]::GetFullPath($env:BOT_PROJECT_ROOT) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$defaultData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WechatyBotConsole\data'
$dataRoot = if ($env:BOT_DATA_ROOT) { [IO.Path]::GetFullPath($env:BOT_DATA_ROOT) } else { $defaultData }
$configFile = if ($env:BOT_CONFIG_FILE) { [IO.Path]::GetFullPath($env:BOT_CONFIG_FILE) } else { Join-Path $dataRoot 'config.json' }
$nodeExe = Join-Path $projectRoot 'runtime\node18\node.exe'
$ollamaExe = if ($env:BOT_OLLAMA_EXE) { [IO.Path]::GetFullPath($env:BOT_OLLAMA_EXE) } else { Join-Path $projectRoot 'runtime\ollama\ollama.exe' }
$stateDir = Join-Path $dataRoot 'state'
$botPidFile = Join-Path $stateDir 'bot.pid'
$ollamaPidFile = Join-Path $stateDir 'installed-ollama.pid'
$botFlag = Join-Path $stateDir 'bot-disabled.flag'
$ollamaFlag = Join-Path $stateDir 'ollama-disabled.flag'
$logFile = Join-Path $dataRoot 'logs\installed-control.log'
$markerFile = Join-Path $projectRoot 'distribution.json'

function Emit($value) { $value | ConvertTo-Json -Depth 6 -Compress | Write-Output }
function Log([string]$message) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $logFile)) | Out-Null
    [IO.File]::AppendAllText($logFile, ('[{0}] [{1}] {2}' -f [DateTime]::UtcNow.ToString('o'), $Action, $message) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}
function Same-Path([string]$left, [string]$right) {
    if (-not $left -or -not $right) { return $false }
    return [string]::Equals([IO.Path]::GetFullPath($left), [IO.Path]::GetFullPath($right), [StringComparison]::OrdinalIgnoreCase)
}
function Read-OwnedProcess([string]$pidFile, [string]$expectedExe) {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    $ownerFile = $pidFile + '.owner.json'
    if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf)) { return $null }
    $processIdValue = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$processIdValue) -or $processIdValue -le 0) { return $null }
    try { $owner = [IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json } catch { return $null }
    if ($owner.pid -ne $processIdValue -or -not (Same-Path $owner.exe $expectedExe)) { return $null }
    $candidate = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    try { if ((Same-Path $candidate.Path $expectedExe) -and [string]$candidate.StartTime.ToUniversalTime().Ticks -eq [string]$owner.startedTicks) { return $candidate } } catch { }
    return $null
}
function Save-Ownership([string]$pidFile, $owned, [string]$exe) {
    $owner = @{ pid = $owned.Id; exe = $exe; startedTicks = [string]$owned.StartTime.ToUniversalTime().Ticks }
    try {
        [IO.File]::WriteAllText(($pidFile + '.owner.json'), ($owner | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($pidFile, [string]$owned.Id)
    } catch {
        # Do not strand a newly created process when its ownership cannot be
        # persisted. Only this exact start is eligible for rollback.
        $failure = $_
        $candidate = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
        try {
            if ($candidate -and (Same-Path $candidate.Path $exe) -and [string]$candidate.StartTime.ToUniversalTime().Ticks -eq $owner.startedTicks) { Stop-Process -Id $candidate.Id -Force -ErrorAction Stop }
        } catch { }
        throw $failure
    }
}
function Assert-NoUnownedRuntime([string]$exe, [string]$pidFile) {
    $owned = Read-OwnedProcess $pidFile $exe
    $name = [IO.Path]::GetFileNameWithoutExtension($exe)
    foreach ($candidate in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        try { $sameExe = Same-Path $candidate.Path $exe } catch { $sameExe = $false }
        if ($sameExe -and (-not $owned -or $candidate.Id -ne $owned.Id)) { throw "An untracked process already uses this installation runtime: $exe (PID $($candidate.Id)). Close it manually before retrying; it will not be killed automatically." }
    }
}
function Assert-Payload {
    foreach ($requiredFile in @($markerFile, $nodeExe, $ollamaExe, (Join-Path $projectRoot 'src\index.js'))) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Installation component is missing: $requiredFile. Reinstall this package; system Node is never used." }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container)) { throw 'Installed bot dependencies are missing. Reinstall this package.' }
}
function Assert-CompatibleWeChat {
    $clients = @(Get-Process -Name 'WeChat' -ErrorAction SilentlyContinue)
    if ($clients.Count -eq 0) { throw 'Open WeChat 3.9.10.27 and finish signing in yourself before starting the bot. No client is installed or launched automatically.' }
    foreach ($client in $clients) {
        $clientPath = $client.Path
        if (-not $clientPath) { throw 'Cannot verify the running WeChat version. Stop and check the client manually.' }
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($clientPath).FileVersion
        if ($version -notmatch '^3\.9\.10\.27(?:\D|$)') { throw "Unsupported running WeChat version: $version. This bot requires exactly 3.9.10.27; no client will be upgraded automatically." }
    }
}
function Start-Hidden([string]$exe, [string]$arguments, [string]$workingDirectory) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $exe
    $info.Arguments = $arguments
    $info.WorkingDirectory = $workingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.EnvironmentVariables['BOT_PROJECT_ROOT'] = $projectRoot
    $info.EnvironmentVariables['BOT_DATA_ROOT'] = $dataRoot
    $info.EnvironmentVariables['BOT_CONFIG_FILE'] = $configFile
    $info.EnvironmentVariables['BOT_OLLAMA_EXE'] = $ollamaExe
    $info.EnvironmentVariables['OLLAMA_HOST'] = '127.0.0.1:11434'
    $info.EnvironmentVariables['OLLAMA_MODELS'] = if ($env:BOT_OLLAMA_MODELS) { [IO.Path]::GetFullPath($env:BOT_OLLAMA_MODELS) } else { Join-Path $dataRoot 'ollama-models' }
    return [Diagnostics.Process]::Start($info)
}
function Test-OllamaReady {
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:11434/api/version')
        $request.Timeout = 500
        $request.ReadWriteTimeout = 500
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        if ($body.Length -gt 32768) { return $false }
        $value = $body | ConvertFrom-Json
        return -not [string]::IsNullOrWhiteSpace([string]$value.version)
    } catch { return $false }
    finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Dispose() } }
}
function Ensure-Ollama {
    if (Test-OllamaReady) { return @{ ready = $true; reused = $true } }
    Assert-NoUnownedRuntime $ollamaExe $ollamaPidFile
    $owned = Read-OwnedProcess $ollamaPidFile $ollamaExe
    if (-not $owned) {
        $owned = Start-Hidden $ollamaExe 'serve' (Split-Path -Parent $ollamaExe)
        Save-Ownership $ollamaPidFile $owned $ollamaExe
        Log "Started owned Ollama PID $($owned.Id)."
    }
    for ($i = 0; $i -lt 15; $i++) {
        if (Test-OllamaReady) { return @{ ready = $true; reused = $false; pid = $owned.Id } }
        $owned.Refresh()
        if ($owned.HasExited) { throw "Bundled Ollama exited with code $($owned.ExitCode). Check port 11434 and the runtime files." }
        Start-Sleep -Milliseconds 250
    }
    throw 'Bundled Ollama did not become ready. It remains tracked by its own PID; use Stop Ollama before retrying.'
}
function Stop-Owned([string]$pidFile, [string]$exe, [switch]$WithRunners) {
    $owned = Read-OwnedProcess $pidFile $exe
    if (-not $owned) {
        # A missing or stale ownership record does not prove the runtime is
        # stopped. Preserve evidence and report ambiguity instead of success.
        Assert-NoUnownedRuntime $exe $pidFile
        if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
        if (Test-Path -LiteralPath ($pidFile + '.owner.json')) { Remove-Item -LiteralPath ($pidFile + '.owner.json') -Force }
        return $false
    }
    if ($WithRunners) {
        # Only descendants of our recorded daemon, and only executables from
        # this runtime directory. Never kill other Ollama services by name.
        $runtimePrefix = (Split-Path -Parent $exe).TrimEnd('\') + '\'
        $queue = New-Object 'System.Collections.Generic.Queue[int]'
        $queue.Enqueue($owned.Id)
        $descendants = New-Object 'System.Collections.Generic.List[object]'
        while ($queue.Count -gt 0) {
            $parentIdValue = $queue.Dequeue()
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentIdValue" -ErrorAction SilentlyContinue)
            foreach ($child in $children) {
                if ($child.ExecutablePath -and $child.ExecutablePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $descendants.Add($child)
                    $queue.Enqueue([int]$child.ProcessId)
                }
            }
        }
        foreach ($child in $descendants) {
            $stillChild = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.ProcessId)" -ErrorAction SilentlyContinue
            if ($stillChild -and $stillChild.ParentProcessId -eq $child.ParentProcessId -and $stillChild.CreationDate -eq $child.CreationDate -and (Same-Path $stillChild.ExecutablePath $child.ExecutablePath)) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }
    $verified = Read-OwnedProcess $pidFile $exe
    if ($verified) { Stop-Process -Id $verified.Id -Force -ErrorAction Stop; Log "Stopped owned PID $($verified.Id)." }
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    if (Test-Path -LiteralPath ($pidFile + '.owner.json')) { Remove-Item -LiteralPath ($pidFile + '.owner.json') -Force }
    return $true
}

if ($ValidateOnly) {
    Emit @{ ok = $true; validateOnly = $true; action = $Action; projectRoot = $projectRoot; dataRoot = $dataRoot; configFile = $configFile; nodeExe = $nodeExe; ollamaExe = $ollamaExe; markerPresent = (Test-Path -LiteralPath $markerFile -PathType Leaf); nodePresent = (Test-Path -LiteralPath $nodeExe -PathType Leaf); ollamaPresent = (Test-Path -LiteralPath $ollamaExe -PathType Leaf); entryPresent = (Test-Path -LiteralPath (Join-Path $projectRoot 'src\index.js') -PathType Leaf); dependenciesPresent = (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container) }
    exit 0
}

$actionMutex = $null
$haveMutex = $false
try {
    if (-not (Test-Path -LiteralPath $markerFile -PathType Leaf)) { throw 'Distribution marker is missing. Installed controls do not operate on an existing development checkout.' }
    $hashProvider = [Security.Cryptography.SHA256]::Create()
    try { $dataHash = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 24) }
    finally { $hashProvider.Dispose() }
    $actionMutex = New-Object Threading.Mutex($false, ('Local\WechatyBotInstalled_' + $dataHash))
    try { $haveMutex = $actionMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $haveMutex = $true }
    if (-not $haveMutex) { throw 'Another control action is running for this data directory. Wait for it to finish and retry.' }
    [IO.Directory]::CreateDirectory($stateDir) | Out-Null
    switch ($Action) {
        'start' {
            Assert-Payload
            if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw 'User configuration is missing. Open the installed console first to initialize it.' }
            Assert-CompatibleWeChat
            Assert-NoUnownedRuntime $nodeExe $botPidFile
            if (Test-Path -LiteralPath $botFlag) { Remove-Item -LiteralPath $botFlag -Force }
            if (-not (Test-Path -LiteralPath $ollamaFlag)) { $null = Ensure-Ollama }
            $owned = Read-OwnedProcess $botPidFile $nodeExe
            if (-not $owned) {
                $owned = Start-Hidden $nodeExe 'src/index.js' $projectRoot
                Save-Ownership $botPidFile $owned $nodeExe
                Start-Sleep -Milliseconds 500
                $owned.Refresh()
                if ($owned.HasExited) { throw "Bot exited with code $($owned.ExitCode). Review its data-directory logs and confirm WeChat sign-in." }
                Log "Started owned bot PID $($owned.Id)."
            }
            Emit @{ ok = $true; action = $Action; pid = $owned.Id }
        }
        'stop' {
            [IO.File]::WriteAllText($botFlag, '')
            $stopped = Stop-Owned $botPidFile $nodeExe
            Emit @{ ok = $true; action = $Action; stopped = $stopped }
        }
        'start-ollama' {
            Assert-Payload
            if (Test-Path -LiteralPath $ollamaFlag) { Remove-Item -LiteralPath $ollamaFlag -Force }
            $result = Ensure-Ollama
            Emit @{ ok = $true; action = $Action; ready = $result.ready; reused = $result.reused }
        }
        'stop-ollama' {
            [IO.File]::WriteAllText($ollamaFlag, '')
            $stopped = Stop-Owned $ollamaPidFile $ollamaExe -WithRunners
            Emit @{ ok = $true; action = $Action; stopped = $stopped; note = 'Only the daemon recorded by this installation was eligible; shared services remain running.' }
        }
        'status' {
            $bot = Read-OwnedProcess $botPidFile $nodeExe
            $ollama = Read-OwnedProcess $ollamaPidFile $ollamaExe
            Emit @{ ok = $true; action = $Action; botRunning = [bool]$bot; botPid = $(if ($bot) { $bot.Id } else { $null }); ollamaOwned = [bool]$ollama; ollamaReady = (Test-OllamaReady); botDisabled = (Test-Path -LiteralPath $botFlag); ollamaDisabled = (Test-Path -LiteralPath $ollamaFlag) }
        }
    }
    Log 'Action completed.'
    exit 0
} catch {
    $message = $_.Exception.Message
    try { Log $message } catch { }
    Emit @{ ok = $false; action = $Action; error = $message }
    exit 1
} finally {
    if ($haveMutex) { $actionMutex.ReleaseMutex() }
    if ($actionMutex) { $actionMutex.Dispose() }
}
