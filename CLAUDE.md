# CLAUDE.md

## Quick commands

```bash
# Desktop
yarn install && yarn start                        # dev mode
yarn make                                         # build installers

# Android (bridge only)
git submodule update --init --recursive
cd android && ./gradlew assembleBridgeOnlyDebug

# Android (bundle = bridge + game)
./scripts/copy-game-assets.sh
cd android && ./gradlew assembleBundleDebug

# iOS — CI only, see .github/workflows/build-ios.yml
```

## Architecture

Monorepo: three implementations of the same Ableton Link → WebSocket bridge (port 20809).

| Platform | Location | Tech |
|----------|----------|------|
| Desktop | `src/` | Electron + TypeScript |
| Android | `android/` | Kotlin + NDK (C++ JNI) |
| iOS | `ios/` | Swift + Network.framework |

Android and iOS support a `bundle` variant that embeds the Joymixa game in a WebView.

## Docs

- `docs/desktop.md` — Desktop build, architecture, dependencies, Linux sandbox fix
- `docs/android.md` — Android build, architecture, build variants, WebView details
- `docs/ios.md` — iOS build, architecture, build variants
- `docs/game-bundle.md` — Game bundling: asset copy script, WebView architecture, request routing, debugging
- `docs/protocol.md` — WebSocket protocol spec (all message types, fields, behavior)

## Key constraints

- No test suite across any platform
- Desktop native addon needs C++ toolchain + `libavahi-compat-libdnssd-dev` on Linux
- Android needs `JAVA_HOME=~/android-studio/jbr` (JDK 17)
- iOS builds on macOS CI only, unsigned IPA sideloaded via Sideloader
