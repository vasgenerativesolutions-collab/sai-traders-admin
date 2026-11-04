@echo off
setlocal
title Enable Auto-Start on Windows Boot — Sai Traders

echo ===============================================================================
echo          SAI TRADERS — CONFIGURE AUTO-START ON WINDOWS BOOT
echo ===============================================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "LAUNCHER=%SCRIPT_DIR%RUN_SAI_TRADERS.bat"
set "VBS_SCRIPT=%SCRIPT_DIR%run_silent.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo Target Directory: %SCRIPT_DIR%
echo Startup Folder : %STARTUP_FOLDER%
echo.

:: 1. Create a silent VBScript launcher (runs without annoying black console window)
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_SCRIPT%"
echo WshShell.CurrentDirectory = "%SCRIPT_DIR%" >> "%VBS_SCRIPT%"
echo WshShell.Run "cmd /c ""%LAUNCHER%""", 0, False >> "%VBS_SCRIPT%"

:: 2. Place shortcut in Windows Startup directory
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\CreateShortcut.vbs"
echo sLinkFile = "%STARTUP_FOLDER%\SaiTradersAgent.lnk" >> "%TEMP%\CreateShortcut.vbs"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\CreateShortcut.vbs"
echo oLink.TargetPath = "wscript.exe" >> "%TEMP%\CreateShortcut.vbs"
echo oLink.Arguments = """" ^& "%VBS_SCRIPT%" ^& """" >> "%TEMP%\CreateShortcut.vbs"
echo oLink.WorkingDirectory = "%SCRIPT_DIR%" >> "%TEMP%\CreateShortcut.vbs"
echo oLink.Description = "Sai Traders Autonomous ERP and Storefront Agent" >> "%TEMP%\CreateShortcut.vbs"
echo oLink.Save >> "%TEMP%\CreateShortcut.vbs"

cscript //nologo "%TEMP%\CreateShortcut.vbs"
del "%TEMP%\CreateShortcut.vbs" >nul 2>&1

echo.
echo ===============================================================================
echo [SUCCESS] Auto-start configured successfully!
echo Sai Traders Agent will now start automatically whenever Windows boots up.
echo.
echo To disable auto-start in the future, simply delete:
echo "%STARTUP_FOLDER%\SaiTradersAgent.lnk"
echo ===============================================================================
echo.
pause
