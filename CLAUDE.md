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

# iOS — bridge-only in CI; bundle variant is local-only
```

## Releasing (Desktop)

GH Actions builds & releases on every `v*` tag push (`.github/workflows/build.yml`).
Builds for Linux (.deb, .zip) and macOS (.zip). Release is auto-created with artifacts.

**One command:**

```bash
./scripts/release.sh          # patch bump (1.3.3 → 1.3.4)
./scripts/release.sh minor    # minor bump (1.3.3 → 1.4.0)
./scripts/release.sh major    # major bump (1.3.3 → 2.0.0)
./scripts/release.sh 1.5.0    # explicit version
```

The script: checks for clean working tree → bumps `package.json` → commits → tags `vX.Y.Z` → pushes both → GH Actions builds & releases.

**Prerequisites:** working tree must be clean (commit or stash changes first).

Track builds at: https://github.com/xicnet/joymixa-bridge/actions

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

## Game source — NEVER commit to this repo

The Joymixa game is proprietary and lives in a **separate** repo (`../joymixa/`).
Bundle variants (Android/iOS) embed pre-built game assets via `scripts/copy-game-assets.sh`,
which copies them into gitignored directories. **Rules:**

- **NEVER** commit game source code, built game assets, or any `../joymixa/` content to this repo
- **NEVER** add game asset paths to CI workflows — bundle variants are local-only builds
- The `.gitignore` already excludes `android/app/src/bundle/assets/game/` and `ios/LinkBridge/GameAssets/`
- CI workflows must only build bridge-only variants

## Key constraints

- No test suite across any platform
- Desktop native addon needs C++ toolchain + `libavahi-compat-libdnssd-dev` on Linux
- Android needs `JAVA_HOME=~/android-studio/jbr` (JDK 17)
- iOS builds on macOS CI only, unsigned IPA sideloaded via Sideloader
