@echo off
REM The website in a self-restarting loop, output to logs\website.log.
REM Started hidden by scripts\start-hidden.vbs.
cd /d "%~dp0.."
if not exist logs mkdir logs
:run
for %%F in (logs\website.log) do if %%~zF GTR 5000000 move /y logs\website.log logs\website.old.log >nul
echo [%date% %time%] starting the website >> logs\website.log
node --env-file-if-exists=.env server.js >> logs\website.log 2>&1
echo [%date% %time%] the website stopped -- restarting in 10 seconds >> logs\website.log
ping -n 11 127.0.0.1 >nul
goto run
