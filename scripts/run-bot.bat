@echo off
REM The Discord bot (discord-bot\start-bot.bat, which restarts it by itself),
REM output to logs\bot.log. Started hidden by scripts\start-hidden.vbs.
cd /d "%~dp0.."
if not exist logs mkdir logs
for %%F in (logs\bot.log) do if %%~zF GTR 5000000 move /y logs\bot.log logs\bot.old.log >nul
set SOVEREIGN_HIDDEN=1
call discord-bot\start-bot.bat >> logs\bot.log 2>&1
