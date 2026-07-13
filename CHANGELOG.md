# Changelog

## 1.9.0 — 2026-07-13

### Added
- Auto-update on macOS and Windows via GitHub Releases (update-electron-app).
  Installs of 1.8.x and older contain no updater — download this release manually
  once; updates are automatic from here on. Linux updates via the distro package.

### Changed
- Packages no longer ship the Ableton Link C++ SDK sources and compiler
  intermediates (~25 MB of build-time debris removed from every platform).

### Removed
- The numeric "starts in Ns" count-in line. The phase bar already animates the
  count-in to the next quantum boundary, which is the indication Ableton's
  guidelines recommend.

## 1.8.0 — 2026-07-13

### Added
- macOS builds are now signed (Developer ID) and notarized, with the ticket stapled.
  First launch is clean — no more "app is damaged and can't be opened", no `xattr`
  workaround.
- macOS: DMG installer (mount, drag to Applications) alongside the .zip.
- macOS: menu-bar Template tray icon that adapts to light/dark menu bars.
- Quantum-driven phase bar replacing the four hardcoded beat LEDs — correct at any
  quantum, not just 4/4.
- Count-in readout ("starts in 1.2s") while transport is stopped.
- Peer join/leave desktop notifications.
- Link status badge now reflects the real session state ("Enabled"/"Disabled").
- Status panel anchors to the tray icon and is sized to its content.
- "Copy Diagnostics" moved to the tray context menu.

### Changed
- Status panel rethemed with the Joymixa design tokens; follows the OS dark/light mode.
- About dialog rewritten to explain why the Bridge exists; license statement corrected
  to GPL-2.0-or-later with a proper source offer.
- Android: real logo for launcher and notification icons (replaced placeholder circles).

### Fixed
- A failed Link session or an occupied port 20809 now shows an error dialog instead of
  a silent dead bridge or an uncaught exception; a second instance can no longer create
  a duplicate Link peer.
- WebSocket handshakes from disallowed web origins are rejected (anti-CSRF for the
  local bridge).
- Renderer hardened with a CSP and navigation guards; IPC surface fully typed.
- Packaged app's root LICENSE is ours (GPLv2), not Electron's MIT.
- macOS bundle identity (`com.joymixa.bridge`) and the Local Network usage description
  required for Link peer discovery on macOS 15+.

## 1.6.1 — 2026-05-20 (and earlier)

### Added
- Windows desktop builds via GitHub Actions `windows-latest` (Squirrel installer).
- WASAPI native audio output latency measurement via NAPI addon
  (`native/wasapi-latency/`), enabling Tier 1 sync compensation on Windows.
- README guide: Bonjour install, SmartScreen workflow, log inspection.

## 1.0.0

Initial release.

- Ableton Link integration via native addon — joins UDP multicast mesh, syncs tempo/transport/phase
- WebSocket server on port 20809 — broadcasts Link state at 20Hz to connected browsers
- Bidirectional sync — browsers can set tempo, start/stop transport
- Relay mechanism — app-level messages (soundbank selection) forwarded between clients
- Joymixa loop beat relay (`jmxBeat`) — enables loop position snap for joining clients
- System tray app with status window — shows Link peers, BPM, transport, connected clients
- Cross-platform: Linux (.deb, .rpm), macOS (.zip), Windows (Squirrel installer)
- Electron security hardening (context isolation, ASAR-only, fuses)
