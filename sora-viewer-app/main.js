'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs   = require('fs');
const url  = require('url');

// ── Custom protocol: sora-file:// ────────────────────────────────────────────
// Registered before app is ready so it is treated as privileged.
protocol.registerSchemesAsPrivileged([
  { scheme: 'sora-file', privileges: { standard: false, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

// ── Main window ──────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0d0d14',
    autoHideMenuBar: true,
    title: 'SORA Viewer',
    webPreferences: {
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
        : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Remove the default application menu entirely
  mainWindow.setMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Register protocol handler for local image serving
  protocol.handle('sora-file', (request) => {
    // sora-file:///C:/path/to/file.png  →  file:///C:/path/to/file.png
    const rawPath = request.url.slice('sora-file:///'.length);
    const decoded = decodeURIComponent(rawPath);
    // Reconstruct as a proper file:// URL
    const fileUrl = url.pathToFileURL(decoded).href;
    return net.fetch(fileUrl);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Open a native folder picker dialog
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select SORA Export Folder'
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// List directory contents: [{name, isDirectory}]
ipcMain.handle('fs:readdir', (_event, folderPath) => {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
});

// Read a text file (e.g. metadata.json)
ipcMain.handle('fs:readFile', (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

// Check whether a path exists
ipcMain.handle('fs:exists', (_event, filePath) => {
  return fs.existsSync(filePath);
});

// Auto-detect a SORA export folder
ipcMain.handle('fs:autoDetect', () => {
  const candidates = [
    path.dirname(app.getPath('exe')),
    app.getPath('downloads'),
    process.cwd()
  ];

  for (const base of candidates) {
    try {
      if (!fs.existsSync(base)) continue;
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Match folder names containing "SORA" (case-insensitive)
        if (/sora/i.test(entry.name)) {
          const full = path.join(base, entry.name);
          return full;
        }
      }
      // Also check if the base itself contains task-style subdirs
      const hasTaskSubdir = entries.some(
        e => e.isDirectory() && /\d{4}_task_/.test(e.name)
      );
      if (hasTaskSubdir) return base;
    } catch {
      // Skip unreadable paths
    }
  }

  return null;
});
