//! Tauri commands - the entire surface the frontend can reach.
//!
//! Rust does capture, files and history. It never touches an annotation.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder, Window,
};

use crate::capture::{permission, LogicalRegion, MonitorInfo, ScreenCapture};
use crate::hotkey;
use crate::ocr::{self, RecognizedLine, TextRecognizer};
use crate::settings::{self, Settings};
use crate::storage::{self, CaptureMeta, GalleryItem};

/// Window label of the fullscreen region-selection overlay.
pub const OVERLAY_LABEL: &str = "region-overlay";
/// Window label of the small Stop panel shown while a scrolling capture runs.
pub const SCROLL_LABEL: &str = "scroll-control";
pub const MAIN_LABEL: &str = "main";

/// Emitted after a capture lands in the gallery, so the main window can open it.
const CAPTURE_CREATED: &str = "capture://created";
/// Emitted when macOS refuses screen capture, so the UI can offer a way out.
const PERMISSION_DENIED: &str = "capture://permission-denied";
/// Emitted as a scrolling capture grows, for the Stop panel.
const SCROLL_PROGRESS: &str = "capture://scroll-progress";

/// How long to wait after hiding our own window before a full-screen grab.
///
/// Hiding is not synchronous with what the compositor has drawn. The region
/// overlay no longer relies on this - it grabs the screen before it appears -
/// but a full-screen capture still has to get the app's own window out of shot.
const WINDOW_SETTLE: Duration = Duration::from_millis(120);

pub struct AppState {
    pub capture: Box<dyn ScreenCapture>,
    pub recognizer: Box<dyn TextRecognizer>,
    pub settings: Mutex<Settings>,
    /// The screen as it looked the moment the selection overlay opened.
    ///
    /// The region is cut from this rather than grabbed again on mouse-up, so the
    /// overlay's own dimming can never end up in the screenshot. Waiting for the
    /// compositor to finish hiding the overlay is guesswork; this removes the
    /// race instead of trying to out-wait it.
    pub pending_frame: Mutex<Option<crate::capture::Capture>>,
    /// The scrolling capture currently running, if any.
    pub scroll: Mutex<Option<crate::scroll::Session>>,
    /// Whether a scrolling capture hid the main window and owes it a return.
    ///
    /// A scrolling capture is the one flow where our own window has to get out
    /// of the way: the user is about to scroll somebody else's, and cannot do
    /// that through ours. Every way out of the flow has to put it back, so who
    /// hid it is recorded rather than guessed at.
    pub hid_main_window: std::sync::atomic::AtomicBool,
}

/// Settings plus the runtime facts the UI needs to explain itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub capture_region_hotkey: Option<String>,
    /// False when a hotkey is configured but the OS refused it - typically
    /// because another app already owns that combination.
    pub hotkey_registered: bool,
    pub default_hotkey: String,
    pub auto_copy_to_clipboard: bool,
}

/// `anyhow` errors do not implement `Serialize`, and the frontend only ever shows
/// these as text anyway.
fn to_string_err<T>(result: anyhow::Result<T>) -> Result<T, String> {
    result.map_err(|e| format!("{e:#}"))
}

/// Where everything this app owns lives.
///
/// Named after the product rather than the bundle identifier: Tauri's
/// `app_data_dir()` returns a folder named after the identifier, which put the
/// author's name in a path users see. `<data dir>/Capture` is what someone
/// browsing their own files would expect to find.
fn storage_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Capture".to_string());

    let root = app
        .path()
        .data_dir()
        .map_err(|e| format!("could not resolve the data directory: {e}"))?
        .join(name);

    // Move an existing library over the first time, rather than appearing to
    // have lost everything. Only ever when the new location is still absent, so
    // this can never overwrite anything.
    if !root.exists() {
        if let Ok(previous) = app.path().app_data_dir() {
            if previous.exists() && previous != root {
                if let Err(error) = std::fs::rename(&previous, &root) {
                    eprintln!(
                        "could not move {} to {}: {error}",
                        previous.display(),
                        root.display()
                    );
                }
            }
        }
    }

    Ok(root)
}

fn gallery_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(storage_root(app)?.join("gallery"))
}

#[tauri::command]
pub fn list_monitors(state: State<'_, AppState>) -> Result<Vec<MonitorInfo>, String> {
    to_string_err(state.capture.list_monitors())
}

/// Open the fullscreen, transparent, always-on-top selection overlay.
///
/// The overlay covers the monitor under the cursor, which is where the user is
/// looking. TODO(windows): with multiple monitors this only lets you select within
/// one display; a true virtual-desktop-spanning overlay needs per-OS work.
///
/// Shared by the toolbar button and the global hotkey.
///
/// Must **not** be called from the main thread: see `open_region_overlay`.
pub fn show_region_overlay<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    show_region_overlay_with(app, false)
}

