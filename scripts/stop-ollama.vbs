' Stop Ollama silently (no console window): kill daemon and all runners.
' ASCII-only on purpose.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "taskkill /F /T /IM ollama.exe", 0, True
sh.Run "taskkill /F /IM llama-server.exe", 0, False
