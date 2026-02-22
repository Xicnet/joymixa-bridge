#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GAME_SRC="${1:-$PROJECT_ROOT/../joymixa/dist/template-angular/browser/en}"

if [ ! -f "$GAME_SRC/index.html" ]; then
  echo "ERROR: index.html not found at $GAME_SRC"
  echo "Usage: $0 [path-to-game-en-folder]"
  exit 1
fi

# --- Android ---
ANDROID_DEST="$PROJECT_ROOT/android/app/src/bundle/assets/game"
rm -rf "$ANDROID_DEST"
mkdir -p "$ANDROID_DEST"
cp -r "$GAME_SRC/"* "$ANDROID_DEST/"
sed -i 's|<base href="/en/">|<base href="./">|g' "$ANDROID_DEST/index.html"
rm -f "$ANDROID_DEST/ngsw-worker.js" "$ANDROID_DEST/ngsw.json"
echo "Android: $ANDROID_DEST"

# --- iOS ---
IOS_DEST="$PROJECT_ROOT/ios/LinkBridge/GameAssets"
rm -rf "$IOS_DEST"
mkdir -p "$IOS_DEST"
cp -r "$GAME_SRC/"* "$IOS_DEST/"
sed -i 's|<base href="/en/">|<base href="./">|g' "$IOS_DEST/index.html"
rm -f "$IOS_DEST/ngsw-worker.js" "$IOS_DEST/ngsw.json"
echo "iOS: $IOS_DEST"

echo "Done."
