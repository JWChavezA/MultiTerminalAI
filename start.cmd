@echo off
cd /d "%~dp0"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd no esta disponible en PATH.
  pause
  exit /b 1
)
npm.cmd run desktop
pause
