//! Gallery storage.
//!
//! Every capture is written as three files in one flat directory:
//!
//! ```text
//! <app-data>/gallery/<id>.png         original, never touched again
//! <app-data>/gallery/<id>.thumb.jpg   downscaled, for the gallery strip
//! <app-data>/gallery/<id>.json        metadata + annotation objects
//! <app-data>/gallery/<id>.piece-<pid>.png   flattened cut-out, if any
//! ```
//!
//! The PNG is the pristine capture and the JSON holds the annotations as data.
//! Nothing is ever flattened into the PNG - that only happens on export - which is
//! what makes a history item re-editable months later.
//!
//! Cut-out pieces are the one deliberate exception. A cut takes the picture as it
//! looks, annotations included, which cannot be expressed as a rectangle into the
//! original; those pixels are flattened at the moment of the cut. Everything the
//! piece was cut *from* is still an editable object underneath it, and the
//! capture PNG is as untouched as ever.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder, RgbaImage,
};
use serde::{Deserialize, Serialize};

/// Longest edge of a generated thumbnail, in pixels.
const THUMB_MAX_EDGE: u32 = 320;

/// JPEG quality for thumbnails.
///
/// A thumbnail is decoration for a 154x82 row, never something to edit, so
/// lossless is the wrong trade: downscaling a screenshot destroys the flat runs
/// PNG relies on, and the files came out at 54-125KB each - comparable to the
/// full capture. The same image as JPEG is 13-16KB. Every one of them is read
/// over IPC and decoded while the history is being drawn.
const THUMB_QUALITY: u8 = 80;

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
    dir.join(format!("{id}.thumb.jpg"))
}

/// Thumbnails written before they became JPEGs. Still read, never written.
fn legacy_thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.thumb.png"))
}

/// Encode a thumbnail: JPEG, and therefore without an alpha channel.
fn encode_thumb(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut rgb = Vec::with_capacity(image.as_raw().len() / 4 * 3);
    for pixel in image.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
    }

    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY).write_image(
        &rgb,
        image.width(),
        image.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

fn json_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Filename prefix for every piece cut out of a capture.
fn piece_prefix(id: &str) -> String {
    format!("{id}.piece-")
}

fn piece_path(dir: &Path, capture_id: &str, piece_id: &str) -> PathBuf {
    dir.join(format!("{}{piece_id}.png", piece_prefix(capture_id)))
}

/// Store a cut-out's pixels beside the capture it was taken from.
///
/// A piece is a flattened snapshot - the screenshot *and* whatever annotations
/// were over it at the moment of the cut - so unlike everything else in this
/// app it cannot be re-derived from the original PNG. It still does not belong
/// in the annotation JSON: that file is rewritten on every autosave and read for
/// every gallery listing, and a few hundred KB of base64 in it would be paid for
/// on both paths. A sibling PNG keeps the JSON small and the writes cheap.
pub fn write_piece(dir: &Path, capture_id: &str, piece_id: &str, png: &[u8]) -> Result<()> {
    validate_id(capture_id)?;
    validate_id(piece_id)?;
    fs::create_dir_all(dir)?;
    fs::write(piece_path(dir, capture_id, piece_id), png)?;
    Ok(())
}

pub fn read_piece(dir: &Path, capture_id: &str, piece_id: &str) -> Result<Vec<u8>> {
    validate_id(capture_id)?;
    validate_id(piece_id)?;
    let path = piece_path(dir, capture_id, piece_id);
    fs::read(&path).with_context(|| format!("reading piece {}", path.display()))
}

/// Every piece file belonging to a capture, as `(path, piece_id)`.
fn pieces_of(dir: &Path, capture_id: &str) -> Vec<(PathBuf, String)> {
    let prefix = piece_prefix(capture_id);
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            let piece_id = name.strip_prefix(&prefix)?.strip_suffix(".png")?;
            Some((path.clone(), piece_id.to_string()))
        })
        .collect()
}

