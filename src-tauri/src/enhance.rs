//! Making a small capture readable.
//!
//! When you capture a tiny image - a thumbnail in an email, a cramped table -
//! there is nothing wrong with the pixels, there just are not enough of them to
//! read comfortably. This does not invent detail that was never captured; no
//! amount of processing can. It scales the image up with a good resampling
//! filter so the pixels there are bigger and cleaner, then sharpens the edges so
//! text reads more crisply. The result is larger and easier on the eye, which is
//! the actual complaint - not that it is missing information.
//!
//! It stays local, like everything else here: `image` is already a dependency,
//! there is no model to bundle and nothing leaves the machine.

use anyhow::Result;
use image::imageops::FilterType;
use image::RgbaImage;

/// Longest edge to try to reach, in pixels.
///
/// A capture already this size or larger is not enlarged - it is not the small
/// image this is for, and blowing it up would only soften it.
const TARGET_LONGEST_EDGE: u32 = 1200;

/// Never enlarge by more than this. Past it the result is mostly interpolation
/// and looks worse, not better - honesty about there being no detail to recover.
const MAX_SCALE: f32 = 6.0;

/// Hard cap on the output's longest edge, so a already-biggish image cannot be
/// turned into something enormous.
const MAX_LONGEST_EDGE: u32 = 4000;

/// Unsharp mask strength. A gentle radius and a small threshold sharpen letter
/// edges without turning flat areas into noise.
const SHARPEN_SIGMA: f32 = 1.2;
const SHARPEN_THRESHOLD: i32 = 2;

/// How much bigger the enhanced image will be, for the same image.
///
/// Separated out so the command can refuse a no-op before doing any work, and so
/// the annotation scale of the result can be set from the same number.
pub fn scale_for(width: u32, height: u32) -> f32 {
    let longest = width.max(height);
    if longest == 0 || longest >= TARGET_LONGEST_EDGE {
        return 1.0;
    }

    let wanted = TARGET_LONGEST_EDGE as f32 / longest as f32;
    let capped_by_max_scale = wanted.min(MAX_SCALE);
    // And never past the absolute size ceiling.
    let ceiling = MAX_LONGEST_EDGE as f32 / longest as f32;
    capped_by_max_scale.min(ceiling).max(1.0)
}

/// Whether enhancing would change anything.
pub fn would_help(width: u32, height: u32) -> bool {
    scale_for(width, height) > 1.0
}

/// Upscale and sharpen, or return the image unchanged when it is already big
/// enough that enlarging it would only soften it.
pub fn enhance(image: &RgbaImage) -> Result<RgbaImage> {
    let scale = scale_for(image.width(), image.height());
    if scale <= 1.0 {
        return Ok(image.clone());
    }

    let new_width = ((image.width() as f32 * scale).round() as u32).max(1);
    let new_height = ((image.height() as f32 * scale).round() as u32).max(1);

    // Lanczos3 gives the cleanest enlargement of the filters available - sharper
    // than bilinear, without the ringing a naive sharpen alone would add.
    let scaled = image::imageops::resize(image, new_width, new_height, FilterType::Lanczos3);

    // Then an unsharp mask, which is what actually makes small text legible: it
    // lifts the contrast right at the edges the resize softened.
    Ok(image::imageops::unsharpen(
        &scaled,
        SHARPEN_SIGMA,
        SHARPEN_THRESHOLD,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([120, 120, 120, 255]))
    }

    /// A small image is enlarged; the whole point.
    #[test]
    fn enlarges_a_small_capture() {
        let small = solid(100, 40);
        let out = enhance(&small).unwrap();

        assert!(out.width() > 100 && out.height() > 40, "should be bigger, got {:?}", out.dimensions());
        // Aspect ratio is preserved.
        let ratio_in = 100.0 / 40.0;
        let ratio_out = out.width() as f32 / out.height() as f32;
        assert!((ratio_in - ratio_out).abs() < 0.05, "aspect changed: {ratio_out}");
    }

    /// An image already large enough is left exactly as it was - enlarging it
    /// would soften it for nothing.
    #[test]
    fn leaves_a_large_capture_untouched() {
        let big = solid(2000, 1400);
        let out = enhance(&big).unwrap();

        assert_eq!(out.dimensions(), (2000, 1400));
        assert_eq!(out.as_raw(), big.as_raw(), "a large image must not be resampled");
        assert!(!would_help(2000, 1400));
    }

    /// The enlargement is bounded: a 10px image does not become 1200px (120x),
    /// because past a point it is all interpolation.
    #[test]
    fn caps_how_far_a_tiny_image_is_pushed() {
        assert_eq!(scale_for(10, 10), MAX_SCALE, "a tiny image is capped at MAX_SCALE");
        let out = enhance(&solid(10, 10)).unwrap();
        assert_eq!(out.dimensions(), (60, 60));
    }

    /// The absolute size ceiling wins even over the target edge.
    #[test]
    fn never_exceeds_the_size_ceiling() {
        // 900px wants ~1.33x to reach 1200, well under the ceiling - fine.
        assert!(scale_for(900, 900) > 1.0);
        // A degenerate 1px image would want 1200x; MAX_SCALE caps it first, and
        // the result stays tiny rather than hitting the ceiling.
        let out = enhance(&solid(1, 1)).unwrap();
        assert!(out.width() <= MAX_LONGEST_EDGE);
    }

    /// The result is not just bigger, it is sharper: an unsharp mask raises the
    /// contrast at an edge, so the spread of pixel values across a black/white
    /// boundary widens. A plain resize would only blur it.
    #[test]
    fn sharpens_edges_rather_than_only_enlarging() {
        // A small image with a hard vertical edge - like the stroke of a letter.
        let mut edge = RgbaImage::new(120, 40);
        for (x, _y, px) in edge.enumerate_pixels_mut() {
            let v = if x < 60 { 20 } else { 235 };
            *px = Rgba([v, v, v, 255]);
        }

        let out = enhance(&edge).unwrap();
        assert!(out.width() > 120, "should be enlarged");

        // Sample the row across the boundary in the output and look for values
        // pushed *past* the originals - overshoot is the signature of sharpening.
        let mid_y = out.height() / 2;
        let darkest = (0..out.width()).map(|x| out.get_pixel(x, mid_y).0[0]).min().unwrap();
        let brightest = (0..out.width()).map(|x| out.get_pixel(x, mid_y).0[0]).max().unwrap();
        assert!(
            darkest < 20 || brightest > 235,
            "sharpening should overshoot the 20/235 edge, got {darkest}..{brightest}"
        );
    }

    /// Enhancing must never crash on the awkward shapes captures come in.
    #[test]
    fn survives_extreme_shapes() {
        for (w, h) in [(1u32, 1u32), (2000, 1), (1, 2000), (3, 500)] {
            let out = enhance(&solid(w, h)).unwrap();
            assert!(out.width() >= 1 && out.height() >= 1, "{w}x{h} produced {:?}", out.dimensions());
        }
    }
}
