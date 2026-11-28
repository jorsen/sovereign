' Starts Sovereign with no visible windows: the website and the Discord
' bot, each in a hidden self-restarting loop that logs to logs\. Skips
' whatever is already running. Run by the "Sovereign" startup and desktop
' shortcuts that install.bat makes.
'   wscript scripts\start-hidden.vbs        start (if needed), quietly
'   wscript scripts\start-hidden.vbs open   ...and open the website
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

If Not fso.FileExists(root & "\.env") Then
  MsgBox "Sovereign isn't set up on this PC yet -- run install.bat first.", 48, "Sovereign"
  WScript.Quit 1
End If
If Not fso.FolderExists(root & "\logs") Then fso.CreateFolder root & "\logs"

check = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\local-procs.ps1"" -Check "

' 0 = hidden window; True = wait for the check's exit code.
If sh.Run(check & "website", 0, True) <> 0 Then
  sh.Run "cmd /c """ & root & "\scripts\run-website.bat""", 0, False
End If

' The bot only on the PC whose discord-bot\.env has a token.
botEnv = root & "\discord-bot\.env"
If fso.FileExists(botEnv) Then
  envText = fso.OpenTextFile(botEnv, 1).ReadAll
  Set re = New RegExp
  re.Pattern = "(^|\n)DISCORD_TOKEN=\S"
  If re.Test(envText) Then
    If sh.Run(check & "bot", 0, True) <> 0 Then
      sh.Run "cmd /c """ & root & "\scripts\run-bot.bat""", 0, False
    End If
  End If
End If

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "open" Then
    WScript.Sleep 5000
    sh.Run "http://localhost:3001"
  End If
End If
