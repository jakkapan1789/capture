//! Screen capture abstraction.
//!
//! The rest of the app talks to [`ScreenCapture`] only. `xcap` is the current
//! implementation and works on macOS and Windows; a native Windows.Graphics.Capture
//! backend can be dropped in later (see `windows.rs`) without the frontend noticing.
//!
//! # Coordinate spaces
//!
//! There are two, and mixing them up is the single easiest way to break this app:
//!
//! * **Logical** ("CSS") pixels - what the webview reports for mouse drags.
//! * **Physical** pixels - what a captured image actually contains.
//!
//! Everything crossing the IPC boundary is *logical*, in virtual-desktop
//! coordinates. Everything inside a [`Capture`] is *physical*. Conversion happens
//! exactly once, in the capture implementation.

use anyhow::Result;
use image::RgbaImage;
use serde::{Deserialize, Serialize};

pub mod permission;
mod xcap_impl;

#[cfg(target_os = "windows")]
#[allow(dead_code)]
mod windows;

/// A monitor's geometry, normalized to **logical** pixels in virtual-desktop space.
///
/// Normalization matters: `xcap` reports geometry in different units per platform
/// (see `xcap_impl::logical_geometry`), and the frontend must not have to care.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// A drag rectangle in **logical** pixels, in virtual-desktop coordinates.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRegion {
    /// Center point, used to decide which monitor a drag belongs to.
    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// A captured bitmap plus the metadata needed to map it back to screen space.
pub struct Capture {
    /// Pixel data, in **physical** pixels.
    pub image: RgbaImage,
    /// Physical pixels per logical pixel, as actually observed for this capture.
    pub scale_factor: f32,
    /// Logical virtual-desktop coordinates of the image's top-left corner.
    pub origin: (f64, f64),
}

/// Crop an already-captured frame.
///
/// Split out from grabbing so a region can be cut from a frame taken *before*
/// the selection overlay existed - otherwise the overlay's dimming ends up baked
/// into the screenshot, and no amount of waiting for the compositor fixes that
/// reliably.
pub fn crop(frame: &Capture, region: LogicalRegion) -> Result<Capture> {
    if region.width <= 0.0 || region.height <= 0.0 {
        return Err(anyhow::anyhow!("region must have a positive width and height"));
    }

    let scale = frame.scale_factor as f64;
    let (width, height) = (frame.image.width() as f64, frame.image.height() as f64);

    let left = ((region.x - frame.origin.0) * scale).round();
    let top = ((region.y - frame.origin.1) * scale).round();
    let right = left + (region.width * scale).round();
    let bottom = top + (region.height * scale).round();

    // Clamp to the frame: a drag can run past the edge of the monitor, and
    // `crop_imm` would happily read out of bounds.
    let left = left.clamp(0.0, width) as u32;
    let top = top.clamp(0.0, height) as u32;
    let right = right.clamp(0.0, width) as u32;
    let bottom = bottom.clamp(0.0, height) as u32;

    let w = right.saturating_sub(left);
    let h = bottom.saturating_sub(top);
    if w == 0 || h == 0 {
        return Err(anyhow::anyhow!("region is empty after clamping to the monitor"));
    }

    Ok(Capture {
        image: image::imageops::crop_imm(&frame.image, left, top, w, h).to_image(),
        scale_factor: frame.scale_factor,
        // Where the crop actually landed, post-clamp.
        origin: (
            frame.origin.0 + left as f64 / scale,
            frame.origin.1 + top as f64 / scale,
        ),
    })
}

pub trait ScreenCapture: Send + Sync {
    fn list_monitors(&self) -> Result<Vec<MonitorInfo>>;

    /// Capture one whole monitor, identified by [`MonitorInfo::id`].
    fn capture_monitor(&self, monitor_id: u32) -> Result<Capture>;

    /// Capture the whole monitor containing `point` (logical coordinates).
    fn capture_monitor_at(&self, point: (f64, f64)) -> Result<Capture>;

    /// Capture an arbitrary rectangle of the virtual desktop.
    fn capture_region(&self, region: LogicalRegion) -> Result<Capture>;
}

pub fn create_capture() -> Box<dyn ScreenCapture> {
    Box::new(xcap_impl::XcapCapture)
}
