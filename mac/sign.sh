#!/bin/bash
# Sign, notarize and package build/Burnkeys.app as build/Burnkeys.dmg.
# Needs: the Developer ID Application identity in the keychain, and notary
# credentials stored once with:
#   xcrun notarytool store-credentials burnkeys-notary --apple-id <apple id> --team-id WS7RN89595
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Burnkeys.app"
IDENTITY="Developer ID Application: SSTA Digital industry LTD (WS7RN89595)"

codesign --force --timestamp --options runtime --entitlements mac/node.entitlements --sign "$IDENTITY" "$APP/Contents/Resources/node/bin/node"
codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ "${1:-}" = "--notarize" ]; then
  DMG="build/Burnkeys.dmg"
  rm -f "$DMG"
  STAGE="build/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname Burnkeys -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile burnkeys-notary --wait
  # Apple's ticket can take a few minutes to become available: retry.
  for i in $(seq 1 30); do xcrun stapler staple "$DMG" && break; [ "$i" = 30 ] && { echo "stapling failed"; exit 1; }; sleep 60; done
  spctl -a -t open --context context:primary-signature -v "$DMG"
  echo "Ready: $PWD/$DMG"
fi
