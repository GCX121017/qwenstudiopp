@echo off
title Qwen Studio++
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
node bin\cli.js %*
pause
exit /b 0

:NO_NODE
echo [X] Node.js not found. Please install it from https://nodejs.org
pause
exit /b 1
