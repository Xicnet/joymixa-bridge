# Desktop App (Electron)

Electron tray app that bridges Ableton Link to browser clients over WebSocket.
Runs in the system tray — no visible window by default. Click the tray icon for
a status popup showing BPM, transport state, peers, and connected clients.

## Quick build

```bash
yarn install          # install deps + compile native C++ addon
yarn start            # dev mode with hot reload
yarn make             # build platform installers (.deb, .rpm, .zip, .exe)
```

If `yarn install` fails on the native addon, ensure you have a C++ toolchain installed.

### Linux sandbox fix

After Electron updates, Chrome's sandbox binary may lose its setuid bit:
```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

### Rebuild native addon

If you update Electron, rebuild the native addon against the new Node headers:
```bash
yarn rebuild          # runs electron-rebuild -f -w @xicnet/abletonlink
```

## Requirements

- **Node.js** + **yarn**
- **C++ toolchain** — needed to compile `@xicnet/abletonlink` native addon
- **Linux**: `libavahi-compat-libdnssd-dev` (mDNS/DNS-SD for Link peer discovery)
- **macOS/Windows**: Bonjour SDK (usually pre-installed)
- TypeScript ~5.7, ES6/CommonJS target

## Architecture

```
┌──────────────────────────────────────────┐
│  Electron Main Process (index.ts)        │
│  ├─ Tray icon + context menu             │
│  ├─ Status window (BrowserWindow, IPC)   │
│  └─ Bridge instance                      │
│     ├─ Ableton Link session              │
│     ├─ WebSocket server (:20809)         │
│     └─ 100Hz state broadcast loop        │
└──────────────────────────────────────────┘
```

## Source files

| File | Role |
|------|------|
| `src/index.ts` | Electron main process: tray icon, status window, IPC, app lifecycle |
| `src/bridge.ts` | `Bridge` class: Ableton Link session + WS server + 100Hz broadcast + client commands |
| `src/renderer.ts` | Status window renderer (receives state via IPC) |
| `src/preload.ts` | Preload script for renderer context bridge |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@xicnet/abletonlink` | Native C++ addon wrapping Ableton Link SDK (forked at `Xicnet/ableton-link`) |
| `ws` | WebSocket server |
| `electron` | Desktop shell |
| `electron-forge` | Build toolchain (webpack, makers for deb/rpm/zip/squirrel) |

## Protocol

Implements the WebSocket protocol documented in [docs/protocol.md](protocol.md).
Port 20809 (bound to `127.0.0.1`, loopback only), JSON messages, 100Hz broadcast rate.

## Build outputs

`yarn make` produces platform installers via Electron Forge:

| Platform | Maker | Output |
|----------|-------|--------|
| Linux | deb, rpm | `.deb` / `.rpm` packages |
| macOS | zip | `.zip` archive |
| Windows | squirrel | `.exe` installer |

Output directory: `out/make/`
