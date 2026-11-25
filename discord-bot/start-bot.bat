@echo off
REM Double-click to update and start the Sovereign Discord bot.
REM Keeps the bot running: if it crashes or loses connection, it restarts.
REM Close this window (or press Ctrl+C) to stop it.

cd /d "%~dp0"
title Sovereign bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(version 18 or newer^).
  pause
  exit /b 1
)

if not exist ".env" (
  echo Missing discord-bot\.env -- copy it from the PC that hosted the bot before,
  echo or make one from .env.example. See README.md.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git not found -- skipping update, starting the code already here.
) else (
  echo Getting the latest code...
  git pull --ff-only || echo Could not update ^(no internet, or local changes^). Starting the code already here.
)

echo Installing packages...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo npm install failed -- see the messages above.
  pause
  exit /b 1
)

:run
echo.
echo Starting the bot -- %date% %time%
node index.js
echo.
echo The bot stopped. Restarting in 15 seconds... ^(close this window to stop for good^)
timeout /t 15 /nobreak >nul
goto run
