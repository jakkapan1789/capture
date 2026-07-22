# Capture — lightweight screen capture & annotation

Greenshot-light, Snagit-good annotation, with a re-editable history gallery.

Developed on macOS (Apple Silicon), targeting Windows. Everything compiles and runs
on macOS today; Windows-specific concerns are marked `TODO(windows):` in the source
and get one focused validation pass later.

## Architecture

Responsibilities are split hard down the middle:

| Rust backend | Web frontend |
| --- | --- |
| Screen capture | All annotation |
| Saving files | Canvas editing (Konva) |
| History storage | Export/flatten |

The frontend never touches an OS API and the backend never knows what an arrow is.
Annotation is the bulk of the app, and this split means it develops entirely on a Mac.

```
src-tauri/src/
  capture/
    mod.rs         ScreenCapture trait, coordinate-space contract, factory
    xcap_impl.rs   current backend (macOS + Windows)
    windows.rs     placeholder for a native Windows.Graphics.Capture backend
  storage.rs       gallery: PNG + thumbnail + annotation JSON
  commands.rs      the entire IPC surface
src/
  lib/types.ts     annotation model
  lib/ipc.ts       typed wrappers over invoke()
  editor/          Konva stage, tools, shapes
  overlay/         fullscreen region-selection window
  gallery/         history strip
```

## The two things most likely to break

### 1. Coordinate spaces

Two spaces, and mixing them is the easiest way to break this app:

- **Logical** ("CSS") pixels — what the webview reports for mouse drags.
- **Physical** pixels — what a captured image actually contains.

Everything crossing IPC is *logical, in virtual-desktop coordinates*. Everything
inside a `Capture` is *physical*. Conversion happens once, in `xcap_impl`.

This is not just a Windows problem. The dev machine is a 2× Retina display, so it
surfaces immediately — `crops_a_region_at_physical_resolution` asserts that a
200×100 logical drag yields a 400×200 pixel image.

**`xcap` does not report geometry in a consistent unit across platforms:**

| | `monitor.width()` / `x()` | Source |
| --- | --- | --- |
| macOS | logical points | `CGDisplayBounds` |
| Windows | physical pixels | `DEVMODE.dmPelsWidth` |

`logical_geometry()` normalizes both to logical. For the same reason we do **not**
use `xcap::Monitor::capture_region` — its arguments are logical points on macOS and
physical pixels on Windows. Region capture is "grab the whole monitor, then crop
with the `image` crate", which keeps one code path and one set of units.

The crop scale is derived empirically (`image.width() / logical_width`) rather than
read from `scale_factor()`, so scaled display modes where the ratio isn't a clean
2.0 still crop correctly.

### 2. Non-destructive editing

The original PNG and the annotation JSON live side by side and the PNG is never
modified. Flattening happens only on export, in the frontend. Reopening a history
item rehydrates fully editable objects.

Blur is the clearest example: a blur region is not a grey box painted over the
screenshot, it is a *second copy of the screenshot*, cropped to the region, with a
Konva filter applied. Move it and it re-samples what is now underneath.

Annotation coordinates are in **image pixel space** — the physical pixels of the
PNG, not screen or CSS pixels. The stage is scaled to fit the viewport, so the same
numbers stay correct at any window size, and export at full resolution is just
`pixelRatio: 1 / fitScale`.

## Crop, cut-out and pasted images

**Crop is stored, never applied.** It lives in the annotation JSON as a single
`crop` object; the PNG on disk keeps every pixel. The content layer is offset by
`-viewport.x/-viewport.y`, so cropping changes what the stage shows without
touching one stored coordinate — and a crop can be widened again or removed
weeks later. While the crop tool is active the stage deliberately shows the
*whole* image, because you cannot re-grow a crop you are not allowed to see
outside of.

Two kinds of image object, one component (`ImageObject`):

| Source | Pixels | Survives reload |
| --- | --- | --- |
| `capture` (Cut tool) | a rectangle into the screenshot we already have | yes — it's just coordinates |
| `external` (clipboard paste, Cmd+V) | in memory for this session | no — flattened at export |

