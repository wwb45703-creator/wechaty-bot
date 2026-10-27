' Stop AstrBot silently (no console window).
' ASCII-only on purpose.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "taskkill /F /T /IM astrbot.exe", 0, True
