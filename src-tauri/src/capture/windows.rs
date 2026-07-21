//! Placeholder for a native Windows.Graphics.Capture backend.
//!
//! `xcap_impl` already works on Windows, so this exists only to prove the seam is
//! real: swapping backends should mean editing `create_capture()` and nothing else.
//! WGC would buy us a faster capture path and, eventually, window/scroll capture.
//!
//! TODO(windows): implement `ScreenCapture` here against Windows.Graphics.Capture,
//! then switch `create_capture()` over behind `#[cfg(target_os = "windows")]`.
