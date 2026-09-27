# PowerShell launcher: force UTF-8 console so Chinese logs never garble.
# Runs the bot on the bundled Node 18 (frida binding requires it).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
Set-Location -LiteralPath $PSScriptRoot

$node = Join-Path $PSScriptRoot "runtime\node18\node.exe"
if (-not (Test-Path $node)) { $node = "node" }

& $node .\src\index.js