`persistableAnnotations()` drops `external` images before every write. Persisting
them would rehydrate as blank objects, since the JSON has no pixels to point at.

## Two sizing rules that look similar but are opposites

**Display zoom** never exceeds `1 / scaleFactor`. A capture is stored in physical
pixels, so showing a 2× capture at 1:1 renders everything at double its real
on-screen size. `naturalScale` shows it exactly as it looked on screen.

**Text size is stored in logical pixels** and multiplied by `unit` at render — the
only measurement in the model that is not in image pixels. Picking "16" therefore
means the same thing on every capture, instead of silently doubling on Retina.
Colour and size are user-controlled from the toolbar; the last choice becomes the
default for the next shape.

Everything else (arrow stroke, badge radius) still scales with DPI, because those
have no user-facing number to be surprised by.

## Undo/redo

Whole-list snapshots in a `useReducer`, not diffs — captures hold tens of
annotations, not thousands, so simplicity beats the bytes. The reducer is pure, so
StrictMode's double-invocation is harmless.

The interesting problem is **granularity**. A single user gesture calls `update()`
many times: dragging a multi-selection moves every follower, and picking a colour
recolours the whole selection. Snapshotting per call would make one drag cost five
undo presses.

Everything one event handler does runs in a single microtask, so a checkpoint flag
cleared via `queueMicrotask` collapses a gesture into exactly one undo step. A
transform that returns the same array (a rejected step reorder, a no-op edit) is
detected by identity and does not consume a step at all.

## The region is cut from a frame taken *before* the overlay appears

The selection overlay dims the screen. Grabbing the screen after hiding it and
waiting a fixed delay bakes that dimming into the screenshot whenever the
compositor has not caught up — which is exactly what happened on Windows, where
it is slower than on macOS.

So `show_region_overlay` grabs the monitor first and parks the frame in
`AppState::pending_frame`; `capture_region` crops that frame rather than
grabbing again. The race is removed instead of out-waited, and the selection now
shows the screen as it was when you started, which is also what every other
capture tool does.

## The window's minimum size is measured, not guessed

`minWidth` is derived from the widest the toolbar ever gets. That is not the
default state: selecting a step badge while a crop is active shows the colour
well, the Number -/+ pair, Delete *and* Reset crop at once — 883px, against
539px with nothing selected.

Below that the pinned capture buttons overlap the tools rather than the row
simply scrolling, which looks broken. So `minWidth = 883 + 232 (history strip)
+ 45 slack`. Re-measure it if the toolbar gains controls.

## Storage is named after the product, not the identifier

Tauri's `app_data_dir()` is `<data dir>/<bundle identifier>`, which put the
author's name into a path users see in their own file manager. `storage_root()`
uses `<data dir>/<product name>` instead, and moves an existing library across
the first time it runs — only ever when the destination is absent, so it can
never overwrite anything.

## Window creation must not happen on the main thread

`WebviewWindowBuilder::build()` deadlocks on Windows when called from a
synchronous command or an event handler: creating a WebView2 window waits for
the event loop that the caller is itself blocking. Tauri documents this on
`WebviewWindowBuilder::new`.

macOS does not care, which is exactly why it is easy to introduce and hard to
notice — the region overlay froze the whole app on Windows with no error.

So: `open_region_overlay` is `async` (Tauri runs async commands off the main
thread), and the global-hotkey handler dispatches through
`async_runtime::spawn_blocking` rather than `run_on_main_thread`.

## Drag tracking lives on `window`

`mousemove`/`mouseup` are bound to `window`, registered once for the editor's
lifetime — not to the Konva stage, and not inside a `draft !== null` effect.

Both alternatives are broken in ways that present as "the tool doesn't work":

- On the stage only, releasing the button past the edge of the picture never
  finishes the shape. Cropping almost always ends outside the image.
- Inside a `draft !== null` effect, the listeners are attached only after React
  re-renders from the mousedown, so a fast click can deliver its `mouseup` first.
  A click *is* the whole interaction for the step and text tools.

