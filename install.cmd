@echo off
title Qwen Studio++ Installer
setlocal

echo.
echo   ============================================
echo    Qwen Studio++ Setup for Windows
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

echo   [1/3] Node.js found:
node -v

where npm >nul 2>nul
if errorlevel 1 goto NO_NPM

echo   [2/3] Installing qwen-studio-pp globally ...
cd /d "%~dp0"
call npm install -g "%~dp0." --no-audit --no-fund
if errorlevel 1 goto INSTALL_FAIL

echo   [3/3] Verifying command ...
where qspp >nul 2>nul
if errorlevel 1 goto NOT_IN_PATH

echo.
echo   ============================================
echo    Install complete!
echo.
echo    From now on, in any terminal type:
echo        qspp
echo    then press Enter to start the service.
echo   ============================================
echo.
pause
exit /b 0

:NO_NODE
echo   [X] Node.js not found.
echo.
echo   Please install Node.js 18 or later first:
echo       https://nodejs.org/  - choose the LTS version
echo.
echo   Then run this script again.
pause
exit /b 1

:NO_NPM
echo   [X] npm not found. It is bundled with Node.js.
pause
exit /b 1

:INSTALL_FAIL
echo.
echo   [X] Install failed. Check the error messages above.
pause
exit /b 1

:NOT_IN_PATH
echo   [!] 'qspp' is not in PATH yet.
echo       Close this window, open a NEW terminal, then run: qspp
pause
exit /b 1