/// Delete piece files this capture no longer refers to.
///
/// Undoing a cut, or deleting the piece, leaves its PNG behind - the frontend
/// owns the annotation model and cannot be asked to clean up files. So every
/// save states which pieces are still live and anything else is removed. Called
/// from `save_annotations`, which already runs on every edit.
pub fn prune_pieces(dir: &Path, capture_id: &str, live: &[String]) -> Result<()> {
    validate_id(capture_id)?;
    for (path, piece_id) in pieces_of(dir, capture_id) {
        if !live.iter().any(|id| id == &piece_id) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// Encode to PNG, dropping the alpha channel when nothing is transparent.
///
/// A screen capture is opaque: the compositor has already flattened everything,
/// so the alpha channel is a stored quarter of every file that carries no
/// information. Measured over real captures on this machine, writing RGB instead
/// makes files 14-18% smaller and encoding slightly faster (41.6ms against
/// 45.1ms on a 2022x1476 frame) - better on both axes rather than a trade.
///
/// The opacity scan is what keeps this safe: should a frame ever arrive with
/// real transparency, it still round-trips untouched.
pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = PngEncoder::new(&mut out);

    if image.pixels().all(|pixel| pixel.0[3] == u8::MAX) {
        // One allocation for the whole buffer. Collecting per-pixel `Vec`s here
        // instead costs more time than the encode itself saves.
        let mut rgb = Vec::with_capacity(image.as_raw().len() / 4 * 3);
        for pixel in image.pixels() {
            rgb.extend_from_slice(&pixel.0[..3]);
        }
        encoder.write_image(&rgb, image.width(), image.height(), ExtendedColorType::Rgb8)?;
    } else {
        encoder.write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )?;
    }

    Ok(out)
}

