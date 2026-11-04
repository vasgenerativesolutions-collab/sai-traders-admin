@echo off
title Sai Traders - TallyPrime Connection Diagnostic

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in system PATH!
    echo Please install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

node scripts\test_tally_quick.js

echo.
pause
