@echo off
setlocal
title Sai Traders - Store PC Preflight Check
cd /d "%~dp0"

echo ===============================================================================
echo           SAI TRADERS - STORE PC PREFLIGHT CHECK
echo ===============================================================================
echo.
echo This reads your TallyPrime setup and reports what is ready and what is not.
echo It changes NOTHING and needs no passwords.
echo.
echo Before running: open TallyPrime and load your company.
echo.
pause

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Node.js is not installed.
    echo Install Node.js LTS from https://nodejs.org then run this again.
    echo.
    pause
    exit /b 1
)

node scripts\store_preflight.js

echo.
echo ===============================================================================
echo A full report was saved as: store_preflight_report.json
echo Send that file to KalpaCodes - it contains everything needed to diagnose.
echo ===============================================================================
echo.
pause
