===============================================================================
               SAI TRADERS — ENTERPRISE WINDOWS APPLICATION KIT
===============================================================================

This package contains the Sai Traders Enterprise Standalone Windows Application
Installer (.exe), backend services, and autonomous launchers.

-------------------------------------------------------------------------------
1. RUNNING ON ANY OTHER WINDOWS PC (ZERO PREREQUISITES REQUIRED)
-------------------------------------------------------------------------------
The installer "Sai Traders Setup 1.0.0.exe" is 100% self-contained. 
Target PCs DO NOT need Node.js, Git, Python, or any developer tools installed!

Steps for any other Windows laptop / PC (Windows 10 / 11 / Server):
1. Copy "Sai Traders Setup 1.0.0.exe" to the other PC (via USB drive, 
   Google Drive, OneDrive, or LAN share).
2. Double-click "Sai Traders Setup 1.0.0.exe".
3. Follow the Windows Setup wizard (Next -> Install -> Finish).
4. A desktop shortcut "Sai Traders" and Start Menu entry will be created.
5. Double-click the "Sai Traders" desktop icon. 
   The application will launch immediately in its own native window with
   system tray support and real-time inventory management.

-------------------------------------------------------------------------------
2. MULTI-DEVICE / NETWORK SETUP (OPTIONAL)
-------------------------------------------------------------------------------
- If the other PC is in the same store/office on the same Wi-Fi/LAN:
  The app can connect to TallyPrime running on the main PC.
  Edit ".env" inside the installed folder (or resources\.env) and set:
  TALLY_URL=http://<MAIN_PC_LOCAL_IP>:9000
- If the other PC is offsite:
  The app can connect through the Cloudflare tunnel or cloud endpoint.

-------------------------------------------------------------------------------
3. DIRECTORY CONTENTS
-------------------------------------------------------------------------------
- Sai Traders Setup 1.0.0.exe : Standalone Windows setup installer.
- SAI_TRADERS_STOREFRONT_API_DOCUMENTATION.pdf : Full API documentation.
- desktop/                    : Electron native desktop application source.
- admin/                      : Backend server, Tally connector & dashboard.
- RUN_DESKTOP_APP.bat         : Quick launcher for developers.
- RUN_SAI_TRADERS.bat         : Server + Cloudflare tunnel launcher.
- .env.example                : Template configuration file.
===============================================================================
