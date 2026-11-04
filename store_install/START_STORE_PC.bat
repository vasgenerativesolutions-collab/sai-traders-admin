@echo off
setlocal enabledelayedexpansion
title Sai Traders - Store PC In-Store Gateway and Tally Sync

echo ===============================================================================
echo          SAI TRADERS - IN-STORE GATEWAY AND TALLY SYNC STORE PC
echo ===============================================================================
echo.

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

echo [CHECK 1/4] Checking Node.js runtime...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Node.js is not installed or not found in system PATH!
    echo Please install Node.js LTS version from https://nodejs.org
    echo After installing Node.js, restart this batch file.
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js runtime detected.
echo.

echo [CHECK 2/4] Checking environment configuration...
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [INFO] Initialized .env configuration file from template.
    )
)
echo [OK] Configuration file ready.
echo.

echo [CHECK 3/4] Checking dependencies...
if not exist node_modules (
    echo [INFO] Installing required lightweight packages - first-time only...
    call npm install --omit=dev
    echo [OK] Dependencies installed successfully.
) else (
    echo [OK] Dependencies present.
)
echo.

echo [CHECK 4/4] Testing local TallyPrime ERP connection on 127.0.0.1:9000...
node scripts\test_tally_quick.js
if %ERRORLEVEL% equ 0 (
    echo [OK] TallyPrime is ACTIVE and responding!
) else (
    echo [NOTICE] TallyPrime is not yet open on port 9000.
    echo In-store agent will continue running and automatically connect once Tally is opened.
)
echo.

echo [CLEANUP] Stopping any stale store services...
node scripts\stop_store_supervisor.js
echo.

echo [STARTING] Launching High-Availability Store Supervisor & Watchdog...
powershell -NoProfile -Command "Start-Process node -ArgumentList 'scripts\store_supervisor.js' -WindowStyle Hidden"

echo [INFO] Supervisor active. Waiting for services to initialize...
timeout /t 4 /nobreak >nul

echo [INFO] Resolving connection URLs (waiting up to 12s for tunnel)...
node scripts\get_tunnel_url.js

echo.
echo -------------------------------------------------------------------------------
echo  IN-STORE STATUS:
echo  - Local Tally ERP Gateway  : http://127.0.0.1:9000 (Active Godown)
echo  - Local Operations Core    : http://localhost:3000
echo  - High-Availability Engine : scripts\store_supervisor.js (Auto-Restart + Watchdog)
echo  - Log Rotation             : Capped at 10MB (Max 3 Archives)
echo  - Cloud Sync Engine        : Supabase Realtime (Orders and Inventory)
echo  - Execution Mode           : SUPERVISED BACKGROUND DAEMON
echo -------------------------------------------------------------------------------
echo.
echo [ACTIVE] Store PC is syncing orders and inventory in the background with watchdog.
echo [LAUNCH] Opening Sai Traders Console in default browser...
start http://localhost:3000
echo You can safely CLOSE or MINIMIZE this window anytime! Services stay running.
echo.
echo To shut down cleanly at end of day, run: STOP_STORE_PC.bat
echo ===============================================================================
echo.
pause