/// As above, for a scrolling capture.
///
/// The mode is injected as a global before the page loads rather than passed in
/// the URL: `WebviewUrl::App` takes a `PathBuf`, so whether a query string
/// survives being joined to the base URL and encoded is a detail to be at the
/// mercy of. An initialisation script runs before the page's own scripts and
/// cannot be mangled by either.
pub fn show_region_overlay_with<R: Runtime>(
    app: &AppHandle<R>,
    for_scrolling: bool,
) -> Result<(), String> {
    // Check before the overlay appears: being asked to drag a region and only
    // then being told it was refused is a waste of the user's time. The hotkey
    // path has no dialog of its own, so surface it on the main window.
    if let Err(error) = permission::ensure() {
        surface_main_window(app);
        let _ = app.emit_to(MAIN_LABEL, PERMISSION_DENIED, ());
        return Err(error);
    }

    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Ask Tauri (not xcap) for the geometry here: we need physical pixels in the
    // window manager's own coordinate space, which is exactly what it reports.
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|e| e.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available for the overlay".to_string())?;

    let position = *monitor.position();
    let size = *monitor.size();

    // Grab the screen *now*, while nothing of ours is covering it - a one-shot
    // region capture is cut from this rather than grabbed again once the overlay
    // is up. A scrolling capture takes live frames instead, so it would only be
    // paying for a screen-sized buffer it never reads.
    if !for_scrolling {
        let scale = monitor.scale_factor();
        let cursor_logical = (cursor.x / scale, cursor.y / scale);
        let frame = to_string_err(
            app.state::<AppState>()
                .capture
                .capture_monitor_at(cursor_logical),
        )?;
        *app.state::<AppState>()
            .pending_frame
            .lock()
            .map_err(|e| e.to_string())? = Some(frame);
    }


    let window = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(if for_scrolling {
            "window.__CAPTURE_SCROLLING__ = true;"
        } else {
            "window.__CAPTURE_SCROLLING__ = false;"
        })
        .title("Select a region")
        .position(position.x as f64, position.y as f64)
        .inner_size(size.width as f64, size.height as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;

    // `.position()`/`.inner_size()` on the builder are logical; we were handed
    // physical values, so set them again explicitly now that the window exists.
    window
        .set_position(position)
        .and_then(|_| window.set_size(size))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Must stay `async`.
///
/// A synchronous command runs on the main thread, and creating a WebView2 window
/// from there deadlocks on Windows - the window creation waits for the event
/// loop that the command is itself blocking. Tauri documents this on
/// `WebviewWindowBuilder::new`. It happens to work on macOS, which is exactly
/// why it went unnoticed.
#[tauri::command]
pub async fn open_region_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    show_region_overlay(&app)
}

#[tauri::command]
pub async fn close_region_overlay<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        overlay.close().map_err(|e| e.to_string())?;
    }
    // Backing out of a scrolling capture before it started still has to give the
    // window back.
    restore_main_window(&app);
    // Drop the frame; keeping it would waste a screen-sized buffer until the
    // next capture, and it would be stale by then anyway.
    if let Ok(mut pending) = state.pending_frame.lock() {
        *pending = None;
    }
    Ok(())
}

/// A drag in window-relative logical pixels, as virtual-desktop coordinates.
///
/// A browser mouse event gives you the former; capture needs the latter, and
/// only this layer knows the window's own origin. Tauri reports that position in
/// physical pixels while the drag is logical, which is the conversion here.
fn to_virtual<R: Runtime>(window: &Window<R>, region: LogicalRegion) -> Result<LogicalRegion, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    Ok(LogicalRegion {
        x: origin.x as f64 / scale + region.x,
        y: origin.y as f64 / scale + region.y,
        width: region.width,
        height: region.height,
    })
}

/// Capture a dragged region and file it in the gallery.
///
/// `region` arrives in **logical pixels relative to the calling window** - that is
/// what a browser mouse event gives you. Converting to virtual-desktop coordinates
/// needs the window's own origin, which only this layer knows.
#[tauri::command]
pub async fn capture_region<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: State<'_, AppState>,
    region: LogicalRegion,
) -> Result<CaptureMeta, String> {
    permission::ensure()?;

    let virtual_region = to_virtual(&window, region)?;

    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.close();
    }

    // Cut from the frame taken before the overlay appeared. Falling back to a
    // fresh grab keeps things working if the overlay was somehow opened without
    // one - at the cost of the dimming possibly showing up.
    let frame = state
        .pending_frame
        .lock()
        .map_err(|e| e.to_string())?
        .take();

    let result = match frame {
        Some(frame) => crate::capture::crop(&frame, virtual_region),
        None => state.capture.capture_region(virtual_region),
    };

    let capture = to_string_err(result)?;
    finish_capture(&app, capture)
}

