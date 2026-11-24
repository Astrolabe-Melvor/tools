@echo off
setlocal
rem Builds dist\AstrolabeTools-<date>.zip: the tools plus a copy of node.exe, so people can run them without installing Node.
cd /d "%~dp0"
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy.MM.dd"') do set "VER=%%D"
set "OUT=%~dp0dist\AstrolabeTools"
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"

robocopy "%~dp0." "%OUT%" /E /NFL /NDL /NJH /NJS /NP ^
  /XD data dist node_modules .git .vs ^
  /XF autopilot* Autopilot* *.log Package.cmd Publish-Wiki.cmd >nul

for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%N"
if defined NODEEXE (copy /y "%NODEEXE%" "%OUT%\node.exe" >nul) else (echo node.exe not found: the zip will need Node installed.)

set "ZIP=%~dp0dist\AstrolabeTools-%VER%.zip"
if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%ZIP%'"
echo.
echo Built %ZIP%
echo People unzip it anywhere and run Start-MI2-Tools.cmd. Game data and images are read from their own game install.
if /i "%~1"=="nopause" exit /b 0
pause
