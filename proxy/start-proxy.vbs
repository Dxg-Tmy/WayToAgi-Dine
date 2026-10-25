' 启动顺点本地代理（脱离父进程树，不随会话结束被回收）
' 用法：wscript.exe //nologo proxy\start-proxy.vbs
Option Explicit
Dim shell, fso, base, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "cmd /c cd /d """ & base & "\proxy"" && " & _
      "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe server.mjs >> """ & base & "\proxy\proxy.log"" 2>&1"
' 0 = 不显示窗口, False = 不等待（完全脱离）
shell.Run cmd, 0, False
