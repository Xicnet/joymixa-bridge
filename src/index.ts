import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, dialog, shell, clipboard, Notification, screen } from 'electron';
import * as path from 'path';
import { updateElectronApp } from 'update-electron-app';
import { Bridge } from './bridge';
import type { BeatTick } from './ipc-types';
import { initGameBundle, setupGameProtocol, createGameWindow, hasGameAssets } from './game-window';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const GAME_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

/**
 * Auto-update from GitHub Releases via update.electronjs.org.
 *
 * Platform gate is ours, not the library's: update-electron-app supports only
 * Squirrel.Mac (consumes the released .zip; requires the build to be signed —
 * true since v1.8.1) and Squirrel.Windows (consumes RELEASES + .nupkg, which CI
 * already publishes). Linux updates through the distro package, so it is
 * excluded rather than left to the library to reject. `isPackaged` keeps dev
 * runs quiet.
 */
if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
  updateElectronApp();
}

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let bridge: Bridge | null = null;

// Privileged-scheme registration and Chromium switches must land before 'ready'.
// Unconditional: registering the app:// scheme is harmless in bridge-only mode.
initGameBundle();

/** Dev-mode game bundle: JOYMIXA_BUNDLE=1 opens the game window at launch. */
const bundleModeRequested = process.env.JOYMIXA_BUNDLE === '1';

function openGameWindow(): void {
  createGameWindow(GAME_WINDOW_PRELOAD_WEBPACK_ENTRY);
}

const APP_HOMEPAGE = 'https://joymixa.com';
const APP_REPO = 'https://github.com/Xicnet/joymixa-bridge';

