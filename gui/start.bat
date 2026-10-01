@echo off
chcp 65001 >nul
title tdl Web GUI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18+：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\node-pty" (
  echo [初始化] 首次运行，安装依赖（node-pty）…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo ==============================================
echo   tdl Web GUI
echo   浏览器访问: http://127.0.0.1:8560
echo   Ctrl+C 停止服务
echo ==============================================
node server.js
pause