/// Size of a thumbnail whose longest edge is [`THUMB_MAX_EDGE`].
///
/// `imageops::thumbnail` resizes to *exactly* the dimensions given, so passing
/// the cap for both edges squashes every capture into a square - which is what
/// this app did until the stored files were measured. The gallery draws them
/// with `object-fit: cover`, so the distortion showed up as stretched history
/// thumbnails rather than as an obviously broken image.
fn thumb_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }

    // A capture smaller than the cap is already thumbnail-sized. Scaling it up
    // would cost bytes and add nothing.
    let longest = width.max(height);
    if longest <= THUMB_MAX_EDGE {
        return (width, height);
    }

    // Scale both edges by the same ratio, in integer maths so the two never
    // drift apart. `max(1)` keeps an extreme aspect ratio from rounding an edge
    // down to zero, which PNG cannot encode.
    let scale = |edge: u32| {
        ((edge as u64 * THUMB_MAX_EDGE as u64) / longest as u64).max(1) as u32
    };
    (scale(width), scale(height))
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

    let (thumb_width, thumb_height) = thumb_size(image.width(), image.height());
    let thumb = image::imageops::thumbnail(image, thumb_width, thumb_height);
    fs::write(thumb_path(dir, &meta.id), encode_thumb(&thumb)?)?;

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
    // Newest first, then the PNG thumbnails older captures still have. Captures
    // saved before thumbnails existed at all fall back to the full image rather
    // than taking the whole gallery down with them.
    for path in [thumb_path(dir, id), legacy_thumb_path(dir, id)] {
        if path.exists() {
            return Ok(fs::read(path)?);
        }
    }
    read_png(dir, id)
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
    for path in [
        png_path(dir, id),
        thumb_path(dir, id),
        legacy_thumb_path(dir, id),
        json_path(dir, id),
    ] {
        // Missing files are fine; a partial write should still be fully removable.
        let _ = fs::remove_file(path);
    }
    // Cut-outs are stored as sibling files, so deleting a capture has to take
    // them with it or they are orphaned forever - nothing else references them.
    for (path, _) in pieces_of(dir, id) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Piece files are the one thing here that cannot be re-derived, so the
    /// rules about when they are removed are worth pinning down.
    #[test]
    fn prunes_pieces_that_no_annotation_refers_to() {
        let dir = std::env::temp_dir().join(format!("capture-pieces-{}", now_millis()));
        let capture = "cap-1";
        write_piece(&dir, capture, "keep", b"png-a").unwrap();
        write_piece(&dir, capture, "drop", b"png-b").unwrap();
        // A piece belonging to a *different* capture must survive regardless.
        write_piece(&dir, "cap-2", "other", b"png-c").unwrap();

        prune_pieces(&dir, capture, &["keep".to_string()]).unwrap();

        assert_eq!(read_piece(&dir, capture, "keep").unwrap(), b"png-a");
        assert!(read_piece(&dir, capture, "drop").is_err(), "unreferenced piece should be gone");
        assert_eq!(read_piece(&dir, "cap-2", "other").unwrap(), b"png-c");

        // Deleting a capture takes its pieces with it, and leaves others alone.
        delete_item(&dir, capture).unwrap();
        assert!(read_piece(&dir, capture, "keep").is_err(), "pieces should follow the capture");
        assert_eq!(read_piece(&dir, "cap-2", "other").unwrap(), b"png-c");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Ids reach this module from the frontend, and a piece id is pasted into a
    /// path just like a capture id is.
    #[test]
    fn piece_ids_cannot_escape_the_gallery_dir() {
        let dir = std::env::temp_dir().join(format!("capture-escape-{}", now_millis()));
        assert!(write_piece(&dir, "cap-1", "../../evil", b"x").is_err());
        assert!(write_piece(&dir, "../../evil", "piece", b"x").is_err());
        assert!(read_piece(&dir, "cap-1", "../../evil").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The gallery reads one of these per visible row, so what comes out of
    /// `save_capture` has to actually be the compact format.
    #[test]
    fn thumbnails_are_stored_as_jpeg() {
        let dir = std::env::temp_dir().join(format!("capture-thumb-{}", now_millis()));
        let mut image = RgbaImage::new(800, 600);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 90, 255]);
        }

        let meta = save_capture(&dir, &image, 1.0, (0.0, 0.0)).unwrap();
        let thumb = read_thumb(&dir, &meta.id).unwrap();
        assert_eq!(&thumb[..2], &[0xff, 0xd8], "thumbnail should be JPEG");

        let decoded = image::load_from_memory(&thumb).unwrap();
        let (w, h) = thumb_size(800, 600);
        assert_eq!((decoded.width(), decoded.height()), (w, h));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Captures written before thumbnails were JPEG must keep working, and must
    /// still be fully deletable.
    #[test]
    fn reads_and_deletes_png_thumbnails_from_older_captures() {
        let dir = std::env::temp_dir().join(format!("capture-legacy-{}", now_millis()));
        let image = RgbaImage::new(40, 30);
        let meta = save_capture(&dir, &image, 1.0, (0.0, 0.0)).unwrap();

        // Replace the JPEG with a PNG one, as an older build would have left it.
        fs::remove_file(thumb_path(&dir, &meta.id)).unwrap();
        let legacy = encode_png(&RgbaImage::new(8, 6)).unwrap();
        fs::write(legacy_thumb_path(&dir, &meta.id), &legacy).unwrap();

        assert_eq!(read_thumb(&dir, &meta.id).unwrap(), legacy, "should fall back to the PNG");

        delete_item(&dir, &meta.id).unwrap();
        assert!(!legacy_thumb_path(&dir, &meta.id).exists(), "legacy thumbnail should be deleted");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A capture is a screenshot of a fixed shape; a thumbnail of it must keep
    /// that shape.
    ///
    /// `imageops::thumbnail` resizes to exactly the dimensions asked for, so the
    /// obvious call - passing the cap for both edges - silently squares every
    /// thumbnail. This is a regression test for exactly that: every stored
    /// thumbnail on this machine was 320x320 regardless of its source.
    #[test]
    fn thumbnails_keep_the_capture_aspect_ratio() {
        for (width, height) in [(2022u32, 1476u32), (1476, 2022), (3840, 1080), (100, 100)] {
            let (tw, th) = thumb_size(width, height);
            assert_eq!(
                tw.max(th),
                THUMB_MAX_EDGE.min(width.max(height)),
                "{width}x{height} should fill the long edge"
            );

            let source = width as f64 / height as f64;
            let thumb = tw as f64 / th as f64;
            assert!(
                (source - thumb).abs() / source < 0.01,
                "{width}x{height} became {tw}x{th}, aspect {source:.3} -> {thumb:.3}"
            );
        }
    }

    /// Degenerate sizes must not produce a zero-pixel image, which PNG cannot
    /// encode at all.
    #[test]
    fn thumbnails_of_extreme_shapes_stay_encodable() {
        for (width, height) in [(4000u32, 1u32), (1, 4000), (0, 0), (1, 1)] {
            let (tw, th) = thumb_size(width, height);
            assert!(tw >= 1 && th >= 1, "{width}x{height} became {tw}x{th}");
        }
    }

    /// Opaque captures are stored without an alpha channel, and both encodings
    /// have to survive the round trip.
    #[test]
    fn drops_alpha_only_when_the_frame_is_opaque() {
        let mut opaque = RgbaImage::new(4, 3);
        for pixel in opaque.pixels_mut() {
            *pixel = image::Rgba([10, 20, 30, 255]);
        }
        let decoded = image::load_from_memory(&encode_png(&opaque).unwrap()).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgb8, "opaque should lose alpha");
        assert_eq!(decoded.to_rgba8(), opaque, "pixels must survive the round trip");

        let mut translucent = opaque.clone();
        translucent.put_pixel(1, 1, image::Rgba([10, 20, 30, 128]));
        let decoded = image::load_from_memory(&encode_png(&translucent).unwrap()).unwrap();
        assert_eq!(
            decoded.color(),
            image::ColorType::Rgba8,
            "real transparency must be kept"
        );
        assert_eq!(decoded.to_rgba8(), translucent);
    }

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
