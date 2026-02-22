# iOS App

iOS port of Joymixa Bridge. Swift + Network.framework for the WebSocket server,
LinkKit for Ableton Link.

**Status:** Steps 1-2 of 6 complete (empty app + WebSocket server, no Link yet).

## Build

Builds via GitHub Actions on macOS runners — no local macOS machine needed.
The `.ipa` is exported unsigned and sideloaded onto iPad via Sideloader on Linux.

```bash
# CI builds on push to ios/ — see .github/workflows/build-ios.yml
# Download the artifact from GitHub Actions, then:
# Sign with Sideloader on Linux and install on device
```

Build command (used in CI):
```
xcodebuild -project LinkBridge.xcodeproj \
  -scheme LinkBridge \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/LinkBridge.xcarchive \
  archive \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ALLOWED=NO
```

## Architecture

- **`App.swift`** — App lifecycle, audio session for background execution
- **`WebSocketServer.swift`** — `NWListener`-based WS server on port 20809

Planned (not yet implemented):
- **`BridgeService.swift`** — Core orchestrator: Link + WebSocket + 20Hz state broadcast
- **`LinkManager.swift`** — Wraps LinkKit/ABLLink C API

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
