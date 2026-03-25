# Android App

Native Android port of the Ableton Link WebSocket bridge.
Kotlin + NDK (C++ JNI wrapping the Ableton Link SDK).

Runs as a foreground service with a persistent notification — Android's
equivalent of the desktop system tray icon.

## Quick build

```bash
git submodule update --init --recursive   # fetch Ableton Link SDK
export JAVA_HOME=~/android-studio/jbr
export ANDROID_HOME=~/Android/Sdk

cd android

# Bridge only (no game, lightweight)
./gradlew assembleBridgeOnlyDebug
# APK at: app/build/outputs/apk/bridgeOnly/debug/app-bridgeOnly-debug.apk

# Bundle (bridge + embedded web app)
# First, copy web app assets:
cd .. && ./scripts/copy-game-assets.sh && cd android
./gradlew assembleBundleDebug
# APK at: app/build/outputs/apk/bundle/debug/app-bundle-debug.apk
```

## Install & test

```bash
# Bridge only
adb install -r app/build/outputs/apk/bridgeOnly/debug/app-bridgeOnly-debug.apk

# Bundle
adb install -r app/build/outputs/apk/bundle/debug/app-bundle-debug.apk

# Debug logs
adb logcat -s LinkJNI BridgeService GameWebView
```

## Requirements

- Android SDK + NDK + CMake 3.22.1+ (auto-installed by Gradle on first build)
- Java 17 — use Android Studio's bundled JBR:
  ```bash
  export JAVA_HOME=~/android-studio/jbr
  ```
- `minSdk 26`, `targetSdk 34`, `compileSdk 34`

## Build variants

Two product flavors controlled by `BuildConfig.INCLUDE_GAME`:

| Variant | App ID suffix | Game | APK size |
|---------|--------------|------|----------|
| `bridgeOnly` | (none) | No WebView, no game assets | ~5 MB |
| `bundle` | `.bundle` | Embedded web app in WebView | ~15+ MB |

Both variants share all bridge code. The `bundle` flavor:
- Sets `BuildConfig.INCLUDE_GAME = true`
- Picks up web app assets from `src/bundle/assets/game/` (Gradle flavor source set)
- Shows "Launch Game" button in `MainActivity`
- Has `applicationIdSuffix ".bundle"` so both can be installed simultaneously

## Architecture

| Desktop (Electron) | Android |
|---|---|
| `bridge.ts` Bridge class | `BridgeService.kt` (Foreground Service) |
| `index.ts` main process | `MainActivity.kt` + `BridgeService.kt` |
| `@ktamas77/abletonlink` native addon | `LinkWrapper.cpp` JNI + Ableton Link C++ SDK |
| `ws` WebSocket server | `org.java-websocket:Java-WebSocket:1.5.6` |
| System tray icon | Foreground service persistent notification |

## Source files

| File | Role |
|------|------|
| `BridgeService.kt` | Foreground service: Link + WS server + 20Hz state loop |
| `LinkSession.kt` | Kotlin wrapper over JNI native methods |
| `MainActivity.kt` | Status UI, binds to service, conditional "Launch Game" button |
| `GameActivity.kt` | WebView hosting the bundled web app |
| `BridgeState.kt` | Data class + `toJson()` helper |
| `Utils.kt` | `getLocalIpAddress()`, `WS_PORT`, `getWsUrl()` |
| `cpp/jni/LinkWrapper.cpp` | JNI bridge to Ableton Link C++ SDK |

All Kotlin files at: `app/src/main/kotlin/com/xicnet/joymixabridge/`

## Bundle variant — WebView

`GameActivity.kt` loads the web app from bundled assets via `WebViewAssetLoader`, serving files over a fake `https://appassets.androidplatform.net` origin to avoid CORS issues with `file://` URLs.

The native layer intercepts requests to proxy API calls to the remote backend. See the web app's own documentation for request routing details.

### Cleartext WebSocket

The bridge runs `ws://` (not `wss://`) on localhost. Android blocks cleartext from HTTPS origins by default. `network_security_config.xml` permits cleartext to `127.0.0.1` and `localhost` only.

### Debugging the WebView

1. Build and install a debug APK
2. Connect device via USB
3. Open `chrome://inspect` in desktop Chrome
4. The WebView appears under "Remote Target" — click **inspect**
5. Full Chrome DevTools: Console, Network, DOM, etc.

Logcat also captures JS console messages tagged `GameWebView`.

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
