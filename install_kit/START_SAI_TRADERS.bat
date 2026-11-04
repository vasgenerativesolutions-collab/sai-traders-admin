@echo off
setlocal
title Sai Traders - Store Operations Terminal
cd /d "%~dp0"

echo ===============================================================================
echo          SAI TRADERS - STORE OPERATIONS TERMINAL
echo ===============================================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
    )
)

if not exist node_modules (
    echo [INFO] Installing required dependencies...
    call npm install --omit=dev
)

echo [1/2] Starting local Operations Core on http://localhost:3000...
start /B node admin/server.js

timeout /t 3 /nobreak >nul

echo [2/2] Opening Sai Traders Console in default browser...
start http://localhost:3000

echo.
echo ===============================================================================
echo [ACTIVE] Sai Traders Store Console is active on http://localhost:3000
echo If connecting this device for the first time, your 6-character activation code
echo will appear on the browser screen. Enter that code on your Admin Laptop to pair!
echo ===============================================================================
echo.
pause

