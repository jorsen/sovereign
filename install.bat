@echo off
REM Sovereign -- one-time setup on this PC. Double-click it.
REM Installs the website and the Discord screenshot bot, asks for the live
REM database URL and bot settings, then makes both run hidden in the
REM background: now, and every time you sign in to Windows (restarting by
REM themselves if they crash). Safe to run again: it only asks for what's missing.
cd /d "%~dp0"
title Sovereign installer

echo.
echo ==============================================
echo   Sovereign -- install
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org , then run this again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22 or newer is needed ^(this PC has version %NODE_MAJOR%^). Update it from https://nodejs.org .
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 echo Note: Git is not installed -- updates won't be pulled automatically. https://git-scm.com

echo [1/4] Installing the website's packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto :failed
echo.
echo [2/4] Installing the bot's packages...
pushd discord-bot
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  goto :failed
)
popd

echo.
echo [3/4] Settings...
node scripts\setup-env.js
if errorlevel 1 (
  echo.
  echo A connection test failed -- see above. Fix it and run install.bat again.
  pause
  exit /b 1
)

echo.
echo [4/4] Setting it to run in the background...
REM Stop any copies started the old way (visible windows), then hand over.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-procs.ps1" -Stop >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Sovereign bot.lnk" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$vbs = Join-Path '%~dp0' 'scripts\start-hidden.vbs';" ^
  "$icon = Join-Path '%~dp0' 'assets\sovereign.ico';" ^
  "$s = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Sovereign.lnk'));" ^
  "$s.TargetPath = 'wscript.exe'; $s.Arguments = '\"' + $vbs + '\"'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = $icon + ',0'; $s.Save();" ^
  "$d = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sovereign.lnk'));" ^
  "$d.TargetPath = 'wscript.exe'; $d.Arguments = '\"' + $vbs + '\" open'; $d.WorkingDirectory = '%~dp0'; $d.IconLocation = $icon + ',0'; $d.Description = 'Open Sovereign (starts it if needed)'; $d.Save()"
if errorlevel 1 (
  echo Could not create the shortcuts -- start it with start-all.bat instead.
)

start "" wscript.exe "%~dp0scripts\start-hidden.vbs" open

echo.
echo ==============================================
echo   Done. Sovereign now runs in the background
echo   ^(no windows^) and starts with Windows by itself.
echo.
echo   Website:  http://localhost:3001  ^(opening now^)
echo   Desktop:  "Sovereign" shortcut opens it
echo   Logs:     logs\website.log, logs\bot.log
echo   Stop:     stop-all.bat     Remove:  uninstall.bat
echo ==============================================
echo.
echo This window closes in 15 seconds.
ping -n 16 127.0.0.1 >nul
exit /b 0

:failed
echo.
echo Installing packages failed -- see the messages above ^(internet connection?^).
pause
exit /b 1
