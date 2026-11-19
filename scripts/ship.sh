#!/bin/bash
# Ship Pear Drop to every installed copy, peer to peer.
#   bash scripts/ship.sh          package the app, pear build, pear stage (the update goes out)
#   bash scripts/ship.sh seed     keep the app reachable on the network (leave it running)
#   bash scripts/ship.sh link     print the app's pear:// link
# Needs the Pear CLI (npm i -g pear) and a link of your own in package.json#upgrade (pear touch).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build-desktop"
cd "$ROOT"
LINK="$(node -p "require('./package.json').upgrade")"
VERSION="$(node -p "require('./package.json').version")"

case "${1:-ship}" in
  ship)
    npm run package
    APPDIR="$(find out -maxdepth 2 -type d -name '*.app' | head -1)"
    [ -n "$APPDIR" ] || { echo "No .app in out/ (macOS only for now)"; exit 1; }
    mkdir -p "$BUILD"
    pear build --package="$ROOT/package.json" --darwin-arm64-app "$ROOT/$APPDIR" --target "$BUILD/pear-drop-$VERSION"
    pear stage "$LINK" "$BUILD/pear-drop-$VERSION"
    echo "Shipped Pear Drop v$VERSION to $LINK"
    ;;
  seed) pear seed "$LINK" ;;
  link) echo "$LINK" ;;
  *) sed -n 2,6p "$0"; exit 1 ;;
esac