#[tauri::command]
pub async fn capture_monitor<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    monitor_id: u32,
) -> Result<CaptureMeta, String> {
    permission::ensure()?;

    // Get the main window out of the shot before capturing its own screen.
    let main = app.get_webview_window(MAIN_LABEL);
    if let Some(main) = &main {
        main.hide().map_err(|e| e.to_string())?;
        tokio::time::sleep(WINDOW_SETTLE).await;
    }

    let result = state.capture.capture_monitor(monitor_id);

    if main.is_some() {
        surface_main_window(&app);
    }

    let capture = to_string_err(result)?;
    finish_capture(&app, capture)
}

/// Bring the main window to the front, whatever state it was left in.
///
/// A capture usually happens while another application is focused - especially
/// from the global hotkey - so `show()` alone is not enough: the window may also
/// be minimised, and showing a minimised window leaves it minimised.
fn surface_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

/// Save a fresh capture, surface the main window, and announce it.
fn finish_capture<R: Runtime>(
    app: &AppHandle<R>,
    capture: crate::capture::Capture,
) -> Result<CaptureMeta, String> {
    let dir = gallery_dir(app)?;
    let meta = to_string_err(storage::save_capture(
        &dir,
        &capture.image,
        capture.scale_factor,
        capture.origin,
    ))?;

    surface_main_window(app);

    let _ = app.emit_to(MAIN_LABEL, CAPTURE_CREATED, &meta);
    Ok(meta)
}

/// Raw PNG bytes for a capture.
///
/// Returns [`tauri::ipc::Response`] so the bytes arrive as an `ArrayBuffer` instead
/// of being inflated into a JSON array of numbers.
#[tauri::command]
pub fn read_capture_image<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::read_png(&dir, &id)).map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn read_capture_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::read_thumb(&dir, &id)).map(tauri::ipc::Response::new)
}

/// Persist a cut-out's flattened pixels next to its capture.
#[tauri::command]
pub fn save_capture_piece<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    piece_id: String,
    png: Vec<u8>,
) -> Result<(), String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::write_piece(&dir, &id, &piece_id, &png))
}

#[tauri::command]
pub fn read_capture_piece<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    piece_id: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::read_piece(&dir, &id, &piece_id)).map(tauri::ipc::Response::new)
}

/// Save annotations, and drop any piece file they no longer refer to.
///
/// `pieces` is the ids still in use. Rust deliberately knows nothing about the
/// annotation model, so it cannot work that out for itself - the caller states
/// it, and this is the one place where files and annotations are reconciled.
#[tauri::command]
pub fn save_annotations<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    annotations: serde_json::Value,
    pieces: Vec<String>,
) -> Result<(), String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::save_annotations(&dir, &id, annotations))?;
    to_string_err(storage::prune_pieces(&dir, &id, &pieces))
}

#[tauri::command]
pub fn list_gallery<R: Runtime>(app: AppHandle<R>) -> Result<Vec<CaptureMeta>, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::list_items(&dir))
}

#[tauri::command]
pub fn load_gallery_item<R: Runtime>(app: AppHandle<R>, id: String) -> Result<GalleryItem, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::load_item(&dir, &id))
}

#[tauri::command]
pub fn delete_gallery_item<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::delete_item(&dir, &id))
}

/// Delete several captures at once.
///
/// One command rather than a call per id: a cleanup can span hundreds of
/// captures, and each round trip would otherwise re-resolve the gallery path and
/// re-cross the IPC boundary. Individual failures are collected rather than
/// aborting, so one unreadable file cannot strand the rest.
#[tauri::command]
pub fn delete_gallery_items<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let dir = gallery_dir(&app)?;
    let mut deleted = 0usize;
    let mut failures = Vec::new();

    for id in &ids {
        match storage::delete_item(&dir, id) {
            Ok(()) => deleted += 1,
            Err(error) => failures.push(format!("{id}: {error}")),
        }
    }

    if failures.is_empty() {
        Ok(deleted)
    } else {
        Err(format!(
            "deleted {deleted} of {}, failed: {}",
            ids.len(),
            failures.join("; ")
        ))
    }
}

