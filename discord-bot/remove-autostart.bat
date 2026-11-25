@echo off
REM Stops the bot from starting by itself when you sign in to Windows on this PC.
REM (Does not stop a bot that is already running -- close its window for that.)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Sovereign bot.lnk';" ^
  "if (Test-Path $lnk) { Remove-Item $lnk; Write-Host 'Auto-start removed.' } else { Write-Host 'Auto-start was not set up on this PC.' }"
pause
