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
#   2. Re-sign it with a *stable* identifier. Even bundled, Tauri leaves the
#      ad-hoc signature keyed to a content hash, which changes on every build -
#      so the grant would be silently lost each time you rebuilt.
#
# The permission then survives rebuilds, because the identity no longer moves.

set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="src-tauri/tauri.conf.json"
APP="src-tauri/target/debug/bundle/macos/Capture.app"

# Read the identifier from the config rather than repeating it here, so this
# cannot drift from what the app is actually built as.
IDENTIFIER=$(python3 -c "import json; print(json.load(open('$CONFIG'))['identifier'])")

echo "==> building $IDENTIFIER"
npm run tauri -- build --debug --bundles app

echo "==> signing with a stable identity"
codesign --force --deep --sign - --identifier "$IDENTIFIER" "$APP"
codesign -dv "$APP" 2>&1 | grep '^Identifier='

echo "==> launching"
open "$APP"

cat <<NOTE

If capture comes back as your wallpaper with every window missing, macOS has not
granted permission yet. The app asks on first capture; if the prompt does not
appear, enable "Capture" in:

  System Settings -> Privacy & Security -> Screen & System Audio Recording

Quit and reopen the app after granting - macOS only re-reads it at launch.
NOTE
