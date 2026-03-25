# Game Bundle

Both native apps (Android/iOS) support a **bundle** variant that embeds a web app in a WebView alongside the bridge. This gives users a single app: Ableton Link bridge + the web app running locally.

## How it works

```
Native App
  BridgeService (ws://127.0.0.1:20809)
    Ableton Link <-> WebSocket server
                        |
  WebView               |
    Web app (local assets, connects to bridge via ws://localhost)
                        |
    Backend (remote, HTTPS — API calls proxied by native layer)
```

The web app's production build output (static HTML/JS/CSS/assets) is copied into the native project and loaded in a WebView. The bridge runs in the same process, so the WebSocket connection is always `ws://127.0.0.1:20809`.

## Asset copy pipeline

`scripts/copy-game-assets.sh` copies a web app's build output into both platform projects:

1. Copies root files (HTML, JS, CSS, assets)
2. Renames `index.csr.html` to `index.html`
3. Rewrites `<base href="/">` to `<base href="./">` (required for WebView relative URLs)
4. Removes service worker files (not useful in WebView)

Output locations (both gitignored):
- Android: `android/app/src/bundle/assets/game/`
- iOS: `ios/LinkBridge/GameAssets/`

## Build variants

Each platform has two variants:

| Variant | Contents | Size |
|---------|----------|------|
| `bridgeOnly` | Bridge only, no WebView | ~5 MB |
| `bundle` | Bridge + embedded web app | ~15+ MB |

Both can be installed simultaneously (different app IDs on Android).

## Important rules

- **Never commit game assets to this repo** — they are generated, not source
- **CI only builds bridge-only variants** — bundle builds are local-only
- The `.gitignore` already excludes both asset directories
