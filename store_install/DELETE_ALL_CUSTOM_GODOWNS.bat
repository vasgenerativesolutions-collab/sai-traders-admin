@echo off
setlocal
title Sai Traders - Delete All Custom Godowns from Tally
cd /d "%~dp0"

echo ===============================================================================
echo 🗑️  SAI TRADERS - TALLY ERP: CLEAR ALL CUSTOM GODOWNS
echo ===============================================================================
echo.
echo This utility will delete all custom godowns from TallyPrime:
echo  - Online_saree
echo  - Online
echo  - Sarees
echo  - Jari
echo  - Jari Sarees
echo.
echo ONLY "Main Location" (Tally Default) will remain.
echo.
echo Connecting to Tally on port 9000...
node scripts\delete_all_custom_godowns.js

echo.
pause

