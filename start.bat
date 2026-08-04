@echo off
setlocal

if /I "%~1"=="--console" goto run
start "Universal Import V2 - Port 3000" "%ComSpec%" /k call "%~f0" --console
exit /b 0

:run
title Universal Import V2 - Port 3000
cd /d "%~dp0"
set "NODE_OPTIONS="
set "NODE_EXE=C:\Users\65751\.workbuddy\binaries\node\versions\22.22.2\node.exe"

echo ============================================================
echo   Universal Import V2
echo   URL: http://localhost:3000
echo   Project: %CD%
echo   Press Ctrl+C or close this window to stop the service.
echo ============================================================
echo.

if not exist "%NODE_EXE%" (
  echo [ERROR] Managed Node.js was not found:
  echo         %NODE_EXE%
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\next\dist\bin\next" (
  echo [ERROR] Dependencies are missing. Run npm install first.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "node_modules\next\dist\bin\next" dev -p 3000
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [INFO] V2 service stopped with exit code %EXIT_CODE%.
echo You may close this window.
exit /b %EXIT_CODE%
