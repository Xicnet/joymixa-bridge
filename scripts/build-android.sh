#!/usr/bin/env bash
set -euo pipefail

# Build Android APKs and deploy to /var/www/html/bridge/ for LAN download.
#
# Usage:
#   ./scripts/build-android.sh              # build bundle (bridge + game)
#   ./scripts/build-android.sh bridge-only  # build bridge only (no game)
#   ./scripts/build-android.sh both         # build both variants

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
JOYMIXA_DIR="$PROJECT_ROOT/../joymixa"
ANDROID_DIR="$PROJECT_ROOT/android"
DEPLOY_DIR="/var/www/html/bridge"

export JAVA_HOME="${JAVA_HOME:-$HOME/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

VARIANT="${1:-bundle}"

build_game() {
  echo "==> Building game (staging-fast)..."
  cd "$JOYMIXA_DIR"
  yarn build-staging-fast
  echo "==> Copying game assets..."
  cd "$PROJECT_ROOT"
  ./scripts/copy-game-assets.sh
}

build_bundle() {
  build_game
  echo "==> Building Android bundle APK..."
  cd "$ANDROID_DIR"
  ./gradlew assembleBundleDebug
  local apk="$ANDROID_DIR/app/build/outputs/apk/bundle/debug/app-bundle-debug.apk"
  cp "$apk" "$DEPLOY_DIR/"
  echo "==> Deployed: $DEPLOY_DIR/app-bundle-debug.apk"
}

build_bridge_only() {
  echo "==> Building Android bridge-only APK..."
  cd "$ANDROID_DIR"
  ./gradlew assembleBridgeOnlyDebug
  local apk="$ANDROID_DIR/app/build/outputs/apk/bridgeOnly/debug/app-bridgeOnly-debug.apk"
  cp "$apk" "$DEPLOY_DIR/"
  echo "==> Deployed: $DEPLOY_DIR/app-bridgeOnly-debug.apk"
}

mkdir -p "$DEPLOY_DIR"

case "$VARIANT" in
  bundle)      build_bundle ;;
  bridge-only) build_bridge_only ;;
  both)        build_bundle; build_bridge_only ;;
  *)           echo "Usage: $0 [bundle|bridge-only|both]"; exit 1 ;;
esac

echo "==> Done. APKs available at http://<lan-ip>/bridge/"
