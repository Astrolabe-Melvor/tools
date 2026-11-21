@echo off
cd /d "%~dp0"
node build-wiki.js
echo.
echo Open dist\wiki through a web server (browsers block fetch from file://).
echo Quick test: npx serve dist\wiki   or   python -m http.server -d dist\wiki
pause
