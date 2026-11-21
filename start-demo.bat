@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 24 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
node start-demo.mjs
if errorlevel 1 pause
