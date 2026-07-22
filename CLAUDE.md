# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**[SPEC.md](SPEC.md) is the architecture document.** It explains the coordinate
spaces, the non-destructive model, and the decisions most likely to be undone by
accident. Read the section relevant to what you are changing; this file covers
commands and the conventions that live outside it.

## Commands

```sh
npm install
npm run tauri dev              # full app, but cannot hold Screen Recording - see below
npm run dev:app                # bundles + stably signs a real .app, then launches it
npm run dev                    # frontend only, no backend - IPC calls will fail

npx tsc --noEmit               # frontend typecheck
npm run build                  # tsc + vite build

cd src-tauri
cargo test --lib                                  # unit tests
cargo test --lib thumbnails_keep -- --nocapture   # single test by name substring
cargo test -- --ignored --nocapture               # live capture against the real display
cargo clippy --lib --all-targets
```

CI runs `npx tsc --noEmit`, `npm run build`, `cargo build`, `cargo test`. Run
those four once the work is finished — see *Working rhythm* below.

The `--ignored` tests need a desktop session and macOS **Screen Recording**
permission. Permission is granted **per binary**, so a debug build, a release
build and the test harness each need granting separately. Without it macOS
returns the desktop wallpaper with every window missing rather than an error.

Anything that captures the screen must be run through `npm run dev:app`, not
`tauri dev`. The bare binary has no `Info.plist` and is linker-signed with a hash
of its own contents, so it never appears in the permission list at all.

Bundling alone does not fix it, and neither does `--identifier`: an ad-hoc
signature's designated requirement is `cdhash H"..."`, so each rebuild reads as a
different app and the grant is lost. `dev:app` signs with a real code-signing
certificate, which yields an identifier-based requirement that survives rebuilds
— verified by rebuilding and diffing. `tccutil reset ScreenCapture <bundle-id>`
clears a stale entry left by an earlier signing identity.

## The split that defines the codebase

Rust does capture, files and history. The frontend does all annotation. The
frontend never touches an OS API; the backend never knows what an arrow is.
This is what lets the bulk of the app be developed on a Mac while targeting
Windows. Keep it — do not move annotation logic into Rust to "make it faster".

`capture/mod.rs` defines the `ScreenCapture` trait so `xcap` can be swapped for
native Windows APIs later. Code that needs verifying on Windows is marked
`// TODO(windows):`.

## Contracts that break silently if ignored

**Coordinate spaces.** Everything crossing IPC is logical, virtual-desktop
pixels; everything inside a `Capture` is physical. Conversion happens once, in
`xcap_impl`. `xcap` reports geometry in different units per platform — see
SPEC.md before touching monitor geometry.

**Cut-out piece files.** A cut is the one thing that flattens before export, so
its pixels live in `<capture-id>.piece-<piece-id>.png`. `save_annotations` takes
the list of still-live piece ids and deletes every other piece file for that
capture — so that list must be derived from the annotations actually being
written (`livePieceIds`), never from a stale copy. Rust cannot work it out
itself; it knows nothing about the annotation model.

**Rasterising the stage.** Before `toCanvas`/`toDataURL`, hide the overlay layer
*and* clear the selection through `flushSync`. An arrow's endpoint handles are
drawn on the **content** layer, so hiding the overlay alone does not keep them
out of the output. Both `exportBlob` and `rasterizeRegion` do this.

**Window creation must not run on the main thread on Windows.** Creating a
WebView2 window from a synchronous command deadlocks. `open_region_overlay` is
`async` and the hotkey handler uses `spawn_blocking` for this reason.

**Pinned dependencies.** `xcap` is pinned to `=0.9.7` and `image` must stay on
0.25 — the version `xcap` depends on — or the `RgbaImage` it returns is a
different type than the one this code crops and encodes.

**Cargo profile overrides are load-bearing, not leftovers.**
`[profile.dev.package."*"]` keeps PNG encoding usable in `tauri dev`, and the
codec crates are `opt-level = 3` in release while the binary stays `"s"`. Both
are backed by measurements recorded in SPEC.md.

**Plugin calls need a capability.** Tauri v2 gates every `@tauri-apps/plugin-*`
call behind an entry in `src-tauri/capabilities/default.json`, and a missing one
fails at runtime in the click that needed it. `tsc` sees a valid import and the
headless harness stubs `invoke`, so neither notices. `npm run build` runs
`scripts/check-capabilities.mjs`, which cross-references the frontend's imports
against the granted list — adding a new plugin call means adding it to that map.

## Verifying frontend changes

There is no test runner for the frontend. Canvas behaviour is verified by
building, serving `dist/`, and driving it in headless Chrome with
`window.__TAURI_INTERNALS__` stubbed to return fixture data — then asserting on
**sampled canvas pixels**, not on the DOM. Solid-colour fixture PNGs make an
assertion like "this region is red, so it came from capture A" decisive.

Two limitations of that environment have caused wrong conclusions before:

- **`requestAnimationFrame` is starved under virtual time**, so Konva's
  `batchDraw` never repaints. Call `layer.draw()` before sampling pixels, or a
  correct change reads as a failure.
- **`IntersectionObserver` never fires**, which is why lazy thumbnail loading
  uses a scroll listener and `offsetTop` maths instead.

Konva 10 needs **pointer** events; dispatching only mouse events silently does
nothing. Delete the harness directory before committing.

Claims about performance or layout should come from a measurement in this
repository, not from reasoning. `PngEncoder::new()` defaults to `Fast`, not
`Default` — a benchmark that assumed otherwise produced a baseline 20× off.

## Working rhythm

**Fix the whole pain point before verifying.** Do not run the test suite, build,
or push after every individual edit. Work through the problem end to end — all
the files it touches, the follow-on cases it creates — and run the checks once
the change is actually complete. A build after every small edit is noise, and
pushing half a fix means the next session inherits a broken middle state.

This is about *cadence*, not about skipping verification. Two things still hold:

- The checks run before the work is called done, and before pushing.
- Never state that something works when it has not been run. "Written, not yet
  verified" is a fine thing to report; a green claim on unrun code is not.

## Commits

Do **not** add a `Co-Authored-By: Claude` trailer to commits in this project.
