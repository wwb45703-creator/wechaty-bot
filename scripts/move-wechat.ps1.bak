$ErrorActionPreference = 'Stop'

$src = 'C:\Program Files\Tencent\WeChat'
$dst = 'E:\Apps\WeChat3.9'

if (-not (Test-Path "$src\WeChat.exe")) {
    Write-Output "SKIP: $src\WeChat.exe not found"
    exit 1
}

New-Item -ItemType Directory -Path $dst -Force | Out-Null

# Move the whole tree to E:
robocopy $src $dst /E /MOVE /NFL /NDL /NJH /NJS /R:3 /W:2
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

# Remove the leftover dir on C: and put a junction in its place
if (Test-Path $src) { Remove-Item $src -Force -Recurse }
New-Item -ItemType Junction -Path $src -Target $dst | Out-Null

Write-Output "DONE: moved to $dst, junction created at $src"
