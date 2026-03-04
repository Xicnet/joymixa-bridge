#!/usr/bin/env bash
#
# Release script for Joymixa Bridge.
# Bumps version in package.json, commits, tags, and pushes to trigger
# the GH Actions build & release workflow.
#
# Usage:
#   ./scripts/release.sh          # patch bump (1.3.3 → 1.3.4)
#   ./scripts/release.sh minor    # minor bump (1.3.3 → 1.4.0)
#   ./scripts/release.sh major    # major bump (1.3.3 → 2.0.0)
#   ./scripts/release.sh 1.5.0    # explicit version
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Ensure clean working tree (untracked files are OK)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

current=$(node -p "require('./package.json').version")
bump="${1:-patch}"

case "$bump" in
  patch)
    IFS='.' read -r major minor patch <<< "$current"
    next="$major.$minor.$((patch + 1))"
    ;;
  minor)
    IFS='.' read -r major minor patch <<< "$current"
    next="$major.$((minor + 1)).0"
    ;;
  major)
    IFS='.' read -r major minor patch <<< "$current"
    next="$((major + 1)).0.0"
    ;;
  [0-9]*)
    next="$bump"
    ;;
  *)
    echo "Usage: $0 [patch|minor|major|X.Y.Z]"
    exit 1
    ;;
esac

echo "Releasing: $current → $next"
read -rp "Continue? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# Bump version in package.json
sed -i "s/\"version\": \"$current\"/\"version\": \"$next\"/" package.json

git add package.json
git commit -m "Bump version to $next"
git tag "v$next"
git push origin main "v$next"

echo ""
echo "Done! v$next pushed. GH Actions will build & release."
echo "Track at: https://github.com/xicnet/joymixa-bridge/actions"
