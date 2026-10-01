' WechatyBot watchdog launcher: runs the per-minute supervisor round
' with a fully hidden window (no console flash).
' ASCII-only on purpose.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File E:\wechaty-bot\scripts\supervisor.ps1 -Once", 0, False
