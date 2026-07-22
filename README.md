# Capture

Screen capture with annotations you can always re-edit.

A lightweight capture tool: as small as Greenshot, with annotation closer to
Snagit — numbered step badges, clean blur — and a history that lets you reopen an
old capture and keep editing it.

Built with [Tauri 2](https://tauri.app) (Rust + system WebView, so the bundle
stays a few megabytes rather than a few hundred) and
[Konva](https://konvajs.org) for the canvas.

## Status

Working on macOS. Windows support is written but has never been compiled — the
CI workflow here is what will prove it, and the first few runs are expected to
fail.

## Features

- Region, full-screen and scrolling capture — the last scrolls the window for you and joins it into one tall image
- Arrow, box, text that wraps in a box you drag and can sit on an opaque plate, auto-numbering step badges, blur / pixelate
- Crop and cut-out that work like Paint, but non-destructively
- Read text out of a capture with the OS's own OCR, shown for review before copying — no upload, nothing bundled (macOS; Windows to follow)
- Undo/redo, multi-select, copy/paste of objects between captures
- Auto-saving history you can reopen and keep editing
- Export to PNG or copy straight to the clipboard

## Non-destructive by design

The original PNG is never modified. Annotations live beside it as JSON, so a
capture from last month reopens as editable objects rather than baked-in pixels.
Flattening happens only on export.

See [SPEC.md](SPEC.md) for the architecture and the parts most likely to break.

## Development

```sh
npm install
npm run tauri dev     # fast iteration, but see the note below
npm run dev:app       # build and run a real .app - needed for screen capture
```

macOS needs **Screen Recording** permission (System Settings → Privacy &
Security → Screen & System Audio Recording). Without it macOS returns the desktop
wallpaper with every window missing, rather than an error — the app detects this
and offers a link to the right settings pane.

**`tauri dev` cannot hold that permission.** It runs the bare binary from
`target/debug`, which has no `Info.plist` and is linker-signed with a hash of its
own contents, so macOS has nothing stable to attach the grant to: the app never
appears in the permission list, and whatever access it has is inherited from the
terminal that launched it.

Use `npm run dev:app`. It bundles the app and signs it with a code-signing
certificate, which is what makes the grant stick — an ad-hoc signature's
designated requirement is `cdhash H"..."`, a hash of the binary itself, so every
rebuild looks like a different application and the permission is silently lost.
Signing with a certificate (an Apple Development one is enough; it need not be a
Developer ID) gives a requirement based on the identifier instead, which survives
rebuilds. The script prints the requirement it produced, and falls back to ad-hoc
with a warning if no certificate is installed.

Grant the permission once after the first signed build. If an earlier unsigned
build already left an entry, clear it first:

```sh
tccutil reset ScreenCapture com.jakkapanpakeerat.capture
```

Permission is granted per binary, so a debug build, a release build and the test
harness each need it separately.

```sh
npx tsc --noEmit                                       # frontend typecheck
cd src-tauri && cargo test                             # unit tests
cd src-tauri && cargo test -- --ignored --nocapture    # live capture + permission check
```

## Releasing

Tag a version and GitHub Actions builds the installers and opens a draft release:

```sh
# bump "version" in src-tauri/tauri.conf.json and package.json to match
git commit -am "Release v0.2.0"
git tag v0.2.0
git push --follow-tags
```

## Licence

MIT — see [LICENSE](LICENSE).

Bundled dependencies keep their own licences; `xcap` is Apache-2.0, which
requires its attribution to travel with the app. The About window lists them.
