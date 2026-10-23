#!/bin/bash
# Build build/Burnkeys.app: native window + bundled official Node.js + Burnkeys engine.
# Signing/notarization is a separate step (mac/sign.sh) once a Developer ID certificate is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE_VERSION="v26.12.1"
NODE_TGZ="build/vendor/node-$NODE_VERSION-darwin-arm64.tar.gz"
APP="build/Burnkeys.app"

[ -f "$NODE_TGZ" ] || { echo "Missing $NODE_TGZ (official Node.js download)"; exit 1; }

rm -rf "${APP:?}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/engine"

# Native window
swiftc -O -target arm64-apple-macos12 mac/main.swift -o "$APP/Contents/MacOS/Burnkeys" -framework Cocoa -framework WebKit
cp mac/Info.plist "$APP/Contents/Info.plist"

# Official Node.js runtime (only the binary and its license)
tar -xzf "$NODE_TGZ" -C build/vendor
cp "build/vendor/node-$NODE_VERSION-darwin-arm64/bin/node" "$APP/Contents/Resources/node/bin/node"
cp "build/vendor/node-$NODE_VERSION-darwin-arm64/LICENSE" "$APP/Contents/Resources/node/LICENSE"

# Burnkeys engine (no tests, no docs)
# Minified (hard to read) copy of the engine; see internal/minify.mjs
rm -rf build/engine-min
node internal/minify.mjs build/engine-min bin src package.json .claude-plugin hooks skills >/dev/null
cp -R build/engine-min/. "$APP/Contents/Resources/engine/"

# Icon
ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for z in 16 32 128 256 512; do
  sips -z $z $z brand/app-icon-1024.png --out "$ICONSET/icon_${z}x${z}.png" >/dev/null
  sips -z $((z*2)) $((z*2)) brand/app-icon-1024.png --out "$ICONSET/icon_${z}x${z}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "Built $ROOT/$APP"
