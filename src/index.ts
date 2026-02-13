import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { Bridge } from './bridge';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let bridge: Bridge | null = null;

const APP_HOMEPAGE = 'https://joymixa.com';
const APP_REPO = 'https://github.com/Xicnet/joymixa-bridge';

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function createTrayIcon(): Electron.NativeImage {
  // Try file-based PNG first (works reliably on Linux/i3bar)
  const iconPaths = [
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'),  // dev
    path.join(process.resourcesPath || '', 'tray-icon.png'),       // packaged
  ];
  for (const p of iconPaths) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  // Fallback: inline SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="80" fill="#ffffff"/>
    <circle cx="256" cy="256" r="200" fill="#1a1a2e"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createStatusWindow(): void {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 320,
    height: 260,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  statusWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  statusWindow.once('ready-to-show', () => {
    statusWindow?.show();
  });

  statusWindow.on('closed', () => {
    statusWindow = null;
  });
}

function toggleStatusWindow(): void {
  if (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible()) {
    statusWindow.hide();
  } else {
    createStatusWindow();
  }
}

function showAbout(): void {
  const version = app.getVersion();
  const result = dialog.showMessageBoxSync({
    type: 'info',
    title: 'About Joymixa Bridge',
    message: 'Joymixa Bridge',
    detail: [
      `Version ${version}`,
      '',
      'Bridges Ableton Link to browser-based Joymixa sessions over WebSocket.',
      'Syncs BPM, transport, beat phase, and relays messages between connected',
      'clients on the same local network.',
      '',
      'Part of the Joymixa music creation platform.',
      '',
      `${APP_HOMEPAGE}`,
      '',
      'MIT License — XicNET',
    ].join('\n'),
    buttons: ['OK', 'Open Website', 'View on GitHub'],
    defaultId: 0,
  });

  if (result === 1) shell.openExternal(APP_HOMEPAGE);
  if (result === 2) shell.openExternal(APP_REPO);
}

function setupTray(): void {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Joymixa Bridge');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Status Window',
      click: () => toggleStatusWindow(),
    },
    { type: 'separator' },
    {
      label: 'About Joymixa Bridge',
      click: () => showAbout(),
    },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          openAsHidden: true,
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    toggleStatusWindow();
  });
}

function setupIPC(): void {
  ipcMain.handle('get-state', () => {
    return bridge?.getState() ?? null;
  });

  ipcMain.handle('get-local-ip', () => {
    return getLocalIP();
  });

  ipcMain.handle('get-port', () => {
    return 20809;
  });

  ipcMain.handle('close-window', () => {
    statusWindow?.hide();
  });
}

function startBridge(): void {
  bridge = new Bridge();

  bridge.on('peers', () => notifyRenderer());
  bridge.on('tempo', () => notifyRenderer());
  bridge.on('playing', () => notifyRenderer());
  bridge.on('clients', () => notifyRenderer());

  bridge.start();
}

function notifyRenderer(): void {
  if (statusWindow && !statusWindow.isDestroyed() && !statusWindow.webContents.isDestroyed()) {
    statusWindow.webContents.send('bridge-update', bridge?.getState());
  }
}

// Hide dock icon on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}

app.on('ready', () => {
  setupIPC();
  setupTray();
  startBridge();

  // Show status window on first launch
  createStatusWindow();
});

app.on('window-all-closed', () => {
  // Don't quit — tray app stays running
});

app.on('before-quit', () => {
  bridge?.stop();
});
