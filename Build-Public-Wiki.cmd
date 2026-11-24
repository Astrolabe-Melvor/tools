@echo off
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
"%NODE%" --version >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
"%NODE%" build-wiki.js
echo.
echo Open dist\wiki through a web server (browsers block fetch from file://).
echo Quick test: npx serve dist\wiki   or   python -m http.server -d dist\wiki
pause
