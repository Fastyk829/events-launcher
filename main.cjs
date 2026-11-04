'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeImage } = require('electron');
const { join } = require('node:path');
const { autoUpdater } = require('electron-updater');
const { EventGameRuntime } = require('./src/main/game-runtime.cjs');
const { loadDefaultSteve } = require('./src/main/default-steve.cjs');
const { createLauncherUpdater } = require('./src/main/launcher-updater.cjs');

let runtime;
let launcherUpdater;

function createWindow() {
  const windowTitle = 'Events Launcher ' + app.getVersion();
  const window = new BrowserWindow({
    width: 1050, height: 620,
    title: windowTitle,
    icon: join(__dirname, 'assets', 'launcher.ico'),
    resizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#0c1018',
    webPreferences: {
      preload: join(__dirname, 'src', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // The HTML <title> would otherwise replace BrowserWindow's versioned title
  // as soon as Electron loads the renderer (including Vite reloads in dev).
  window.webContents.on('page-title-updated', (event) => event.preventDefault());
  // Restore the real app version after every page load, including dev reloads.
  // Preventing the HTML title event alone is not always sufficient on Windows.
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) {
      window.setTitle(windowTitle);
      window.show();
      window.focus();
    }
  });
  if (!app.isPackaged) void window.loadURL('http://127.0.0.1:5173');
  else void window.loadFile(join(__dirname, 'dist', 'renderer', 'index.html'));
  return window;
}

app.whenReady().then(async () => {
  // Hide Electron's default File / Edit / View / Window / Help menu bar.
  Menu.setApplicationMenu(null);
  if (process.platform !== 'win32') {
    console.warn('[events] Minecraft runtime currently supports Windows x64 only');
  }
  runtime = new EventGameRuntime((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('events:progress', state);
    }
  });
  ipcMain.handle('events:state', () => runtime.snapshot());
  ipcMain.handle('events:get-settings', () => runtime.getSettings());
  ipcMain.handle('events:save-settings', (_event, next) => runtime.saveSettings(next));
  ipcMain.handle('events:skins', () => runtime.skins.list());
  // The official Steve texture is read locally from the installed Minecraft JAR.
  ipcMain.handle('events:default-steve', () => loadDefaultSteve(runtime.minecraftRoot));
  ipcMain.handle('events:skin-add', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) throw new Error('Окно лаунчера недоступно');
    const result = await dialog.showOpenDialog(parent, {
      title: 'Добавить скин Minecraft',
      properties: ['openFile'],
      filters: [{ name: 'PNG-скин Minecraft', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePaths.length) return runtime.skins.list();
    return runtime.skins.importFile(result.filePaths[0], (data) => {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty() || image.getSize().width > 256 || image.getSize().height > 256) return false;
      return image.toPNG();
    });
  });
  ipcMain.handle('events:skin-select', (_event, id) => runtime.skins.select(id));
  ipcMain.handle('events:skin-model', (_event, id, model) => runtime.skins.setModel(id, model));
  ipcMain.handle('events:skin-remove', (_event, id) => runtime.skins.remove(id));
  ipcMain.handle('events:install', () => runtime.install());
  ipcMain.handle('events:install-pack', () => runtime.installPack());
  ipcMain.handle('events:launch', async (_event, nickname) => {
    await launcherUpdater.ensureCurrent();
    return runtime.launch(nickname);
  });
  ipcMain.handle('events:check-pack', () => runtime.checkPackUpdates());

  const notifyUpdate = (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('events:launcher-update', state);
    }
  };
  launcherUpdater = createLauncherUpdater(autoUpdater, notifyUpdate,
    app.isPackaged && process.platform === 'win32');
  ipcMain.handle('events:launcher-update-state', () => launcherUpdater.state());
  ipcMain.handle('events:launcher-update-download', () => launcherUpdater.retry());
  ipcMain.handle('events:launcher-update-install', () => launcherUpdater.install());
  await runtime.initialize();
  createWindow();

  // Check app releases and the modpack channel without delaying the UI.
  void launcherUpdater.check().catch((error) => console.warn('[updates]', error.message));
  void runtime.checkPackUpdates().catch((error) => console.warn('[modpack]', error.message));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => console.error('[events] startup failed', error));

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