function createTrayIcon(): Electron.NativeImage {
  // macOS wants a Template image: the glyph in pure black + alpha, no tile. The OS
  // then recolors it for light/dark menu bars and the highlighted state. Electron
  // marks it as a template automatically from the "Template" filename suffix, and
  // picks up the @2x variant beside it for retina.
  const fileNames = process.platform === 'darwin'
    ? ['tray-iconTemplate.png', 'tray-icon.png']
    : ['tray-icon.png'];
  // Try file-based PNG first (works reliably on Linux/i3bar)
  for (const name of fileNames) {
    const iconPaths = [
      path.join(__dirname, '..', '..', 'assets', name),  // dev
      path.join(process.resourcesPath || '', name),       // packaged
    ];
    for (const p of iconPaths) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  // Fallback: inline SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="80" fill="#ffffff"/>
    <circle cx="256" cy="256" r="200" fill="#000000"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

const PANEL_WIDTH = 360;
/** Sized to the content. The old 480 left a large dead area once the beat LEDs, the Copy
 *  Logs button and the ws:// URL were removed from the panel. */
const PANEL_HEIGHT = 320;
/** Gap between the panel and the screen edge / tray icon. */
const PANEL_MARGIN = 8;

/**
 * Position the panel against the tray icon, the way a menu-bar app behaves — rather than
 * letting it appear wherever the window manager feels like putting it.
 *
 * Platform split, and it is forced rather than chosen: `tray.getBounds()` is documented
 * `@platform darwin,win32` (electron.d.ts), so on Linux there is no way to ask where the
 * tray icon actually is. The fallback is the cursor: the panel is only ever opened by
 * clicking the tray icon, so the pointer is on it. That is an approximation, but a far
 * better one than the previous behaviour, which was no positioning at all.
 *
 * (`screen.getCursorScreenPoint()` and `win.setPosition()` carry no platform restriction,
 * so both halves work everywhere. Note the `menubar` package is NOT an option here — its
 * peer dependency caps at Electron <35 and we run 40.)
 *
 * Everything is clamped to the display's *work area*, not its full bounds, so the panel
 * cannot land under a taskbar/dock or off the edge of the screen.
 */
function positionPanelNearTray(win: BrowserWindow): void {
  const anchor = trayAnchorPoint();
  const display = screen.getDisplayNearestPoint(anchor);
  const area = display.workArea;

  // Centre horizontally on the anchor, then clamp inside the work area.
  let x = Math.round(anchor.x - PANEL_WIDTH / 2);
  x = Math.min(Math.max(x, area.x + PANEL_MARGIN), area.x + area.width - PANEL_WIDTH - PANEL_MARGIN);

  // Below the anchor if the tray sits at the top of the screen (macOS menu bar, top panel);
  // above it if the tray sits at the bottom (Windows taskbar, most Linux docks). Decide from
  // where the anchor actually is, rather than assuming per-platform.
  const anchorIsNearTop = anchor.y < area.y + area.height / 2;
  const y = anchorIsNearTop
    ? Math.min(anchor.y + PANEL_MARGIN, area.y + area.height - PANEL_HEIGHT - PANEL_MARGIN)
    : Math.max(anchor.y - PANEL_HEIGHT - PANEL_MARGIN, area.y + PANEL_MARGIN);

  win.setPosition(x, Math.round(y), false);
}

/** The point the panel should hang off: the tray icon's centre, or the cursor on Linux. */
function trayAnchorPoint(): Electron.Point {
  // getBounds() is darwin/win32 only. An empty rect is also possible if the tray is not
  // yet realised, so treat a zero-size rect as "unknown" rather than trusting it.
  if (tray && process.platform !== 'linux') {
    const b = tray.getBounds();
    if (b.width > 0 || b.height > 0) {
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    }
  }
  return screen.getCursorScreenPoint();
}

function createStatusWindow(): void {
  if (statusWindow && !statusWindow.isDestroyed()) {
    positionPanelNearTray(statusWindow);
    statusWindow.show();
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    show: false,
    // Pre-paint color while the page loads. Must match --bg in index.css (the
    // Joymixa theme tokens) for the active OS theme, or light mode flashes dark.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#222222' : '#eeeeee',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The status window is a fixed local page: it never navigates and never opens a window.
  // Defence in depth — contextIsolation, nodeIntegration:false and the Fuses already stand
  // between a compromised renderer and the system. But if anything ever did inject a link
  // or a script into this page, these two handlers are what stop it from navigating the
  // window to an attacker's origin (where it would inherit this window's privileges) or
  // spawning a new BrowserWindow. Deny both; route any legitimate external link through the
  // OS browser instead, which is how the About dialog already opens the homepage and repo.
  statusWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  statusWindow.webContents.on('will-navigate', (event, url) => {
    // The only load this window should ever perform is its own entry point.
    if (url !== MAIN_WINDOW_WEBPACK_ENTRY) {
      event.preventDefault();
      console.warn(`[bridge] blocked navigation attempt to: ${url}`);
    }
  });

  statusWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  statusWindow.once('ready-to-show', () => {
    if (!statusWindow) return;
    // Position before the first show, so the panel does not appear at the window manager's
    // default spot and then visibly jump to the tray.
    positionPanelNearTray(statusWindow);
    statusWindow.show();
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
      'Joymixa Bridge connects your browser to the Ableton Link session on your',
      'local network. Link syncs over UDP, which is native-app territory — so the',
      'Bridge joins the session on this computer and streams tempo, transport,',
      'and beat phase straight to Joymixa in your browser.',
      '',
      'Part of the Joymixa music creation platform.',
      '',
      `${APP_HOMEPAGE}`,
      '',
      'GPL-2.0-or-later — Copyright (c) 2026 Ramiro Augusto Cosentino (XicNET).',
      'Includes Ableton Link (GPLv2+), (c) Ableton AG.',
      `Source code: ${APP_REPO}`,
    ].join('\n'),
    buttons: ['OK', 'Open Website', 'View on GitHub'],
    defaultId: 0,
  });

  if (result === 1) shell.openExternal(APP_HOMEPAGE);
  if (result === 2) shell.openExternal(APP_REPO);
}

/**
 * Copy the log ring buffer to the clipboard, for a user reporting a problem.
 *
 * This lives in the tray menu rather than the status window: the window is a
 * glanceable readout of the Link session, and a debug button does not belong in
 * it. The tray menu is where desktop apps conventionally put diagnostics.
 *
 * A menu item gives no feedback of its own, so confirm the copy explicitly —
 * otherwise the user cannot tell it worked.
 */
function copyDiagnostics(): void {
  const logs = bridge?.getLogs() ?? '';
  if (!logs) {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Joymixa Bridge',
      message: 'No diagnostics available yet.',
      detail: 'The bridge has not logged anything to report.',
      buttons: ['OK'],
    });
    return;
  }

  clipboard.writeText(logs);
  dialog.showMessageBoxSync({
    type: 'info',
    title: 'Joymixa Bridge',
    message: 'Diagnostics copied to the clipboard.',
    detail: 'Paste them into your bug report or support message.',
    buttons: ['OK'],
  });
}

