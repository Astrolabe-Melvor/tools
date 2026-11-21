@echo off
rem Rebuilds the public wiki into the site repo clone next to this folder and pushes it to GitHub Pages.
rem One-time setup: git clone https://github.com/Astrolabe-Melvor/astrolabe-melvor.github.io ..\astrolabe-melvor.github.io
cd /d "%~dp0"
set "SITE=..\astrolabe-melvor.github.io"
if not exist "%SITE%\.git" (
  echo Clone the site repo first:
  echo   git clone https://github.com/Astrolabe-Melvor/astrolabe-melvor.github.io %SITE%
  pause
  exit /b 1
)
node build-wiki.js %SITE% || (pause & exit /b 1)
cd /d "%~dp0%SITE%"
if not exist .nojekyll type nul > .nojekyll
git add -A
git -c user.name=Elocrypt -c user.email=Elocrypt@users.noreply.github.com commit -m "Rebuild wiki from game data"
git push
echo.
echo Live in a minute or two at https://astrolabe-melvor.github.io/
pause
