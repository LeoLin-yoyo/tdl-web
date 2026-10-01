@echo off
setlocal EnableDelayedExpansion
title tdlw installer

set "GUI_DIR=%~dp0.."
for %%I in ("%GUI_DIR%") do set "GUI_DIR=%%~fI"

set "BIN_DIR=%USERPROFILE%\bin"
set "TARGET=%BIN_DIR%\tdlw.vbs"
set "TARGET_STOP=%BIN_DIR%\tdlw-stop.vbs"

echo ==============================================
echo   tdlw shortcut installer
echo ==============================================
echo   GUI dir : %GUI_DIR%
echo   Install : %BIN_DIR%
echo.

if not exist "%GUI_DIR%\server.js" (
  echo [ERROR] %GUI_DIR%\server.js not found. Run this from gui\bin.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"

copy /y "%~dp0tdlw.vbs" "%TARGET%" >nul
if errorlevel 1 (echo [ERROR] failed to copy tdlw.vbs & pause & exit /b 1)
copy /y "%~dp0tdlw-stop.vbs" "%TARGET_STOP%" >nul
if errorlevel 1 (echo [ERROR] failed to copy tdlw-stop.vbs & pause & exit /b 1)

rem record the GUI directory next to the launcher so tdlw.vbs can find server.js
rem (nul redirect + <nul keeps the file free of a trailing newline)
> "%BIN_DIR%\tdlw.path" <nul set /p =%GUI_DIR%

rem make sure the install dir is on the user PATH
echo %PATH% | find /i "%BIN_DIR%" >nul
if errorlevel 1 (
  echo [INFO] Adding %BIN_DIR% to the user PATH...
  set "USER_PATH="
  for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| find /i "Path"') do set "USER_PATH=%%B"
  if defined USER_PATH (
    setx PATH "!USER_PATH!;%BIN_DIR%" >nul
  ) else (
    setx PATH "%BIN_DIR%" >nul
  )
  echo [INFO] Done. Open a NEW terminal for it to take effect.
)

rem first run needs dependencies
if not exist "%GUI_DIR%\node_modules\node-pty" (
  echo.
  echo [SETUP] Installing dependencies ^(node-pty^), this may take a few minutes...
  pushd "%GUI_DIR%"
  call npm install --no-audit --no-fund
  popd
  if not exist "%GUI_DIR%\node_modules\node-pty" (
    echo [ERROR] dependency install failed. Run "npm install" in the gui dir manually.
    pause
    exit /b 1
  )
)

echo.
echo [OK] Installed.
echo.
echo   start : tdlw        (runs silently in background, opens the browser)
echo   stop  : tdlw-stop   (stops the server and releases the tdl database lock)
echo   log   : %GUI_DIR%\data\server.log
echo   url   : http://127.0.0.1:8560
echo.
echo If "tdlw is not recognized", open a new terminal window.
echo.
pause
