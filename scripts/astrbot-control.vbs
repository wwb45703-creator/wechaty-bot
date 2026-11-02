' Quiet local AstrBot control. Never terminate a service without ownership.
Option Explicit
Dim args, action, exePath, workDir, ownerFile, fso, svc, startup, pid, code, item, stream, savedPid, savedTime, found
Set args = WScript.Arguments
If args.Count <> 4 Then WScript.Quit 2
action = args(0)
exePath = args(1)
workDir = args(2)
ownerFile = args(3)
Set fso = CreateObject("Scripting.FileSystemObject")
Set svc = GetObject("winmgmts:\\.\root\cimv2")
If action = "start" Then
  If Not fso.FileExists(exePath) Or Not fso.FolderExists(workDir) Then WScript.Quit 3
  Set startup = svc.Get("Win32_ProcessStartup").SpawnInstance_
  startup.ShowWindow = 0
  code = svc.Get("Win32_Process").Create(Chr(34) & exePath & Chr(34) & " run", workDir, startup, pid)
  If code <> 0 Then WScript.Quit 4
  WScript.Sleep 250
  For Each item In svc.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" & CLng(pid))
    Set stream = fso.CreateTextFile(ownerFile, True)
    stream.WriteLine CStr(pid)
    stream.WriteLine CStr(item.CreationDate)
    stream.Close
    WScript.Quit 0
  Next
  WScript.Quit 5
ElseIf action = "stop" Then
  If Not fso.FileExists(ownerFile) Then WScript.Quit 6
  Set stream = fso.OpenTextFile(ownerFile, 1)
  savedPid = stream.ReadLine
  savedTime = stream.ReadLine
  stream.Close
  If Not IsNumeric(savedPid) Then WScript.Quit 7
  found = False
  For Each item In svc.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" & CLng(savedPid))
    found = True
    If CStr(item.CreationDate) <> savedTime Then WScript.Quit 8
    If LCase(CStr(item.ExecutablePath)) <> LCase(exePath) Then WScript.Quit 9
    StopChildren CLng(savedPid)
    code = item.Terminate()
    If code <> 0 Then WScript.Quit 10
  Next
  If fso.FileExists(ownerFile) Then fso.DeleteFile ownerFile, True
  WScript.Quit 0
End If
WScript.Quit 2

Sub StopChildren(parentPid)
  Dim child
  For Each child In svc.ExecQuery("SELECT * FROM Win32_Process WHERE ParentProcessId=" & CLng(parentPid))
    If CStr(child.CreationDate) >= savedTime Then
      StopChildren CLng(child.ProcessId)
      child.Terminate()
    End If
  Next
End Sub
