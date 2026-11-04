@echo off
setlocal
title Sai Traders Bridge - Native In-Store Controller
cd /d "%~dp0"

echo ===============================================================================
echo          SAI TRADERS BRIDGE - IN-STORE TALLY GATEWAY & TELEMETRY
echo ===============================================================================
echo.
echo [1/2] Verifying Node.js and Electron runtime...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH. Please install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

echo [2/2] Launching Native Windows Bridge (System Tray + Telemetry Widget)...
npx electron desktop/main.js
