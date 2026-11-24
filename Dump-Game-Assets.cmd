@echo off
title Astrolabe Tools - Dump game images
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
"%NODE%" --version >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
"%NODE%" dump-assets.js %*
pause
