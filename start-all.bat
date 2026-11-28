@echo off
REM Starts the website and the bot in the background (no windows) if they
REM aren't running yet, then opens http://localhost:3001. Same as the
REM "Sovereign" desktop shortcut. Logs: logs\website.log, logs\bot.log.
start "" wscript.exe "%~dp0scripts\start-hidden.vbs" open
