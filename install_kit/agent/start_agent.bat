@echo off
title Sai Traders — Tally Inventory Agent
color 0A
cd /d "%~dp0.."
echo ===============================================================================
echo            SAI TRADERS - AUTONOMOUS TALLY INVENTORY AGENT
echo ===============================================================================
echo.
node agent/index.js
pause
