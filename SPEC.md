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
| `capture` (Cut tool) | a rectangle into a screenshot, by capture id | yes — it's just coordinates |
| `external` (clipboard paste, Cmd+V) | in memory for this session | no — flattened at export |

A `capture` source carries the **id of the capture it came from**, not just a
rectangle. Without it a cut-out means "this rectangle of whatever is open", so
copying one into a different capture silently re-cut the new picture at the same
coordinates. When a piece points at another capture, the editor loads that
image and hands it to `ImageObject`.

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

## Cut flattens, on purpose

Every other annotation stays an object until export. A cut-out cannot: cutting a
marked-up screenshot and getting bare pixels back is not what the tool appears
to do, so a cut rasterises the region *as it looks* - screenshot plus whatever
was drawn over it.

That makes a piece the only thing in the app whose pixels cannot be re-derived
from the capture PNG, which decides where it lives. Not in the annotation JSON:
that file is rewritten on every autosave and read for every gallery listing, so
a few hundred KB of base64 would be paid for on both paths. It goes in a sibling
`<id>.piece-<pid>.png` instead.

Two consequences have to be handled explicitly:

**Orphaned files.** Undo, delete and overwrite all leave a piece file with
nothing pointing at it, and Rust cannot tell - it knows nothing about the
annotation model. So every save states which piece ids are still live and
`prune_pieces` removes the rest. Deleting a capture takes its pieces with it.

**Pieces pasted into another capture.** The file belongs to the capture it was
cut from, which is free to prune it. So pasting a piece elsewhere re-homes it:
the pixels travel on the clipboard and are written as a new file under the
receiving capture. Sharing the original would break the copy as soon as the
source capture dropped its own.

Rasterising uses the same two precautions as `exportBlob`: hide the overlay
layer, and clear the selection through `flushSync` first - an arrow's endpoint
handles are drawn on the *content* layer and would otherwise be cut into the
piece.

## Where capture time actually goes

Saving a capture is one PNG encode of a full-resolution frame. A first pass at
this measured `CompressionType::Default` and concluded encoding cost ~1.1s -
wrong, because `PngEncoder::new()` defaults to **`Fast`**, not `Default`. The
real cost in a release build is ~50ms, and encoding was never the bottleneck it
looked like. Measured on real captures here (2022x1476 to 2426x1624):

| | encode | file size |
|---|---|---|
| debug, unoptimised deps | ~1.4s | - |
| debug, optimised deps | ~0.27s | - |
| release, `opt-level = "s"` throughout | 50.0ms | baseline |
| release, codecs at `opt-level = 3` | 45.1ms | baseline |
| release, codecs at 3, alpha dropped | 41.6ms | -14 to -18% |

Three things follow:

**Dependencies are optimised in the dev profile.** `tauri dev` builds everything
unoptimised, and PNG work lives entirely in `image`/`png`/`flate2`. Unoptimised,
saving a capture takes ~1.4s against ~0.27s - the difference between the app
feeling sluggish and feeling instant while it is being worked on.
`[profile.dev.package."*"] opt-level = 2` buys that back without slowing down
rebuilds of our own crate.

**The codecs are `opt-level = 3` in release.** The binary stays `"s"`, because a
small bundle is why we picked Tauri, but `"s"` measured ~17% slower on this one
hot path and these three crates are small.

**Alpha is dropped when the frame is opaque** - see `encode_png`. Smaller *and*
slightly faster, with an opacity check so a frame carrying real transparency is
still stored intact. The conversion writes one preallocated buffer; building it
per-pixel cost more than the encode saved.

`CompressionType::Best` and `Default` are both rejected: they shrink a flat UI
screenshot usefully but cost 3-10x the encode time, and the capture is written
while the user is waiting to annotate it.

## Thumbnails must not be square

`imageops::thumbnail` resizes to *exactly* the dimensions given - it does not
preserve aspect ratio, whatever the obvious reading of the name suggests.
Passing `THUMB_MAX_EDGE` for both edges therefore squashed every capture into a
320x320 thumbnail, which the gallery then stretched back out through
`object-fit: cover`. This went unnoticed for a long time because the result is
distorted rather than obviously broken; it was found by measuring the stored
files, not by reading the code. `thumb_size()` computes both edges from one
ratio, and a test pins it.

## The window's minimum size is measured, not guessed

`minWidth` is derived from the widest the toolbar ever gets, measured in the
browser rather than reasoned about. It is not the default state: with nothing
selected the row needs 575px; selecting a text object adds the colour well and
the size picker for 834px; a step badge selected while a crop is active adds
Delete *and* Reset crop, the widest state at 919px.

The row scrolls sideways by design, so exceeding it is not a failure - but the
pinned capture group starts getting clipped rather than staying pinned once the
overflow is large. Screenshotting the widest reachable state put that boundary
between 900px (settings gear clipped) and 1020px (clean). So
`minWidth = 1020`, which leaves the crop+step state scrolling slightly rather
than sizing every window for a state most sessions never enter.

**Re-measure whenever the toolbar gains a control** — adding the ellipse tool
alone moved it from 883 to 919.

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
