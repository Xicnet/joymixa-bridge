# iOS App

iOS port of the Ableton Link WebSocket bridge. Swift + Network.framework for the WebSocket server,
LinkKit for Ableton Link.

**Status:** Steps 1-2 of 6 complete (empty app + WebSocket server, no Link yet).

## Build

Builds via GitHub Actions on macOS runners — no local macOS machine needed.
The `.ipa` is exported unsigned and sideloaded onto iPad via Sideloader on Linux.

Two build variants via CI matrix:

| Variant | Flag | Game | Artifact |
|---------|------|------|----------|
| `bridgeOnly` | (none) | No game | `LinkBridge-bridgeOnly-unsigned.ipa` |
| `bundle` | `INCLUDE_GAME` | Embedded web app in WKWebView | `LinkBridge-bundle-unsigned.ipa` |

```bash
# CI builds on push to ios/ or scripts/ — see .github/workflows/build-ios.yml

# bridgeOnly
xcodebuild -project LinkBridge.xcodeproj \
  -scheme LinkBridge -sdk iphoneos -configuration Release \
  -archivePath build/LinkBridge-bridgeOnly.xcarchive archive \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO

# bundle (with web app)
xcodebuild -project LinkBridge.xcodeproj \
  -scheme LinkBridge -sdk iphoneos -configuration Release \
  -archivePath build/LinkBridge-bundle.xcarchive archive \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) INCLUDE_GAME'
```

## Build variants

Game support uses Swift conditional compilation (`#if INCLUDE_GAME`):
- `bridgeOnly`: no game button, no WebView
- `bundle`: shows "Launch Game" button, opens full-screen WKWebView loading local assets

Game assets are bundled at `LinkBridge/GameAssets/` (folder reference in Xcode project). For `bridgeOnly` builds, this folder doesn't exist on disk — Xcode logs a warning but doesn't fail.

## Architecture

- **`App.swift`** — App lifecycle + `ContentView` with conditional `#if INCLUDE_GAME` game button
- **`WebSocketServer.swift`** — `NWListener`-based WS server on port 20809
- **`GameWebView.swift`** — `UIViewRepresentable` wrapping `WKWebView` for the web app

Planned (not yet implemented):
- **`BridgeService.swift`** — Core orchestrator: Link + WebSocket + 20Hz state broadcast
- **`LinkManager.swift`** — Wraps LinkKit/ABLLink C API

## Constraints

- Swift, targeting iOS 16+
- `Network.framework` (`NWListener` + `NWProtocolWebSocket`) — no external deps for WS
- [LinkKit](https://github.com/Ableton/LinkKit) for Ableton Link (to be added)
- Audio background mode with silent playback to keep the app alive when backgrounded
- Local network permission required (`NSLocalNetworkUsageDescription` in Info.plist)
- `NSAppTransportSecurity > NSAllowsLocalNetworking` for `ws://localhost` from WebView

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