/// Where a capture's PNG lives on disk, so the UI can reveal it.
#[tauri::command]
pub fn capture_file_path<R: Runtime>(app: AppHandle<R>, id: String) -> Result<String, String> {
    let dir = gallery_dir(&app)?;
    to_string_err(storage::capture_path(&dir, &id))
        .map(|path| path.to_string_lossy().into_owned())
}

/// Open the region overlay to choose what a scrolling capture will watch.
///
/// Must stay `async` for the same reason `open_region_overlay` does.
#[tauri::command]
pub async fn open_scroll_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Out of the way first. The overlay grabs the screen as it opens, and the
    // window the user wants to scroll is behind ours.
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        main.hide().map_err(|e| e.to_string())?;
        app.state::<AppState>()
            .hid_main_window
            .store(true, std::sync::atomic::Ordering::Relaxed);
        tokio::time::sleep(WINDOW_SETTLE).await;
    }

    tauri::async_runtime::spawn_blocking(move || {
        // One overlay window serves both kinds of capture; this is how it is
        // told which one it is selecting for.
        show_region_overlay_with(&app, true)
    })
    .await
    .map_err(|error| format!("could not open the overlay: {error}"))?
}

/// Begin watching a region while the user scrolls.
///
/// The overlay closes and a small Stop panel opens *outside* the chosen region -
/// it has to be, because every frame is a fresh grab of the screen and anything
/// overlapping the region would be captured along with it.
#[tauri::command]
pub async fn start_scroll_capture<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    region: LogicalRegion,
) -> Result<(), String> {
    permission::ensure()?;
    let virtual_region = to_virtual(&window, region)?;

    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        overlay.close().map_err(|e| e.to_string())?;
        // Closing is not synchronous with what the compositor has drawn, and the
        // very next thing here is the first frame of the capture. Without this
        // that frame contains the overlay's dimming, nothing afterwards matches
        // it, and the capture never advances past its own first frame.
        tokio::time::sleep(WINDOW_SETTLE).await;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let progress_app = app.clone();
        let session = crate::scroll::Session::start(
            std::sync::Arc::from(crate::capture::create_capture()),
            virtual_region,
            move |progress| {
                let _ = progress_app.emit_to(SCROLL_LABEL, SCROLL_PROGRESS, progress);
            },
        )
        .map_err(|error| format!("{error:#}"))?;

        *app.state::<AppState>()
            .scroll
            .lock()
            .map_err(|e| e.to_string())? = Some(session);

        open_scroll_panel(&app, virtual_region)
    })
    .await
    .map_err(|error| format!("could not start the capture: {error}"))?
}

/// Stop, join what was collected, and file it in the gallery.
#[tauri::command]
pub async fn stop_scroll_capture<R: Runtime>(app: AppHandle<R>) -> Result<CaptureMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = app
            .state::<AppState>()
            .scroll
            .lock()
            .map_err(|e| e.to_string())?
            .take()
            .ok_or_else(|| "no scrolling capture is running".to_string())?;

        let scale_factor = session.scale_factor;
        let origin = session.origin;
        let image = session.stop().map_err(|error| format!("{error:#}"))?;

        close_scroll_panel(&app);

        let dir = gallery_dir(&app)?;
        let meta = to_string_err(storage::save_capture(&dir, &image, scale_factor, origin))?;
        app.state::<AppState>()
            .hid_main_window
            .store(false, std::sync::atomic::Ordering::Relaxed);
        surface_main_window(&app);
        let _ = app.emit_to(MAIN_LABEL, CAPTURE_CREATED, meta.clone());
        Ok(meta)
    })
    .await
    .map_err(|error| format!("could not finish the capture: {error}"))?
}

/// Stop and throw it away.
#[tauri::command]
pub async fn cancel_scroll_capture<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut slot) = app.state::<AppState>().scroll.lock() {
            if let Some(session) = slot.take() {
                session.cancel();
            }
        }
        close_scroll_panel(&app);
        restore_main_window(&app);
        Ok(())
    })
    .await
    .map_err(|error| format!("could not stop the capture: {error}"))?
}

/// Give the main window back, if a scrolling capture took it away.
fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if app
        .state::<AppState>()
        .hid_main_window
        .swap(false, std::sync::atomic::Ordering::Relaxed)
    {
        surface_main_window(app);
    }
}

fn close_scroll_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(panel) = app.get_webview_window(SCROLL_LABEL) {
        let _ = panel.close();
    }
}

