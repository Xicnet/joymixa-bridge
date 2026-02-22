# Game Bundle

Both native apps (Android/iOS) support embedding the Joymixa game directly, giving users a single app with the Ableton Link bridge + the game running offline in a WebView.

## Quick start

```bash
# 1. Build the game (in the joymixa repo)
cd /path/to/joymixa && yarn build-prod

# 2. Copy game assets into both platform projects
./scripts/copy-game-assets.sh            # defaults to en language
./scripts/copy-game-assets.sh es         # or specify a language

# 3. Build
cd android
export JAVA_HOME=~/android-studio/jbr
./gradlew assembleBundleDebug
adb install -r app/build/outputs/apk/bundle/debug/app-bundle-debug.apk
```

## How it works

The game is an Angular 19 + Phaser 3 web app. Its production build output is a folder of static files (HTML, JS, CSS, assets). We copy these into the native apps and load them in a WebView.

```
┌─────────────────────────────────────────────┐
│  Native App                                  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  BridgeService (ws://127.0.0.1:20809) │  │
│  │  Ableton Link ←→ WebSocket server     │  │
│  └──────────────────┬─────────────────────┘  │
│                     │ ws://127.0.0.1:20809   │
│  ┌──────────────────▼─────────────────────┐  │
│  │  WebView (GameActivity / GameWebView)  │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │  Joymixa game (local assets)     │  │  │
│  │  │  Angular + Phaser + Tone.js      │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
│                     │ https (proxied)        │
│                     ▼                        │
│           test.joymixa.com/api/              │
│           (soundbanks, waveforms, auth)      │
└─────────────────────────────────────────────┘
```

## Asset copy script

`scripts/copy-game-assets.sh [lang] [browser-folder]`

| Arg | Default | Description |
|-----|---------|-------------|
| `lang` | `en` | Language folder to bundle (one language per build) |
| `browser-folder` | `../joymixa/dist/template-angular/browser` | Path to Angular build output |

The script:
1. Copies the selected language folder into both platform projects
2. Rewrites `<base href="/en/">` → `<base href="./">` (required for WebView)
3. Removes `ngsw-worker.js` and `ngsw.json` (Angular service worker, unnecessary in WebView)

Output locations:
- Android: `android/app/src/bundle/assets/game/` (Gradle flavor source set)
- iOS: `ios/LinkBridge/GameAssets/` (Xcode folder reference)

Both paths are in `.gitignore` — assets are generated, not committed.

## Build variants

### Android (Gradle product flavors)

```groovy
productFlavors {
    bridgeOnly { dimension "mode" }
    bundle {
        dimension "mode"
        applicationIdSuffix ".bundle"
        buildConfigField "boolean", "INCLUDE_GAME", "true"
    }
}
```

```bash
./gradlew assembleBridgeOnlyDebug   # bridge only (~5 MB)
./gradlew assembleBundleDebug       # bridge + game (~15+ MB)
```

Both can be installed simultaneously (different app IDs).

### iOS (Swift conditional compilation)

```swift
#if INCLUDE_GAME
Button("Launch Game") { showGame = true }
#endif
```

The flag is passed at build time:
```bash
SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) INCLUDE_GAME
```

## Android WebView architecture

`GameActivity` uses `WebViewAssetLoader` to serve local files over `https://appassets.androidplatform.net`. This gives the page a proper HTTPS origin, avoiding CORS issues with `file://`.

### Request interception

The game uses relative URLs (e.g., `/api/get-soundbanks/`, `/media/soundbanks/...`) that normally resolve against the production web server. In the WebView, `shouldInterceptRequest` routes them:

| Pattern | Action |
|---------|--------|
| `/game/*` | Served from local `assets/` by `WebViewAssetLoader` |
| `/assets/*` | Rewritten to `/game/game/assets/*` (local fonts, images) |
| `/api/*` | HTTP proxy to `https://test.joymixa.com` |
| `/media/*` | HTTP proxy to `https://test.joymixa.com` |

### Cleartext WebSocket

The bridge runs `ws://` (not `wss://`) on localhost. Android blocks cleartext from HTTPS origins by default. `network_security_config.xml` permits cleartext to `127.0.0.1` and `localhost` only.

### Debugging

Debug builds enable `chrome://inspect`:
1. Connect device via USB
2. Open `chrome://inspect` in desktop Chrome
3. Click **inspect** on the WebView target
4. Full DevTools: Console, Network, DOM, etc.

JS `console.log/error` also appears in logcat tagged `GameWebView`.

## Known limitations

- **POST request bodies**: `shouldInterceptRequest` doesn't expose request bodies. POST endpoints needing a body (telemetry) get 400 errors. Non-critical — soundbank loading works with empty POST.
- **Single language per build**: The script bundles one language folder. No runtime language switching.
- **Backend URL hardcoded**: The proxy target (`test.joymixa.com`) is hardcoded in `GameActivity.kt`. Production builds would need `joymixa.com`.
- **Auth0 redirect**: Auth0 login redirects to `test.joymixa.com/callback` which won't work in the WebView. Guest/public soundbanks work; authenticated features need further work.

## CI (iOS)

`.github/workflows/build-ios.yml` builds both variants via matrix strategy. The `bundle` variant runs `copy-game-assets.sh` before building. Note: the game build output must be available in CI (currently not automated — game assets need to be built separately).
