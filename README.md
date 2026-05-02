# Joymixa Bridge

Bridges [Ableton Link](https://www.ableton.com/en/link/) to web apps over WebSocket. Syncs BPM, transport (play/pause), beat phase, and relays messages between connected clients on the same LAN.

Built for [Joymixa](https://joymixa.com), but the protocol is generic — any browser-based music app can connect.

## What It Does

```
                                UDP multicast
Ableton Live / Link peers  <===================>  Joymixa Bridge
                                Link protocol       (this app)
                                                     port 20809
                                                        |
                                            WebSocket   |   WebSocket
                                       +----------------+----------------+
                                       |                                 |
                                  Browser A                         Browser B
```

- Joins the Ableton Link mesh via UDP multicast (auto-discovers DAWs on the network)
- Exposes a WebSocket server on port `20809` (listens on all interfaces)
- Broadcasts Link state to connected clients at 20Hz: tempo, beat, phase, transport, peer count
- Accepts commands from clients: `set-tempo`, `play`, `stop`, `relay`
- Relays arbitrary messages between clients (e.g. for app-level coordination)
- Runs as a **system tray app** — click the tray icon to see status and connection URL

## Platforms

| Platform | Location | Tech | Status |
|----------|----------|------|--------|
| Desktop | `src/` | Electron + TypeScript | Stable |
| Android | `android/` | Kotlin + NDK (C++ JNI) | Stable |
| iOS | `ios/` | Swift + Network.framework | Early (WS server only, no Link yet) |

Android and iOS also support a **bundle** variant that embeds a web app alongside the bridge. See [docs/game-bundle.md](docs/game-bundle.md).

## Prerequisites

- **Node.js** 20.x
- **Python 3** (for node-gyp native compilation)
- **C++ build tools**: `build-essential` on Ubuntu/Debian, Xcode CLI tools on macOS
- **Avahi** (Linux): `sudo apt install libavahi-compat-libdnssd-dev` (for Link's mDNS discovery)

## Setup

### 1. Install dependencies

The bridge depends on `@ktamas77/abletonlink`, a Node.js native addon wrapping the Ableton Link C++ SDK. We use a [patched fork](https://github.com/Xicnet/ableton-link) that fixes a cross-platform build bug in the upstream package (hardcoded `LINK_PLATFORM_MACOSX=1` global define breaks Linux/Windows builds). The C++ SDK is vendored in the fork (no submodules).

```bash
yarn install
```

The native addon compiles from source during install (requires C++ toolchain).

### 2. Rebuild native addon for Electron

The native addon must be compiled against Electron's Node.js headers, not the system Node:

```bash
yarn rebuild
```

This runs `electron-rebuild -f -w @ktamas77/abletonlink`.

### 3. Fix Electron sandbox (Linux only)

Electron requires the Chrome sandbox binary to be SUID root. After every `yarn install` that updates Electron:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Running

```bash
# Development (with hot reload)
yarn start

# Package for distribution
yarn package

# Build installer (.deb, .rpm, .zip, .squirrel)
yarn make
```

## WebSocket Protocol

Full spec: [docs/protocol.md](docs/protocol.md)

### Server -> Client

| Message | Fields | Frequency |
|---------|--------|-----------|
| `hello` | `tempo, isPlaying, beat, phase, quantum, numPeers, numClients` | Once on connect |
| `state` | Same as hello + `ts` | 20Hz continuous |
| `tempo` | `tempo, beat, phase, quantum` | On Link tempo change |
| `playing` | `isPlaying` | On Link transport change |
| `peers` | `numPeers` | On Link peer count change |
| `relay` | `payload: {...}` | Forwarded from other clients |

### Client -> Server

| Message | Fields | Effect |
|---------|--------|--------|
| `set-tempo` | `tempo: number` | Sets Link tempo |
| `play` | -- | Starts Link transport |
| `stop` | -- | Stops Link transport |
| `relay` | `payload: {...}` | Forwards to all other clients |
| `request-quantized-start` | `quantum?: number` | Starts at next quantum boundary |
| `force-beat-at-time` | `beat, time, quantum` | Forces beat alignment |

## Project Structure

```
src/
  index.ts        Main process -- tray, window, IPC, bridge lifecycle
  bridge.ts       Ableton Link + WebSocket server (core logic)
  preload.ts      Context bridge (IPC exposed to renderer)
  renderer.ts     Status window UI logic
  index.html      Status window markup
  index.css       Status window styles
```

## Configuration

Default values in `bridge.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | 20809 | WebSocket server port |
| `defaultBpm` | 120 | Initial tempo before any Link peer connects |
| `quantum` | 4 | Beat subdivision (4 = one bar in 4/4) |
| `stateHz` | 20 | State broadcast frequency |

## Platform Notes

### Linux
- Avahi must be installed for Link's Bonjour/mDNS peer discovery
- Tested on Ubuntu 24.04 with Node.js 20.x

### macOS
- Dock icon is hidden (tray-only app)
- Set "Open at Login" from the tray menu context

### Windows

**Audio sync requires Apple's Bonjour service** for Ableton Link peer discovery (mDNS/DNS-SD).
Windows does not ship Bonjour by default. Install via one of:

- **iTunes** (already includes Bonjour) — most users have it.
- **Bonjour Print Services for Windows** — standalone installer from Apple's support site.

Without Bonjour, the bridge runs fine but won't see other Link peers on the LAN.

**First-run SmartScreen prompt:** Windows builds are currently **unsigned** (code
signing track is separate). On first launch, Windows SmartScreen will show
"Windows protected your PC". Click **More info → Run anyway**. Signed builds are on
the roadmap.

**Verifying audio latency measurement:** open the bridge tray icon → "Copy Logs". Look
for a line like:

```
[Bridge] Audio latency: platform=win32 measuredOutputLatency=21.3ms method=wasapi(period=10.00ms×2@48000Hz)
```

A healthy value is typically 20-40ms on internal speakers / wired output, 100-300ms on
Bluetooth. If you see `measurement failed` or values outside those ranges, file an
issue with the full log.

**Tray-only app:** like macOS, the Windows build runs in the system tray with no
visible window by default. Click the tray icon to open the status popup.

**Build details:** see [docs/windows-build.md](docs/windows-build.md) for how to
trigger a CI build manually (Actions tab → workflow_dispatch), download artifacts,
and the architecture decisions behind the WASAPI latency measurement.

## Troubleshooting

**Bridge starts but no Link peers found:**
- Ensure Ableton Live (or another Link app) is on the same network
- Check that UDP multicast is not blocked by firewall
- On Linux, verify Avahi is running: `systemctl status avahi-daemon`

**Windows: no peers found, but Ableton Live is running on the same LAN:**
- Check that Bonjour service is running: open Services.msc, find "Bonjour Service",
  start it if stopped.
- Check Windows Firewall isn't blocking UDP multicast on port 5353 (mDNS).
- Some corporate networks disable mDNS at the switch level — Link won't work there.

**Browser can't connect via WebSocket:**
- The bridge listens on `0.0.0.0:20809` -- ensure the port isn't blocked
- `ws://` from an HTTPS page is blocked by browsers for non-localhost addresses. Connect over HTTP, or use `ws://localhost:20809` from the same machine

**Native addon build fails:**
- Ensure `build-essential`, `python3`, and `node-gyp` are installed
- After `yarn install`, always run `yarn rebuild` to recompile for Electron

**Native addon build fails on Windows:**
- `windows-latest` GitHub Actions runners have everything pre-installed, but local
  builds need: Node 20+, Python 3, and Visual Studio Build Tools 2019 or later
  (with the "Desktop development with C++" workload).
- After Electron updates, run `yarn rebuild` to recompile against the new ABI.
- If `wasapi-latency` specifically fails, you're missing the Windows SDK headers
  (`mmdeviceapi.h`, `audioclient.h`). Reinstall Visual Studio Build Tools with the
  Windows 10/11 SDK component checked.

## Releasing

Builds are automated via GitHub Actions (`.github/workflows/build.yml`). Pushing a `v*` tag triggers the workflow which builds `.deb` + `.zip` (Linux) and `.zip` (macOS), then creates a GitHub Release with the artifacts.

```bash
./scripts/release.sh          # patch bump
./scripts/release.sh minor    # minor bump
./scripts/release.sh 1.5.0    # explicit version
```

## Related

- [Joymixa](https://joymixa.com) -- the music creation app that uses this bridge
- [Ableton Link](https://www.ableton.com/en/link/) -- the sync protocol
- [@ktamas77/abletonlink](https://github.com/ktamas77/ableton-link) -- Node.js bindings (upstream)
- [Xicnet/ableton-link](https://github.com/Xicnet/ableton-link) -- Patched fork with cross-platform build fix
