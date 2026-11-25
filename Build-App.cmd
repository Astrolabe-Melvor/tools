@echo off
rem Builds dist\Astrolabe.exe: the tools as one file (Node 20.12 or newer; downloads postject once through npx).
cd /d "%~dp0"
node build-app.js || (echo Build failed. & pause & exit /b 1)
if /i "%~1"=="nopause" exit /b 0
pause
