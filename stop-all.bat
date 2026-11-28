@echo off
REM Stops the website and the bot (only this folder's -- Capital Records'
REM are left alone). They start again at the next Windows sign-in, or with
REM start-all.bat / the desktop shortcut.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-procs.ps1" -Stop
ping -n 4 127.0.0.1 >nul
