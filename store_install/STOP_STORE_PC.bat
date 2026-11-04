@echo off
title Sai Traders - Stop Store PC Services

echo ===============================================================================
echo          SAI TRADERS - STOPPING IN-STORE GATEWAY AND TALLY SYNC
echo ===============================================================================
echo.

node scripts\stop_store_supervisor.js

echo.
echo [OK] All in-store services stopped cleanly.
echo.
pause
