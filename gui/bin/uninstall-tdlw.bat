@echo off
title tdlw uninstaller
setlocal

set "BIN_DIR=%USERPROFILE%\bin"

echo ==============================================
echo   tdlw shortcut uninstaller
echo ==============================================

rem stop the running server first so no stale process holds the tdl database
if exist "%BIN_DIR%\tdlw-stop.vbs" (
  echo [1/3] Stopping the running server...
  wscript //nologo "%BIN_DIR%\tdlw-stop.vbs"
) else (
  echo [1/3] Stop script not found, cleaning processes directly...
  taskkill /F /IM tdl.exe >nul 2>nul
)

echo [2/3] Removing shortcut files...
for %%F in (tdlw.vbs tblw.vbs tdlw-stop.vbs tdlw.path) do (
  if exist "%BIN_DIR%\%%F" (
    del /f /q "%BIN_DIR%\%%F" >nul && echo       removed %%F
  )
)

echo [3/3] PATH cleanup...
echo %PATH% | find /i "%BIN_DIR%" >nul
if not errorlevel 1 (
  echo       [NOTE] %BIN_DIR% is still on PATH.
  echo       It may hold other tools, so it was not removed automatically.
  echo       To remove it: System Properties - Environment Variables - user Path.
)

echo.
echo [OK] tdlw uninstalled. The GUI itself and your downloads are untouched.
echo.
pause
