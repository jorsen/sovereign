@echo off
REM Updates and starts the Sovereign Discord bot, restarting it if it crashes
REM or loses connection. Normally run hidden by install.bat's setup (output
REM in logs\bot.log); double-click it to run it in a window instead.

cd /d "%~dp0"
title Sovereign bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(version 22 or newer^).
  if not defined SOVEREIGN_HIDDEN pause
  exit /b 1
)

if not exist ".env" (
  echo Missing discord-bot\.env -- run install.bat, or make one from .env.example. See README.md.
  if not defined SOVEREIGN_HIDDEN pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git not found -- skipping update, starting the code already here.
) else (
  echo Getting the latest code...
  git pull --ff-only || echo Could not update ^(no internet, or local changes^). Starting the code already here.
)

REM The bot also uses the app's lib\ (screenshot reading), so both folders need packages.
echo Installing packages...
pushd ..
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  popd
  echo npm install failed in the app folder -- see the messages above.
  if not defined SOVEREIGN_HIDDEN pause
  exit /b 1
)
popd
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo npm install failed -- see the messages above.
  if not defined SOVEREIGN_HIDDEN pause
  exit /b 1
)

:run
echo.
echo Starting the bot -- %date% %time%
node index.js
echo.
echo The bot stopped. Restarting in 15 seconds...
ping -n 16 127.0.0.1 >nul
goto run