function setupTray(): void {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Joymixa Bridge');

  const contextMenu = Menu.buildFromTemplate([
    // Only offered when a game build has been copied in (scripts/copy-game-assets.sh) —
    // a plain bridge install has no game assets and must not show a dead entry.
    ...(hasGameAssets()
      ? [{ label: 'Open Joymixa', click: () => openGameWindow() }]
      : []),
    {
      label: 'Status Window',
      click: () => toggleStatusWindow(),
    },
    { type: 'separator' },
    {
      label: 'Copy Diagnostics',
      click: () => copyDiagnostics(),
    },
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

/**
 * Peer join/leave notifications — Ableton's Link UI guidelines call these mandatory.
 *
 * Link's callback reports the new *count*, never an identity or a delta, so a join and a
 * leave are only distinguishable by comparing against the previous count. The baseline is
 * seeded once from the count at startup (see the 'started' handler): peers already on the
 * mesh when we join are the session we walked into, not arrivals, and must not notify.
 * Seeding it there rather than on the first callback matters — starting alone and then
 * having someone join produces a first callback of 1, which IS a real join.
 *
 * A single callback can move the count by more than one (a peer with several Link-enabled
 * apps quits), so phrase the message from the delta rather than assuming ±1.
 */
let lastPeerCount: number | null = null;

function notifyPeerChange(numPeers: number): void {
  const previous = lastPeerCount;
  lastPeerCount = numPeers;

  if (previous === null || numPeers === previous) return;
  if (!Notification.isSupported()) return;

  const delta = numPeers - previous;
  const count = Math.abs(delta);
  const noun = count === 1 ? 'peer' : 'peers';

  let body: string;
  if (delta > 0) {
    body = `${count} Link ${noun} joined — ${numPeers} now in the session.`;
  } else if (numPeers === 0) {
    body = `${count} Link ${noun} left — no peers in the session.`;
  } else {
    body = `${count} Link ${noun} left — ${numPeers} still in the session.`;
  }

  new Notification({ title: 'Joymixa Bridge', body, silent: true }).show();
}

function setupIPC(): void {
  ipcMain.handle('get-state', () => {
    return bridge?.getState() ?? null;
  });

  ipcMain.handle('close-window', () => {
    statusWindow?.hide();
  });
}

const FATAL_ADVICE: Record<string, string> = {
  'port-in-use': 'Another copy of Joymixa Bridge — or another app — is already using it. Quit the other one and start the Bridge again.',
  'link-unavailable': 'This build of Joymixa Bridge is missing its Ableton Link component, or it does not match your system. Reinstalling the app should fix it.',
  'link-failed': "Joymixa Bridge can't reach Ableton Link, so it can't sync. Restarting the app may help.",
};

function showFatalError(reason: string, message: string): void {
  const advice = FATAL_ADVICE[reason] ?? FATAL_ADVICE['link-failed'];
  const detail = `${message}\n\n${advice}`;

  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Joymixa Bridge',
    message: 'Joymixa Bridge could not start.',
    detail,
    buttons: ['Quit'],
  });
  app.quit();
}

function startBridge(): void {
  bridge = new Bridge();

  // Baseline the peer count once Link is up, so the peers already on the mesh don't
  // arrive as a burst of "joined" notifications the moment we connect.
  bridge.on('started', () => {
    lastPeerCount = bridge?.getState()?.numPeers ?? 0;
    notifyRenderer();
  });

  bridge.on('peers', (numPeers: number) => {
    notifyPeerChange(numPeers);
    notifyRenderer();
  });
  bridge.on('tempo', () => notifyRenderer());
  bridge.on('playing', () => notifyRenderer());
  bridge.on('clients', () => notifyRenderer());
  bridge.on('tick', (tick: BeatTick) => {
    if (statusWindow && !statusWindow.isDestroyed() && !statusWindow.webContents.isDestroyed()) {
      statusWindow.webContents.send('beat-tick', tick);
    }
  });

  // Without this the app sits in the tray looking healthy with a dead bridge:
  // Link failures reject start()'s promise (which nothing awaited), and a
  // port collision surfaces asynchronously long after start() has returned.
  bridge.on('fatal', ({ reason, message }: { reason: string; message: string }) => {
    showFatalError(reason, message);
  });

  bridge.start().catch((e: unknown) => {
    showFatalError('link-failed', e instanceof Error ? e.message : String(e));
  });
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

// Only one Bridge may run: a second instance would race the first for port 20809
// and put a duplicate peer on the Link mesh. Hand focus back to the running copy.
// "Open at Login" makes an accidental double-launch easy, so this is not theoretical.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createStatusWindow();
  });

  app.on('ready', () => {
    setupGameProtocol();
    setupIPC();
    setupTray();
    startBridge();

    if (bundleModeRequested && hasGameAssets()) {
      // Bundle mode: the game IS the app — go straight to it, no status popup.
      openGameWindow();
    } else {
      // Show status window on first launch
      createStatusWindow();
    }
  });
}

app.on('window-all-closed', () => {
  // Don't quit — tray app stays running
});

app.on('before-quit', () => {
  bridge?.stop();
});
