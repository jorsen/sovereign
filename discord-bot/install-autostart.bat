@echo off
REM Makes the bot start by itself (in a minimized window) every time you sign in to
REM Windows on this PC. Run remove-autostart.bat to undo.
REM Only do this on ONE PC -- two copies of the bot running at once double-reply.

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Sovereign bot.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = Join-Path (Get-Location) 'start-bot.bat';" ^
  "$s.WorkingDirectory = (Get-Location).Path;" ^
  "$s.WindowStyle = 7;" ^
  "$s.Save();" ^
  "Write-Host ('Added: ' + $lnk)"
if errorlevel 1 (
  echo Could not add the startup shortcut.
) else (
  echo The bot will now start automatically when you sign in to Windows.
  echo Run start-bot.bat now if you want it running right away.
)
pause
