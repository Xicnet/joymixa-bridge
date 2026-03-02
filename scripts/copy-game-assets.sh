#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GAME_SRC="${1:-$PROJECT_ROOT/../joymixa/dist/template-angular/browser}"

if [ ! -f "$GAME_SRC/index.csr.html" ]; then
  echo "ERROR: index.csr.html not found at $GAME_SRC"
  echo "Usage: $0 [path-to-browser-folder]"
  exit 1
fi

copy_assets() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"

  # Copy root files and dirs, excluding locale subdirs, sitemap, and robots
  find "$GAME_SRC" -maxdepth 1 \( \
    -name 'index.csr.html' -o \
    -name '*.js' -o \
    -name '*.css' -o \
    -name '*.png' -o \
    -name '*.webmanifest' \
  \) -exec cp {} "$dest/" \;
  cp -r "$GAME_SRC/assets" "$dest/"
  cp -r "$GAME_SRC/icons" "$dest/" 2>/dev/null || true

  # Rename CSR entry point to index.html
  mv "$dest/index.csr.html" "$dest/index.html"

  # Rewrite base href for WebView (relative paths required)
  sed -i 's|<base href="/">|<base href="./">|g' "$dest/index.html"

  # Remove service worker files (not useful in WebView)
  rm -f "$dest/ngsw-worker.js" "$dest/ngsw.json" \
        "$dest/safety-worker.js" "$dest/worker-basic.min.js"
}

# --- Android ---
ANDROID_DEST="$PROJECT_ROOT/android/app/src/bundle/assets/game"
copy_assets "$ANDROID_DEST"
echo "Android: $ANDROID_DEST"

# --- iOS ---
IOS_DEST="$PROJECT_ROOT/ios/LinkBridge/GameAssets"
copy_assets "$IOS_DEST"
echo "iOS: $IOS_DEST"

echo "Done."
