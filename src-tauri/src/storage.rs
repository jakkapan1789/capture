//! Gallery storage.
//!
//! Every capture is written as three files in one flat directory:
//!
//! ```text
//! <app-data>/gallery/<id>.png         original, never touched again
//! <app-data>/gallery/<id>.thumb.png   downscaled, for the gallery strip
//! <app-data>/gallery/<id>.json        metadata + annotation objects
//! ```
//!
//! The PNG is the pristine capture and the JSON holds the annotations as data.
//! Nothing is ever flattened into the PNG - that only happens on export - which is
//! what makes a history item re-editable months later.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};

/// Longest edge of a generated thumbnail, in pixels.
const THUMB_MAX_EDGE: u32 = 320;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    /// Physical pixel dimensions of the stored PNG.
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    /// Where this capture came from on the virtual desktop, in logical pixels.
    /// Kept so a capture can later be re-taken or pinned back over its origin.
    pub origin_x: f64,
    pub origin_y: f64,
}

/// A stored capture: its metadata plus the annotation objects.
///
/// `annotations` is deliberately opaque here. The annotation model belongs to the
/// frontend, and Rust has no business knowing what an arrow is.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub meta: CaptureMeta,
    pub annotations: serde_json::Value,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reject anything that could escape the gallery directory.
///
/// Ids reach us from the frontend, so they are untrusted input that we then paste
/// straight into a file path.
fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if ok {
        Ok(())
    } else {
        Err(anyhow!("invalid capture id: {id:?}"))
    }
}

fn png_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.png"))
}

fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.thumb.png"))
}

fn json_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgba8,
    )?;
    Ok(out)
}

/// Write a fresh capture to the gallery and return its metadata.
pub fn save_capture(
    dir: &Path,
    image: &RgbaImage,
    scale_factor: f32,
    origin: (f64, f64),
) -> Result<CaptureMeta> {
    fs::create_dir_all(dir).with_context(|| format!("creating gallery dir {}", dir.display()))?;

    let created_at = now_millis();
    let meta = CaptureMeta {
        id: format!("cap-{created_at}"),
        created_at,
        width: image.width(),
        height: image.height(),
        scale_factor,
        origin_x: origin.0,
        origin_y: origin.1,
    };

    fs::write(png_path(dir, &meta.id), encode_png(image)?)?;

    // Scaled so the longest edge hits THUMB_MAX_EDGE; `thumbnail` preserves aspect
    // ratio on its own, so passing the cap for both edges is enough.
    let thumb = image::imageops::thumbnail(image, THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    fs::write(thumb_path(dir, &meta.id), encode_png(&thumb)?)?;

    write_item(
        dir,
        &GalleryItem {
            meta: meta.clone(),
            annotations: serde_json::Value::Array(vec![]),
        },
    )?;

    Ok(meta)
}

pub fn write_item(dir: &Path, item: &GalleryItem) -> Result<()> {
    validate_id(&item.meta.id)?;
    fs::create_dir_all(dir)?;
    fs::write(
        json_path(dir, &item.meta.id),
        serde_json::to_vec_pretty(item)?,
    )?;
    Ok(())
}

/// Replace the annotation objects for a capture, leaving the PNG untouched.
pub fn save_annotations(dir: &Path, id: &str, annotations: serde_json::Value) -> Result<()> {
    let mut item = load_item(dir, id)?;
    item.annotations = annotations;
    write_item(dir, &item)
}

pub fn load_item(dir: &Path, id: &str) -> Result<GalleryItem> {
    validate_id(id)?;
    let path = json_path(dir, id);
    let bytes =
        fs::read(&path).with_context(|| format!("reading capture {}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Absolute path of a capture's PNG, for revealing it in the file manager.
pub fn capture_path(dir: &Path, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    let path = png_path(dir, id);
    if !path.exists() {
        return Err(anyhow!("capture {id} has no image file"));
    }
    Ok(path)
}

pub fn read_png(dir: &Path, id: &str) -> Result<Vec<u8>> {
    validate_id(id)?;
    Ok(fs::read(png_path(dir, id))?)
}

pub fn read_thumb(dir: &Path, id: &str) -> Result<Vec<u8>> {
    validate_id(id)?;
    let path = thumb_path(dir, id);
    // Captures saved before thumbnails existed, or a half-finished write, should not
    // take the whole gallery down with them.
    if path.exists() {
        Ok(fs::read(path)?)
    } else {
        read_png(dir, id)
    }
}

/// All stored captures, newest first.
pub fn list_items(dir: &Path) -> Result<Vec<CaptureMeta>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut items: Vec<CaptureMeta> = fs::read_dir(dir)?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            let bytes = fs::read(&path).ok()?;
            let item: GalleryItem = serde_json::from_slice(&bytes).ok()?;
            Some(item.meta)
        })
        .collect();

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

pub fn delete_item(dir: &Path, id: &str) -> Result<()> {
    validate_id(id)?;
    for path in [png_path(dir, id), thumb_path(dir, id), json_path(dir, id)] {
        // Missing files are fine; a partial write should still be fully removable.
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ids_that_escape_the_gallery_dir() {
        assert!(validate_id("cap-1700000000000").is_ok());
        assert!(validate_id("../../etc/passwd").is_err());
        assert!(validate_id("cap/../../x").is_err());
        assert!(validate_id("").is_err());
    }

    #[test]
    fn round_trips_a_capture_with_its_annotations() {
        let dir = std::env::temp_dir().join(format!("capture-test-{}", now_millis()));
        let image = RgbaImage::new(8, 6);

        let meta = save_capture(&dir, &image, 2.0, (100.0, 50.0)).unwrap();
        assert_eq!((meta.width, meta.height), (8, 6));

        let annotations = serde_json::json!([{ "type": "arrow", "id": "a1" }]);
        save_annotations(&dir, &meta.id, annotations.clone()).unwrap();

        let loaded = load_item(&dir, &meta.id).unwrap();
        assert_eq!(loaded.annotations, annotations);
        assert_eq!(loaded.meta.scale_factor, 2.0);
        assert_eq!(list_items(&dir).unwrap().len(), 1);

        delete_item(&dir, &meta.id).unwrap();
        assert!(list_items(&dir).unwrap().is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
