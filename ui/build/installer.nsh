; Never terminate any process. Check only the selected installation directory.
; This also replaces the default process-killing check in the uninstaller.
!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "WECHATY_INSTALL_TARGET", t "$INSTDIR") i .r0'
  ${if} $0 == 0
    SetErrorLevel 3
    Quit
  ${endif}
  ${if} ${RunningX64}
    StrCpy $R2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${else}
    StrCpy $R2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${endif}
  nsExec::ExecToStack `"$R2" -NoProfile -NonInteractive -Command "try { $$root = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable('WECHATY_INSTALL_TARGET', 'Process')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar; foreach ($$item in (Get-Process -ErrorAction Stop)) { if ($$item.ProcessName -notin @('微信机器人控制台', 'node', 'ollama', 'llama-server', 'llama-quantize', 'WeChatSetup-3.9.10.27')) { continue }; $$exe = $$item.Path; if ([string]::IsNullOrWhiteSpace($$exe)) { exit 3 }; if ($$exe.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase)) { exit 2 } }; exit 0 } catch { exit 3 }"`
  Pop $R0
  Pop $R1
  System::Call 'kernel32::SetEnvironmentVariable(t "WECHATY_INSTALL_TARGET", p 0) i .r1'
  ${if} $R0 == 2
    MessageBox MB_OK|MB_ICONEXCLAMATION "此安装目录的控制台或本地服务正在运行。请先自行关闭该目录下的程序，再重新安装或卸载。其他目录的程序不会受到影响。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认此安装目录的进程状态，已停止安装或卸载。请关闭该目录下的程序后重试。" /SD IDOK
    SetErrorLevel 3
    Quit
  ${endif}
!macroend
