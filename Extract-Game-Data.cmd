@echo off
title Astrolabe Tools - Extract game data
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node extract-data.js %*
explorer /select,"%~dp0data\MelvorBase.json"
pause
