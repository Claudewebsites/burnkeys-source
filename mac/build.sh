#!/bin/bash
# Build build/Burnkeys.app: native window + bundled official Node.js + Burnkeys engine.
# Signing/notarization is a separate step (mac/sign.sh) once a Developer ID certificate is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE_VERSION="v26.12.1"
# Universal app: runs natively on Apple silicon and Intel Macs.
NODE_ARM="build/vendor/node-$NODE_VERSION-darwin-arm64.tar.gz"
NODE_X64="build/vendor/node-$NODE_VERSION-darwin-x64.tar.gz"
APP="build/Burnkeys.app"

for f in "$NODE_ARM" "$NODE_X64"; do [ -f "$f" ] || { echo "Missing $f (official Node.js download)"; exit 1; }; done
# Check both downloads against the checksums nodejs.org publishes for this version.
SUMS="build/vendor/SHASUMS256-$NODE_VERSION.txt"
[ -f "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"
(cd build/vendor && grep -E " node-$NODE_VERSION-darwin-(arm64|x64)\.tar\.gz$" "$(basename "$SUMS")" | shasum -a 256 -c - >/dev/null) || { echo "Node download doesn't match nodejs.org's checksum"; exit 1; }

rm -rf "${APP:?}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/engine"

# Native window
swiftc -O -target arm64-apple-macos13.5 mac/main.swift -o build/Burnkeys-arm64 -framework Cocoa -framework WebKit
swiftc -O -target x86_64-apple-macos13.5 mac/main.swift -o build/Burnkeys-x64 -framework Cocoa -framework WebKit
lipo -create build/Burnkeys-arm64 build/Burnkeys-x64 -output "$APP/Contents/MacOS/Burnkeys"
rm -f build/Burnkeys-arm64 build/Burnkeys-x64
cp mac/Info.plist "$APP/Contents/Info.plist"

# Official Node.js runtime (only the binary and its license)
tar -xzf "$NODE_ARM" -C build/vendor
tar -xzf "$NODE_X64" -C build/vendor
lipo -create "build/vendor/node-$NODE_VERSION-darwin-arm64/bin/node" "build/vendor/node-$NODE_VERSION-darwin-x64/bin/node" -output "$APP/Contents/Resources/node/bin/node"
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
