@echo off
REM Rebuilds "Install Sovereign.exe" (repo root) from Launcher.cs with
REM the icon from assets\sovereign.ico. Uses the C# compiler that comes
REM with Windows (.NET Framework 4).
cd /d "%~dp0.."
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
"%CSC%" /nologo /target:exe /optimize+ /win32icon:assets\sovereign.ico /out:"Install Sovereign.exe" installer\Launcher.cs
