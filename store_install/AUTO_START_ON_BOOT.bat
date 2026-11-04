@echo off
setlocal
title Enable Auto-Start on Windows Boot - Store PC

echo ===============================================================================
echo          SAI TRADERS - CONFIGURE AUTO-START ON STORE PC BOOT
echo ===============================================================================
echo.

set SCRIPT_DIR=%~dp0
set LAUNCHER=%SCRIPT_DIR%START_STORE_PC.bat
set VBS_SCRIPT=%SCRIPT_DIR%run_silent.vbs
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo Target Directory: %SCRIPT_DIR%
echo Startup Folder : %STARTUP_FOLDER%
echo.

:: 1. Create silent VBScript launcher
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_SCRIPT%"
echo WshShell.CurrentDirectory = "%SCRIPT_DIR%" >> "%VBS_SCRIPT%"
echo WshShell.Run "cmd /c ""%LAUNCHER%""", 0, False >> "%VBS_SCRIPT%"

:: 2. Place shortcut in Windows Startup directory
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\CreateStoreShortcut.vbs"
echo sLinkFile = "%STARTUP_FOLDER%\SaiTradersStoreSync.lnk" >> "%TEMP%\CreateStoreShortcut.vbs"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\CreateStoreShortcut.vbs"
echo oLink.TargetPath = "wscript.exe" >> "%TEMP%\CreateStoreShortcut.vbs"
echo oLink.Arguments = """" ^& "%VBS_SCRIPT%" ^& """" >> "%TEMP%\CreateStoreShortcut.vbs"
echo oLink.WorkingDirectory = "%SCRIPT_DIR%" >> "%TEMP%\CreateStoreShortcut.vbs"
echo oLink.Description = "Sai Traders In-Store ERP Gateway and Sync Agent" >> "%TEMP%\CreateStoreShortcut.vbs"
echo oLink.Save >> "%TEMP%\CreateStoreShortcut.vbs"

cscript //nologo "%TEMP%\CreateStoreShortcut.vbs"
del "%TEMP%\CreateStoreShortcut.vbs" >nul 2>&1

echo.
echo ===============================================================================
echo [SUCCESS] Auto-start configured successfully!
echo The Store PC sync agent will now start automatically in the background
echo whenever this computer is turned on.
echo.
echo To disable auto-start in the future, delete:
echo "%STARTUP_FOLDER%\SaiTradersStoreSync.lnk"
echo ===============================================================================
echo.
pause