## Multi-select

Selection is a list of ids, not one id. Marquee-drag on empty canvas selects by
intersection, using each node's `getClientRect()` so stroke width, arrow heads and
text metrics are accounted for by Konva rather than reimplemented.

Konva drags one node at a time, so moving a multi-selection mirrors the dragged
node's delta onto the others — imperatively during the drag, committed to state on
drop, which keeps a large selection smooth.

Selection is resolved centrally in the Stage's `mousedown` handler via
`annotationIdAt()` (which walks up from the clicked node), not by per-shape
handlers. That is what makes shift-click, marquee and right-click behave the same
for every shape type without repeating logic six times.

## Step numbers

Badges carry no `number` field. The displayed digit is derived from the badge's
position among the other step annotations (`stepNumbers()`), so deleting badge 2 of
5 renumbers the rest on the next render with no bookkeeping. Reordering swaps two
badges' slots in the annotation array and the digits follow.

## Dependency notes

- **`xcap` is pinned to `=0.9.7`.** Its API has shifted across minor versions —
  most `Monitor` getters now return `Result`. Verify against the source, not old
  snippets, before bumping.
- **`image` must stay on 0.25**, the version `xcap` depends on, or the `RgbaImage`
  it returns is a different type than the one we crop and encode with.
- `tauri` needs `image-png` (clipboard) and `macos-private-api` (transparent
  overlay window).

## Status

**Phase 1 (done)** — capture trait + `xcap` backend, region-selection overlay,
editor with select/arrow/box/text/step/blur, PNG export, clipboard copy,
auto-saving gallery with re-editable history.

**Phase 2 (in progress)** — configurable global hotkey for region capture ✅.
Remaining: window-specific capture, delay timer, multi-monitor picker, SQLite
history index + auto-cleanup, pin-on-top, JPG/WebP export.

### Global hotkey

Settings live in `<app-data>/settings.json`, separate from the gallery so clearing
history never touches preferences.

The accelerator format is the one `global-hotkey` parses, and it accepts
`KeyboardEvent.code` values verbatim — `KeyA`, `Digit2`, `BracketLeft`, `ArrowUp`.
The recorder in `src/lib/hotkey.ts` therefore passes `event.code` straight through
instead of inventing a mapping that could drift.

`hotkey::tests` pins that contract from the Rust side: every accelerator shape the
recorder can emit must parse. It has already caught one wrong assumption — the
frontend whitelist capped function keys at F12, but the parser supports F1–F24,
and F13+ are the *best* hotkeys precisely because nothing else claims them.

**Recording commits on key release, not on key press.** Committing when the first
non-modifier key arrives locks in whatever is held at that instant, which breaks
the common case of reaching for a three-key combination without pressing the
modifiers first — pressing A before Shift would save `Cmd+A` and stop listening.
Holding builds the combination up; letting go saves it. Releasing a lone modifier
is not an error and keeps the recorder listening.

Failure handling, in order of how confusing they'd otherwise be:
- A combination the OS refuses (another app owns it) → the previous hotkey is
  re-registered, so you are never left with no working shortcut.
- A hotkey that fails to register at startup → the app still starts, and the
  setting is reported as `hotkeyRegistered: false` so the UI can say so.
- `CommandOrControl+Shift+2` is the default because Cmd+Shift+3/4/5 belong to
  macOS's own screenshot tools.

**Phase 3** — scrolling capture, OCR, cloud upload, GIF/video.

## Development

```sh
npm install
npm run tauri dev
```

macOS needs **Screen Recording** permission (System Settings → Privacy & Security).
Without it, `CGWindowListCreateImage` returns a uniformly blank image rather than an
error — the ignored integration test asserts against exactly that failure mode.

```sh
cd src-tauri && cargo test                      # unit tests
cd src-tauri && cargo test -- --ignored --nocapture   # live capture against the real display
npx tsc --noEmit                                # frontend typecheck
```
