# Changelog

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
