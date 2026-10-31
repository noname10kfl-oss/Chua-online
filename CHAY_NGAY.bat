@echo off
setlocal
cd /d "%~dp0"
title CHUA ONLINE SERVER

set "NODE_CMD="
if exist "%~dp0bin\node.exe" (
    set "NODE_CMD=%~dp0bin\node.exe"
) else (
    where node >nul 2>&1
    if %ERRORLEVEL% EQU 0 set "NODE_CMD=node"
)

if "%NODE_CMD%"=="" (
    echo [ERROR] Khong tim thay Node.js trong bin\node.exe hoac he thong!
    echo Vui long kiem tra lai thu muc giai nen.
    pause
    exit /b 1
)

"%NODE_CMD%" "%~dp0launcher.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Server bi dung voi ma loi %ERRORLEVEL%!
    pause
)