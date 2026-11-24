@echo off
title Astrolabe Tools - Extract game data
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
"%NODE%" --version >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
"%NODE%" extract-data.js %*
explorer /select,"%~dp0data\MelvorBase.json"
pause
