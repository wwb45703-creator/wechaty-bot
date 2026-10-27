' Start AstrBot silently in background (no console window).
' ASCII-only on purpose.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\astrbot"
sh.Run "C:\Users\wwb\.local\bin\astrbot.exe run", 0, False
