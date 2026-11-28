@echo off
REM Stops Sovereign and removes its startup and desktop shortcuts.
REM Leaves the code, packages and .env files in place (install.bat sets it up again).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-procs.ps1" -Stop
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Sovereign.lnk" 2>nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Sovereign bot.lnk" 2>nul
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do del "%%D\Sovereign.lnk" 2>nul
echo Sovereign stopped; it will no longer start with Windows.
pause
