' Installed actions only. Paths are derived at runtime, including Unicode paths.
' Run synchronously so the controller receives the PowerShell exit code.
Option Explicit
Dim action, shell, files, scriptPath, command, exitCode
action = "status"
If WScript.Arguments.Count > 0 Then action = LCase(WScript.Arguments(0))
Select Case action
    Case "start", "stop", "status", "start-ollama", "stop-ollama"
    Case Else
        WScript.Quit 2
End Select
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "installed-control.ps1")
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -Action """ & action & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
