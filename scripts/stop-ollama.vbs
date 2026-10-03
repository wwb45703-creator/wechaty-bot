' Stop Ollama silently (no console window): taskkill all ollama processes.
' ASCII-only on purpose.
CreateObject("WScript.Shell").Run "taskkill /F /IM ollama.exe", 0, False