/// Put the Stop panel somewhere it will not be captured.
///
/// Every frame is a fresh grab, so a panel sitting over the region would appear
/// in the result. It goes above the region if there is room, below if not, and
/// otherwise in a corner - at which point it *will* be in shot, but a capture
/// covering the whole screen has nowhere else to put it.
fn open_scroll_panel<R: Runtime>(app: &AppHandle<R>, region: LogicalRegion) -> Result<(), String> {
    const W: f64 = 260.0;
    const H: f64 = 92.0;
    const GAP: f64 = 12.0;

    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .ok_or_else(|| "no monitor available".to_string())?;
    let scale = monitor.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let screen_origin = monitor.position().to_logical::<f64>(scale);

    let x = (region.x + region.width / 2.0 - W / 2.0)
        .clamp(screen_origin.x, screen_origin.x + screen.width - W);
    let above = region.y - H - GAP;
    let below = region.y + region.height + GAP;
    let y = if above >= screen_origin.y {
        above
    } else if below + H <= screen_origin.y + screen.height {
        below
    } else {
        screen_origin.y + GAP
    };

    WebviewWindowBuilder::new(
        app,
        SCROLL_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Scrolling capture")
    .inner_size(W, H)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Whether this build can read text from an image at all.
///
/// Lets the toolbar disable the tool up front rather than letting someone drag a
/// region and only then be told it does nothing.
#[tauri::command]
pub fn text_recognition_available(state: State<'_, AppState>) -> bool {
    state.recognizer.available()
}

/// Read text from a PNG.
///
/// Async, and the work runs on a blocking thread: recognition takes ~80-100ms on
/// a region and would otherwise stall the event loop that is drawing the very
/// selection the user just made.
///
/// Low-confidence lines are dropped here rather than in the UI, so every caller
/// gets the same answer - see `ocr::MIN_CONFIDENCE` for where the threshold
/// comes from.
#[tauri::command]
pub async fn recognize_text<R: Runtime>(
    app: AppHandle<R>,
    png: Vec<u8>,
) -> Result<Vec<RecognizedLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut lines = to_string_err(state.recognizer.recognize(&png))?;
        lines.retain(|line| line.confidence >= ocr::MIN_CONFIDENCE);
        Ok(lines)
    })
    .await
    .map_err(|error| format!("text recognition did not finish: {error}"))?
}

/// Whether this build may capture the screen. Never prompts.
#[tauri::command]
pub fn screen_permission_granted() -> bool {
    permission::granted()
}

/* ---------- about ---------- */

/// Facts about this build, for the About window.
///
/// Read from the compiled binary rather than duplicated in the UI: the version
/// comes from `tauri.conf.json` at build time, so it can never drift out of sync
/// with what was actually shipped.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    /// Where captures and settings live, so the user can go and find them.
    pub storage_dir: String,
}

#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> Result<AppInfo, String> {
    let config = app.config();

    Ok(AppInfo {
        name: config.product_name.clone().unwrap_or_else(|| "Capture".into()),
        version: config
            .version
            .clone()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        storage_dir: storage_root(&app)?.to_string_lossy().into_owned(),
    })
}

/* ---------- settings ---------- */

pub fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(storage_root(app)?.join("settings.json"))
}

fn view<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> SettingsView {
    SettingsView {
        hotkey_registered: settings
            .capture_region_hotkey
            .as_deref()
            .map(|accelerator| hotkey::is_registered(app, accelerator))
            .unwrap_or(false),
        capture_region_hotkey: settings.capture_region_hotkey.clone(),
        default_hotkey: settings::DEFAULT_HOTKEY.to_string(),
        auto_copy_to_clipboard: settings.auto_copy_to_clipboard,
    }
}

/// Change preferences that cannot fail, leaving unnamed ones alone.
#[tauri::command]
pub fn update_preferences<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    patch: settings::PreferencesPatch,
) -> Result<SettingsView, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.apply(patch);
    to_string_err(settings::save(&settings_path(&app)?, &settings))?;
    Ok(view(&app, &settings))
}

#[tauri::command]
pub fn get_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<SettingsView, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(view(&app, &settings))
}

/// Change (or clear, with `None`) the region-capture hotkey.
///
/// On failure the previous hotkey is re-registered, so a rejected combination
/// never leaves the user with no working shortcut at all.
#[tauri::command]
pub fn set_capture_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    hotkey_accelerator: Option<String>,
) -> Result<SettingsView, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let previous = settings.capture_region_hotkey.clone();

    if let Err(error) = hotkey::apply(&app, hotkey_accelerator.as_deref()) {
        let _ = hotkey::apply(&app, previous.as_deref());
        return Err(error);
    }

    settings.capture_region_hotkey = hotkey_accelerator;

    // A hotkey that works until restart would be a nasty surprise; report the
    // write failure rather than swallowing it.
    let path = settings_path(&app)?;
    to_string_err(settings::save(&path, &settings))?;

    Ok(view(&app, &settings))
}
