# iOS App

iOS port of Joymixa Bridge. Swift + Network.framework for the WebSocket server,
LinkKit for Ableton Link.

**Status:** Steps 1-2 of 6 complete (empty app + WebSocket server, no Link yet).

## Build

Builds via GitHub Actions on macOS runners — no local macOS machine needed.
The `.ipa` is exported unsigned and sideloaded onto iPad via Sideloader on Linux.

Two build variants via CI matrix:

| Variant | Flag | Game | Artifact |
|---------|------|------|----------|
| `bridgeOnly` | (none) | No game | `LinkBridge-bridgeOnly-unsigned.ipa` |
| `bundle` | `INCLUDE_GAME` | Embedded game in WKWebView | `LinkBridge-bundle-unsigned.ipa` |

```bash
# CI builds on push to ios/ or scripts/ — see .github/workflows/build-ios.yml
# Download the artifact from GitHub Actions, then:
# Sign with Sideloader on Linux and install on device
```

Build commands (used in CI):
```bash
# bridgeOnly
xcodebuild -project LinkBridge.xcodeproj \
  -scheme LinkBridge \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/LinkBridge-bridgeOnly.xcarchive \
  archive \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ALLOWED=NO

# bundle (with game)
xcodebuild -project LinkBridge.xcodeproj \
  -scheme LinkBridge \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/LinkBridge-bundle.xcarchive \
  archive \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ALLOWED=NO \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) INCLUDE_GAME'
```

## Build variants

Game support uses Swift conditional compilation (`#if INCLUDE_GAME`):
- `bridgeOnly`: `INCLUDE_GAME` not defined — no game button, no WebView
- `bundle`: `INCLUDE_GAME` defined via `SWIFT_ACTIVE_COMPILATION_CONDITIONS` — shows "Launch Game" button, opens full-screen WKWebView

Game assets are bundled at `LinkBridge/GameAssets/` (folder reference in Xcode project). For `bridgeOnly` builds, this folder doesn't exist on disk — Xcode logs a warning but doesn't fail.

## Architecture

- **`App.swift`** — App lifecycle + `ContentView` with conditional `#if INCLUDE_GAME` game button
- **`WebSocketServer.swift`** — `NWListener`-based WS server on port 20809
- **`GameWebView.swift`** — `UIViewRepresentable` wrapping `WKWebView` for the game

Planned (not yet implemented):
- **`BridgeService.swift`** — Core orchestrator: Link + WebSocket + 20Hz state broadcast
- **`LinkManager.swift`** — Wraps LinkKit/ABLLink C API

## Game WebView (bundle variant)

`GameWebView.swift` loads the game from `GameAssets/index.html` using `WKWebView.loadFileURL()`.

Key WKWebView settings:
- `allowsInlineMediaPlayback = true` — game uses Tone.js audio
- `mediaTypesRequiringUserActionForPlayback = []` — auto-play audio
- `allowFileAccessFromFileURLs = true` — local file loading
- `allowUniversalAccessFromFileURLs = true` — cross-origin from file://
- `scrollView.isScrollEnabled = false` — game manages its own viewport

`NSAppTransportSecurity > NSAllowsLocalNetworking` in `Info.plist` allows the game to connect to the local bridge via WebSocket.

## Constraints

- Swift, targeting iOS 16+
- `Network.framework` (`NWListener` + `NWProtocolWebSocket`) — no external deps for WS
- [LinkKit](https://github.com/Ableton/LinkKit) for Ableton Link (to be added)
- Audio background mode with silent playback to keep the app alive when backgrounded
- Local network permission required (`NSLocalNetworkUsageDescription` in Info.plist)

## Protocol

Implements the same WebSocket protocol as desktop and Android: [docs/protocol.md](protocol.md).

## Implementation plan

6 incremental steps, each independently buildable:

1. Empty iOS app + CI workflow
2. WebSocket server (NWListener, no Link)
3. Bridge protocol (hello, state broadcast, client commands)
4. LinkKit integration (peer discovery, tempo/transport sync)
5. Background execution (silent audio session)
6. Status UI
