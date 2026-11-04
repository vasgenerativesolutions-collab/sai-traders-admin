@echo off
title Sai Traders — Cloudflare Staging Gateway Tunnel
color 0B
cd /d "%~dp0.."
echo ===============================================================================
echo            SAI TRADERS - CLOUDFLARE STAGING GATEWAY TUNNEL
echo ===============================================================================
echo.
echo Starting secure Cloudflare Tunnel to http://localhost:3000 ...
echo Public HTTPS URL will be displayed below.
echo.
scripts\cloudflared.exe tunnel --url http://localhost:3000
pause
