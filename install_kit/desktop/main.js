const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, Notification, ipcMain, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

// -----------------------------------------------------------------------------
// SAI TRADERS BRIDGE — NATIVE IN-STORE DESKTOP CONTROLLER
// Dedicated lightweight native Windows agent for the Store billing counter.
// Encrypted credentials via DPAPI, Leaky-Bucket Queue monitoring, System Tray.
// -----------------------------------------------------------------------------

// Single instance enforcement
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Bridge] Another instance is already running. Exiting redundant process.');
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let telemetryTimer = null;

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;

// -----------------------------------------------------------------------------
// 1. Hardware-Encrypted Credential Vault (Windows DPAPI)
// -----------------------------------------------------------------------------
function getVaultPath() {
  return path.join(app.getPath('userData'), 'bridge_vault.bin');
}

function saveSecureVault(data) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Vault] SafeStorage encryption not available on this platform.');
      return false;
    }
    const jsonStr = JSON.stringify(data);
    const encrypted = safeStorage.encryptString(jsonStr);
    fs.writeFileSync(getVaultPath(), encrypted);
    console.log('[Vault] Encrypted credentials stored securely via Windows DPAPI.');
    return true;
  } catch (err) {
    console.error('[Vault] Failed to save encrypted vault:', err.message);
    return false;
  }
}

function loadSecureVault() {
  try {
    const vaultPath = getVaultPath();
    if (!fs.existsSync(vaultPath) || !safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const buffer = fs.readFileSync(vaultPath);
    const decrypted = safeStorage.decryptString(buffer);
    return JSON.parse(decrypted);
  } catch (err) {
    console.warn('[Vault] Could not decrypt vault (possibly corrupted or new session):', err.message);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 2. Background Operations Server Check & Auto-Launcher
// -----------------------------------------------------------------------------
function isServerRunning(callback) {
  const req = http.get(`${SERVER_URL}/api/status`, (res) => {
    callback(res.statusCode === 200);
  });
  req.on('error', () => callback(false));
  req.setTimeout(1200, () => {
    req.destroy();
    callback(false);
  });
}

function ensureBackendRunning(onReady) {
  isServerRunning((running) => {
    if (running) {
      console.log('[Bridge] Internal operations core already active on port', PORT);
      onReady();
    } else {
      console.log('[Bridge] Starting internal operations core in-process...');
      try {
        require('../admin/server.js');
        let retries = 0;
        const poll = setInterval(() => {
          retries++;
          isServerRunning((isUp) => {
            if (isUp || retries > 30) {
              clearInterval(poll);
              onReady();
            }
          });
        }, 300);
      } catch (err) {
        console.error('[Bridge] Failed to boot internal server in-process:', err);
        onReady();
      }
    }
  });
}

// -----------------------------------------------------------------------------
// 3. Native Application Window (Full Operations & Store Console)
// -----------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    frame: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    backgroundColor: '#060913',
    title: 'Sai Traders Operations & Store Console',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Intercept close button to hide to tray (seamless in-store counter workflow)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: 'Sai Traders Console Minimized',
          body: 'Store synchronization is active in the Windows notification tray.'
        }).show();
      }
    }
  });

  setupSystemTray();
  startTelemetryLoop();
}

// -----------------------------------------------------------------------------
// 4. Native Windows System Tray Integration
// -----------------------------------------------------------------------------
function setupSystemTray() {
  if (tray) return;

  // Gold diamond / saree emblem SVG icon
  const iconSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="#080c14" stroke="#d97706" stroke-width="2"/>
      <polygon points="12,4 18,12 12,20 6,12" fill="#d97706"/>
      <circle cx="12" cy="12" r="3" fill="#10b981"/>
    </svg>`;
  const icon = nativeImage.createFromBuffer(Buffer.from(iconSvg));

  tray = new Tray(icon);
  tray.setToolTip('Sai Traders Operations — In-Store Tally Gateway');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🥻 Open Sai Traders Console',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '🌐 Open in Web Browser',
      click: () => {
        shell.openExternal(SERVER_URL);
      }
    },
    { type: 'separator' },
    {
      label: '🧪 Test Tally Connection (Port 9000)',
      click: () => {
        pollTelemetry();
        if (mainWindow) mainWindow.show();
      }
    },
    {
      label: '🚀 Start on Windows Boot',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath
        });
      }
    },
    { type: 'separator' },
    {
      label: '❌ Exit Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// -----------------------------------------------------------------------------
// 5. Live Telemetry Poller (Broadcasts to Renderer every 3s)
// -----------------------------------------------------------------------------
function pollTelemetry() {
  const req = http.get(`${SERVER_URL}/api/bridge-telemetry`, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(raw);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('telemetry:update', data);
        }
        // Update tray tooltip dynamically
        if (tray) {
          if (data.tally && data.tally.connected) {
            tray.setToolTip(`Sai Traders Bridge — Tally: ${data.tally.company || 'Active'} (${data.tally.latencyMs || 4}ms) | Godown: ${data.godown || 'Saree'}`);
          } else {
            tray.setToolTip(`Sai Traders Bridge — Tally: Waiting (Port 9000)`);
          }
        }
      } catch (_) {}
    });
  });
  req.on('error', () => {});
  req.setTimeout(2500, () => req.destroy());
}

function startTelemetryLoop() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  pollTelemetry();
  telemetryTimer = setInterval(pollTelemetry, 3000);
}

// -----------------------------------------------------------------------------
// 6. IPC Channels (UI Control & Settings)
// -----------------------------------------------------------------------------
ipcMain.on('app:hide', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('app:set-autostart', (_event, enable) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enable),
    path: process.execPath
  });
  console.log(`[Bridge] Windows Boot autostart set to: ${Boolean(enable)}`);
});

ipcMain.on('app:test-tally', () => {
  pollTelemetry();
});

// Single instance focus handler
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// -----------------------------------------------------------------------------
// 7. App Lifecycle Management
// -----------------------------------------------------------------------------
app.whenReady().then(() => {
  // Sync autostart checkbox default on fresh install if desired
  const settings = app.getLoginItemSettings();
  console.log(`[Bridge] Boot status: openAtLogin = ${settings.openAtLogin}`);

  ensureBackendRunning(() => {
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (telemetryTimer) clearInterval(telemetryTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
