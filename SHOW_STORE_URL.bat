@echo off
setlocal
title Sai Traders - Store Access URLs
cd /d "%~dp0"

echo Querying active store connection URLs...
node scripts\get_tunnel_url.js

echo.
pause
