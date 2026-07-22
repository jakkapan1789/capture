#!/usr/bin/env bash
#
# Build and launch Capture as a real .app, so macOS will grant it Screen
# Recording permission.
#
# `tauri dev` runs the bare binary from target/debug. That binary has no
# Info.plist and is linker-signed with a hash of its own contents
# ("capture-9e96e427a2fa24ed"), so macOS has nothing stable to attach a TCC
# grant to: the app never appears in Screen & System Audio Recording, and any
# permission it does inherit belongs to the terminal that launched it.
#
# Two things fix that, and both are needed:
#
#   1. Bundle it, so it has a CFBundleIdentifier and a name to show in the list.
#   2. Sign it with a real certificate. Bundling alone is not enough, and neither
#      is passing --identifier: an ad-hoc signature's designated requirement is
#
#          designated => cdhash H"0ca2c7a6..."
#
#      which is a hash of the binary's own contents, so every rebuild looks like
#      a different application and the grant is silently lost. Signing with a
#      certificate - an Apple Development one is fine, it need not be a Developer
#      ID - gives instead
#
#          designated => identifier "com.jakkapanpakeerat.capture" and
#                        anchor apple generic and certificate leaf[...] = ...
#
#      which has no cdhash in it and therefore survives rebuilds.
#
# Grant the permission once after the first signed build; it sticks from then on.

set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="src-tauri/tauri.conf.json"
APP="src-tauri/target/debug/bundle/macos/Capture.app"

# Read the identifier from the config rather than repeating it here, so this
# cannot drift from what the app is actually built as.
IDENTIFIER=$(python3 -c "import json; print(json.load(open('$CONFIG'))['identifier'])")

echo "==> building $IDENTIFIER"
npm run tauri -- build --debug --bundles app

# Any code-signing certificate will do. Ad-hoc is the fallback, and it works -
# but the grant has to be given again after every build.
CERT=$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(.*\)"/\1/p' | head -1)

if [ -n "$CERT" ]; then
  echo "==> signing as $CERT"
  codesign --force --deep --sign "$CERT" --identifier "$IDENTIFIER" "$APP"
else
  echo "==> no signing certificate found; falling back to ad-hoc"
  echo "    Screen Recording permission will not survive a rebuild. To fix this"
  echo "    permanently, create a code-signing certificate in Keychain Access:"
  echo "    Certificate Assistant -> Create a Certificate -> Code Signing."
  codesign --force --deep --sign - --identifier "$IDENTIFIER" "$APP"
fi

# Print what macOS will actually match the permission against. A requirement
# containing "cdhash" means it is pinned to this exact build and will be lost on
# the next one.
echo "==> permission will be matched against:"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /    /p'

echo "==> launching"
open "$APP"

cat <<NOTE

If capture comes back as your wallpaper with every window missing, macOS has not
granted permission yet. The app asks on first capture; if the prompt does not
appear, enable "Capture" in:

  System Settings -> Privacy & Security -> Screen & System Audio Recording

Quit and reopen the app after granting - macOS only re-reads it at launch.
NOTE
