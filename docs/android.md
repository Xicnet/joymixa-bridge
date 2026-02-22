# Android App

Native Android port of Joymixa Bridge with full protocol parity.
Kotlin + NDK (C++ JNI wrapping the Ableton Link SDK).

Runs as a foreground service with a persistent notification — Android's
equivalent of the desktop system tray icon.

## Quick build

```bash
git submodule update --init --recursive   # fetch Ableton Link SDK
cd android && ./gradlew assembleDebug     # builds APK (~5MB)
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

## Install & test

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s LinkJNI BridgeService       # verify Link + WS server
```

## Requirements

- Android SDK + NDK + CMake 3.22.1+ (auto-installed by Gradle on first build)
- Java 17 — no system Java installed, use Android Studio's bundled JBR:
  ```bash
  export JAVA_HOME=~/android-studio/jbr   # add to ~/.bashrc or ~/.zshrc
  ```
  Without this, `./gradlew` will fail with "JAVA_HOME is not set".
- `minSdk 26`, `targetSdk 34`, `compileSdk 34`

## Architecture

| Desktop (Electron) | Android |
|---|---|
| `bridge.ts` Bridge class | `BridgeService.kt` (Foreground Service) |
| `index.ts` main process | `MainActivity.kt` + `BridgeService.kt` |
| `renderer.ts` + HTML | `MainActivity.kt` + `activity_main.xml` |
| `@ktamas77/abletonlink` native addon | `LinkWrapper.cpp` JNI + Ableton Link C++ SDK |
| `ws` WebSocket server | `org.java-websocket:Java-WebSocket:1.5.6` |
| System tray icon | Foreground service persistent notification |

## Source files

5 Kotlin + 1 C++ (plus resources):

| File | Role |
|------|------|
| `BridgeService.kt` | Foreground service: Link + WS server + 20Hz state loop |
| `LinkSession.kt` | Kotlin wrapper over JNI native methods |
| `MainActivity.kt` | Status UI, binds to service, receives state broadcasts |
| `BridgeState.kt` | Data class + `toJson()` helper |
| `Utils.kt` | `getLocalIpAddress()`, `WS_PORT`, `getWsUrl()` |
| `cpp/jni/LinkWrapper.cpp` | JNI bridge to Ableton Link C++ SDK |

All Kotlin files at: `app/src/main/kotlin/com/xicnet/joymixabridge/`

## Ableton Link SDK

Git submodule at `app/src/main/cpp/link/` pointing to github.com/Ableton/link.

Key build notes:
- Uses `LINK_PLATFORM_LINUX=1` (Android is Linux to Link SDK — there is no `LINK_PLATFORM_ANDROID`)
- Uses `ASIO_STANDALONE=1` (no Boost dependency)
- Do NOT define `ASIO_NO_EXCEPTIONS` (requires custom throw handler, unnecessary with `c++_shared` STL)
- `ifaddrs.h` available natively since minSdk 26 (API 24+), no shim needed
- CMake config: `app/src/main/cpp/CMakeLists.txt`

## Protocol

Implements the full WebSocket protocol documented in [docs/protocol.md](protocol.md).
Same port (20809), same message format, same 20Hz broadcast rate.

## Android-specific details

- **Multicast lock**: Required for Ableton Link UDP multicast. Acquired in `BridgeService.onCreate()`.
- **Wake lock**: Keeps CPU active for 20Hz broadcast loop while backgrounded.
- **Foreground service**: `connectedDevice` type. Notification shows BPM, transport, peers, clients.
- **`START_STICKY`**: Service restarts if killed by system.
- **Thread safety**: WS callbacks are on Java-WebSocket thread pool, state loop on coroutine dispatcher. Client set guarded by `synchronized(clientsLock)`.

## Battery optimization

OEMs (Samsung, Xiaomi) aggressively kill background services.
Users must manually exempt: Settings > Battery > Joymixa Bridge > Don't optimize.
