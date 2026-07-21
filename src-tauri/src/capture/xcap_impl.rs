//! `xcap`-backed implementation of [`ScreenCapture`].
//!
//! Works on macOS and Windows, which is what lets the whole app be developed on a Mac.

use anyhow::{anyhow, Result};
use xcap::Monitor;

use super::{Capture, LogicalRegion, MonitorInfo, ScreenCapture};

pub struct XcapCapture;

/// Monitor geometry after normalization to **logical** pixels.
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f32,
}

/// Normalize a monitor's geometry to logical pixels.
///
/// `xcap` does not report geometry in a consistent unit across platforms:
///
/// * **macOS** - `CGDisplayBounds`, which is already in logical points, and
///   `scale_factor()` is derived as `pixel_width / bounds.width`.
/// * **Windows** - `DEVMODE.dmPosition` / `dmPelsWidth`, which are physical
///   device pixels, so they must be divided by the scale factor.
///
/// The webview only ever speaks logical pixels, so we convert here, once.
fn logical_geometry(monitor: &Monitor) -> Result<Geometry> {
    let raw_scale = monitor.scale_factor()?;
    // A zero or negative scale factor would poison every later division.
    let scale_factor = if raw_scale.is_finite() && raw_scale > 0.0 {
        raw_scale
    } else {
        1.0
    };

    let x = monitor.x()? as f64;
    let y = monitor.y()? as f64;
    let width = monitor.width()? as f64;
    let height = monitor.height()? as f64;

    #[cfg(target_os = "macos")]
    {
        Ok(Geometry {
            x,
            y,
            width,
            height,
            scale_factor,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        // TODO(windows): verify on a mixed-DPI multi-monitor setup. Windows lays the
        // virtual desktop out in physical device pixels, so a uniform per-monitor
        // divide is only exactly right when every monitor shares one scale factor.
        let s = scale_factor as f64;
        Ok(Geometry {
            x: x / s,
            y: y / s,
            width: width / s,
            height: height / s,
            scale_factor,
        })
    }
}

fn monitor_info(monitor: &Monitor) -> Result<MonitorInfo> {
    let geom = logical_geometry(monitor)?;

    Ok(MonitorInfo {
        id: monitor.id()?,
        name: monitor
            .friendly_name()
            .or_else(|_| monitor.name())
            .unwrap_or_else(|_| "Unknown display".to_string()),
        x: geom.x.round() as i32,
        y: geom.y.round() as i32,
        width: geom.width.round() as u32,
        height: geom.height.round() as u32,
        scale_factor: geom.scale_factor,
        is_primary: monitor.is_primary().unwrap_or(false),
    })
}

fn find_monitor(monitor_id: u32) -> Result<Monitor> {
    Monitor::all()?
        .into_iter()
        .find(|m| m.id().map(|id| id == monitor_id).unwrap_or(false))
        .ok_or_else(|| anyhow!("no monitor with id {monitor_id}"))
}

/// The monitor whose logical bounds contain `point`, falling back to the primary
/// display when a drag ends up in dead space between monitors.
fn monitor_at(point: (f64, f64)) -> Result<Monitor> {
    let monitors = Monitor::all()?;
    if monitors.is_empty() {
        return Err(anyhow!("no monitors found"));
    }

    for monitor in &monitors {
        let geom = logical_geometry(monitor)?;
        let inside = point.0 >= geom.x
            && point.0 < geom.x + geom.width
            && point.1 >= geom.y
            && point.1 < geom.y + geom.height;

        if inside {
            return Ok(monitor.clone());
        }
    }

    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned();

    Ok(primary.unwrap_or_else(|| monitors[0].clone()))
}

/// Capture a whole monitor and report the scale factor *actually observed*.
///
/// We divide the returned image size by the logical size rather than trusting
/// `scale_factor()`, so scaled display modes (where the ratio is not a clean 2.0)
/// still crop correctly.
fn capture_full(monitor: &Monitor) -> Result<(xcap::image::RgbaImage, Geometry, f64, f64)> {
    let geom = logical_geometry(monitor)?;
    let image = monitor.capture_image()?;

    if geom.width <= 0.0 || geom.height <= 0.0 {
        return Err(anyhow!("monitor reported a non-positive size"));
    }

    let scale_x = image.width() as f64 / geom.width;
    let scale_y = image.height() as f64 / geom.height;

    Ok((image, geom, scale_x, scale_y))
}

impl ScreenCapture for XcapCapture {
    fn list_monitors(&self) -> Result<Vec<MonitorInfo>> {
        Monitor::all()?.iter().map(monitor_info).collect()
    }

    fn capture_monitor(&self, monitor_id: u32) -> Result<Capture> {
        let monitor = find_monitor(monitor_id)?;
        let (image, geom, scale_x, _) = capture_full(&monitor)?;

        Ok(Capture {
            image,
            scale_factor: scale_x as f32,
            origin: (geom.x, geom.y),
        })
    }

    /// Region capture is "grab the whole monitor, then crop".
    ///
    /// `xcap` does expose its own `capture_region`, but its arguments are in logical
    /// points on macOS and physical pixels on Windows. Cropping ourselves keeps one
    /// code path and one set of units on both platforms.
    fn capture_region(&self, region: LogicalRegion) -> Result<Capture> {
        if region.width <= 0.0 || region.height <= 0.0 {
            return Err(anyhow!("region must have a positive width and height"));
        }

        let monitor = monitor_at(region.center())?;
        let (image, geom, scale_x, scale_y) = capture_full(&monitor)?;

        // Logical offset of the drag within this monitor, then into physical pixels.
        let left = ((region.x - geom.x) * scale_x).round();
        let top = ((region.y - geom.y) * scale_y).round();
        let right = left + (region.width * scale_x).round();
        let bottom = top + (region.height * scale_y).round();

        // Clamp to the captured bitmap: a drag can start on one monitor and end
        // past its edge, and `crop_imm` would happily read out of bounds.
        let left = left.clamp(0.0, image.width() as f64) as u32;
        let top = top.clamp(0.0, image.height() as f64) as u32;
        let right = right.clamp(0.0, image.width() as f64) as u32;
        let bottom = bottom.clamp(0.0, image.height() as f64) as u32;

        let width = right.saturating_sub(left);
        let height = bottom.saturating_sub(top);
        if width == 0 || height == 0 {
            return Err(anyhow!("region is empty after clamping to the monitor"));
        }

        let cropped = xcap::image::imageops::crop_imm(&image, left, top, width, height).to_image();

        Ok(Capture {
            image: cropped,
            scale_factor: scale_x as f32,
            // Report where the crop actually landed, post-clamp, so the frontend can
            // line annotations back up with the screen.
            origin: (geom.x + left as f64 / scale_x, geom.y + top as f64 / scale_y),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the real capture path against the real display.
    ///
    /// Ignored by default: it needs a desktop session, and on macOS the test binary
    /// must have Screen Recording permission. Run it deliberately with
    /// `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn crops_a_region_at_physical_resolution() {
        let capture = XcapCapture;
        let monitors = capture.list_monitors().expect("list_monitors");
        assert!(!monitors.is_empty(), "no monitors detected");

        for monitor in &monitors {
            println!("{monitor:?}");
        }

        let primary = monitors
            .iter()
            .find(|m| m.is_primary)
            .unwrap_or(&monitors[0]);

        let region = LogicalRegion {
            x: primary.x as f64 + 10.0,
            y: primary.y as f64 + 10.0,
            width: 200.0,
            height: 100.0,
        };

        let result = capture.capture_region(region).expect("capture_region");
        let scale = result.scale_factor as f64;
        println!(
            "captured {}x{} at scale {scale} from {:?}",
            result.image.width(),
            result.image.height(),
            result.origin
        );

        // This is the DPI requirement in assertion form: a 200x100 *logical* drag
        // on a 2x display must produce a 400x200 *physical* pixel image.
        assert_eq!(result.image.width(), (200.0 * scale).round() as u32);
        assert_eq!(result.image.height(), (100.0 * scale).round() as u32);
        assert!(scale >= 1.0, "scale factor should never be below 1");

        // A weak smoke test only: it catches a *uniformly* blank frame. Denied
        // permission on macOS returns the wallpaper, which is rarely uniform, so
        // this cannot detect that - `permission::granted()` is the real check.
        let first = result.image.pixels().next().copied();
        assert!(
            result.image.pixels().any(|pixel| Some(*pixel) != first),
            "capture is a single flat colour - is Screen Recording permission granted?"
        );
    }
}
