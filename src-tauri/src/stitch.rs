//! Joining overlapping frames of a scrolling capture into one tall image.
//!
//! Screenshots are not photographs. Where two frames overlap they are *pixel
//! identical*, so none of the machinery of panorama stitching applies - no
//! feature detection, no blending, no seam finding. The only unknown is how far
//! the content moved, and that can be answered exactly by comparing rows.
//!
//! Rows are hashed to find a candidate offset quickly and then the actual bytes
//! are compared, so a hash collision can never produce a wrong join - only a
//! slower one.
//!
//! # Streaming
//!
//! Frames are joined as they arrive and then dropped. Keeping them all would not
//! work: capturing a 2000px-tall region at 15fps for ten seconds is 150 frames,
//! which is gigabytes of RGBA. Only the running canvas and the previous frame's
//! row hashes are held.
//!
//! # What it cannot do
//!
//! Content that changes while scrolling - a clock, a video, a blinking cursor -
//! moves rows that should have matched. The join is still found from the rows
//! that did match, so the result is a visible seam rather than a failure. There
//! is no way to fix that here; the fix is not to scroll past a video.

use anyhow::{anyhow, Result};
use image::RgbaImage;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Fewest overlapping rows that count as a real match.
///
/// A handful of matching rows is easy to hit by chance - blank space, a ruled
/// table, a repeated border - and accepting one would join the frames at the
/// wrong place. Demanding a decent run costs nothing, because a scroll that
/// leaves less overlap than this is one the user needs to be told about anyway.
const MIN_OVERLAP: usize = 16;

/// How far the content moved between two frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Advance {
    /// Nothing moved - the same view, captured twice. Dropped.
    None,
    /// The content scrolled by this many rows, which were appended.
    Rows(usize),
}

/// Why a frame could not be joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    /// The frame is a different size - the window was resized mid-capture.
    SizeChanged,
    /// The view moved backwards. Scrolling capture goes one way.
    Backwards,
    /// No overlap: scrolled further than one screen, or the content changed
    /// completely.
    NoOverlap,
}

impl Rejected {
    /// Wording aimed at the person scrolling, not at the developer.
    pub fn message(self) -> &'static str {
        match self {
            Rejected::SizeChanged => "The window changed size - start again without resizing it.",
            Rejected::Backwards => "That scrolled back up. Keep scrolling one way.",
            Rejected::NoOverlap => "Scrolled too far to join - try scrolling more slowly.",
        }
    }
}

fn hash_row(row: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    row.hash(&mut hasher);
    hasher.finish()
}

fn row_hashes(image: &RgbaImage) -> Vec<u64> {
    let stride = image.width() as usize * 4;
    image.as_raw().chunks_exact(stride).map(hash_row).collect()
}

/// Number of leading rows identical in both frames.
fn leading_match(a: &[u64], b: &[u64]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// Number of trailing rows identical in both frames.
fn trailing_match(a: &[u64], b: &[u64]) -> usize {
    a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count()
}

/// Joins frames of one scrolling capture.
pub struct Stitcher {
    width: u32,
    height: u32,
    /// Rows pinned to the top of the view, which never scroll.
    top: usize,
    /// Rows pinned to the bottom.
    bottom: usize,
    /// The output so far, row-major RGBA, header included and footer not.
    canvas: Vec<u8>,
    /// Row hashes of the last accepted frame.
    last: Vec<u64>,
    /// The last accepted frame, kept to verify a candidate join byte for byte.
    last_pixels: Vec<u8>,
    /// The footer, taken from the most recent frame and appended at the end.
    footer: Vec<u8>,
    /// Whether the pinned regions have been worked out yet - it takes two
    /// frames to see what did not move.
    measured: bool,
}

impl Stitcher {
    /// Start from the first frame.
    pub fn new(first: &RgbaImage) -> Self {
        Self {
            width: first.width(),
            height: first.height(),
            top: 0,
            bottom: 0,
            canvas: first.as_raw().clone(),
            last: row_hashes(first),
            last_pixels: first.as_raw().clone(),
            footer: Vec::new(),
            measured: false,
        }
    }

    /// Rows of output so far.
    pub fn height(&self) -> u32 {
        (self.canvas.len() / (self.width as usize * 4)) as u32 + self.bottom as u32
    }

    /// Offer the next frame.
    pub fn push(&mut self, frame: &RgbaImage) -> std::result::Result<Advance, Rejected> {
        if frame.width() != self.width || frame.height() != self.height {
            return Err(Rejected::SizeChanged);
        }

        let hashes = row_hashes(frame);

        // Pinned rows can only be seen by comparing two different views, so this
        // waits for the first frame that actually moved.
        if !self.measured && hashes != self.last {
            self.top = leading_match(&self.last, &hashes);
            self.bottom = trailing_match(&self.last, &hashes);
            // Everything matching means the whole view is pinned, which cannot
            // be true of a frame that differs. Treat it as no pinning at all.
            if self.top + self.bottom >= hashes.len() {
                self.top = 0;
                self.bottom = 0;
            }
            self.measured = true;
            // The footer is written once, at the end. Take it off the canvas now
            // that we know it is there.
            if self.bottom > 0 {
                let keep = self.canvas.len() - self.bottom * self.stride();
                self.footer = self.canvas.split_off(keep);
            }
        }

        if hashes == self.last {
            return Ok(Advance::None);
        }

        // The pinned regions are a guess made from two frames. Rows can be
        // identical by coincidence - a blank strip, a ruled border - so if the
        // join cannot be found with them, try again without them before giving
        // up. Being wrong about a header must not fail an honest capture.
        let mut offset = self.find_offset(&hashes, frame, self.top, self.bottom);
        if offset.is_none() && (self.top > 0 || self.bottom > 0) {
            if let Some(found) = self.find_offset(&hashes, frame, 0, 0) {
                // Put the footer back: it was never pinned.
                if !self.footer.is_empty() {
                    self.canvas.extend_from_slice(&std::mem::take(&mut self.footer));
                }
                self.top = 0;
                self.bottom = 0;
                offset = Some(found);
            }
        }

        let Some(offset) = offset else {
            return Err(if self.scrolled_back(&hashes) {
                Rejected::Backwards
            } else {
                Rejected::NoOverlap
            });
        };

        // Append what came into view: the last `offset` rows of the content
        // region, which is everything above any pinned footer.
        let stride = self.stride();
        let content_end = (self.height as usize - self.bottom) * stride;
        let from = content_end - offset * stride;
        self.canvas.extend_from_slice(&frame.as_raw()[from..content_end]);

        if self.bottom > 0 {
            self.footer = frame.as_raw()[content_end..].to_vec();
        }
        self.last = hashes;
        self.last_pixels = frame.as_raw().clone();
        Ok(Advance::Rows(offset))
    }

    /// The joined image.
    pub fn finish(mut self) -> Result<RgbaImage> {
        self.canvas.extend_from_slice(&self.footer);
        let height = (self.canvas.len() / (self.width as usize * 4)) as u32;
        RgbaImage::from_raw(self.width, height, self.canvas)
            .ok_or_else(|| anyhow!("stitched pixels do not describe an image"))
    }

    fn stride(&self) -> usize {
        self.width as usize * 4
    }

    /// Smallest forward offset whose whole overlap matches, byte for byte.
    ///
    /// Hashes narrow it down to a candidate; the pixels decide. A hash collision
    /// can therefore cost a wasted comparison but never a wrong join.
    fn find_offset(
        &self,
        hashes: &[u64],
        frame: &RgbaImage,
        top: usize,
        bottom: usize,
    ) -> Option<usize> {
        let height = self.height as usize;
        let content = height.checked_sub(top + bottom)?;

        for offset in 1..content {
            if content - offset < MIN_OVERLAP {
                break;
            }
            let previous = &self.last[top + offset..height - bottom];
            let current = &hashes[top..height - bottom - offset];
            if previous == current && self.pixels_match(frame, top, offset, previous.len()) {
                return Some(offset);
            }
        }
        None
    }

    fn pixels_match(&self, frame: &RgbaImage, top: usize, offset: usize, rows: usize) -> bool {
        let stride = self.stride();
        let previous = &self.last_pixels[(top + offset) * stride..(top + offset + rows) * stride];
        let current = &frame.as_raw()[top * stride..(top + rows) * stride];
        previous == current
    }

    /// Whether the view moved the other way, which is worth saying out loud.
    fn scrolled_back(&self, hashes: &[u64]) -> bool {
        let height = self.height as usize;
        let content = height.saturating_sub(self.top + self.bottom);
        (1..content).any(|offset| {
            content - offset >= MIN_OVERLAP
                && hashes[self.top + offset..height - self.bottom]
                    == self.last[self.top..height - self.bottom - offset]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tall page whose every row is distinctive, as real text content is.
    fn page(height: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(80, height, |x, y| {
            // Cheap deterministic noise: neighbouring rows must not collide.
            let n = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503) ^ seed;
            image::Rgba([(n >> 3) as u8, (n >> 11) as u8, (n >> 19) as u8, 255])
        })
    }

    /// Slice a page into the frames a scroll through it would produce.
    fn frames(page: &RgbaImage, view: u32, steps: &[u32]) -> Vec<RgbaImage> {
        let mut out = Vec::new();
        let mut y = 0u32;
        for step in std::iter::once(&0).chain(steps) {
            y += step;
            if y + view > page.height() {
                break;
            }
            out.push(image::imageops::crop_imm(page, 0, y, page.width(), view).to_image());
        }
        out
    }

    fn pin(frames: &mut [RgbaImage], header: Option<&RgbaImage>, footer: Option<&RgbaImage>) {
        for frame in frames.iter_mut() {
            if let Some(header) = header {
                image::imageops::replace(frame, header, 0, 0);
            }
            if let Some(footer) = footer {
                let y = (frame.height() - footer.height()) as i64;
                image::imageops::replace(frame, footer, 0, y);
            }
        }
    }

    fn stitch_all(frames: &[RgbaImage]) -> Result<RgbaImage> {
        let mut stitcher = Stitcher::new(&frames[0]);
        for frame in &frames[1..] {
            stitcher
                .push(frame)
                .map_err(|error| anyhow!("{}", error.message()))?;
        }
        stitcher.finish()
    }

    /// The whole point: frames sliced out of a page must join back into it,
    /// pixel for pixel. Everything else here is a way that can go wrong.
    #[test]
    fn rebuilds_the_page_it_was_sliced_from() {
        let source = page(600, 1);
        let joined = stitch_all(&frames(&source, 200, &[100; 4])).unwrap();

        assert_eq!(joined.dimensions(), (80, 600));
        assert_eq!(joined.as_raw(), source.as_raw(), "pixels must be identical");
    }

    /// Real scrolling is never a constant number of rows - a trackpad flick is
    /// not a mouse wheel click.
    #[test]
    fn copes_with_uneven_scroll_steps() {
        let source = page(600, 2);
        let joined = stitch_all(&frames(&source, 200, &[37, 149, 8, 96, 61])).unwrap();

        let height = joined.height() as usize;
        assert!(height > 400, "should have grown well past one view, got {height}");
        assert_eq!(
            joined.as_raw()[..],
            source.as_raw()[..height * 80 * 4],
            "pixels must be identical"
        );
    }

    /// A header pinned to the top must appear once, not once per frame.
    #[test]
    fn writes_a_pinned_header_once() {
        let source = page(600, 3);
        let header = page(24, 99);
        let mut sliced = frames(&source, 200, &[100; 4]);
        pin(&mut sliced, Some(&header), None);

        let joined = stitch_all(&sliced).unwrap();

        assert_eq!(joined.height(), 600, "a repeated header would make it taller");
        // The header is there, once, and the scrolling content underneath is
        // the page - starting below the header, which the header overwrote.
        let stride = 80 * 4;
        assert_eq!(&joined.as_raw()[..24 * stride], header.as_raw());
        assert_eq!(
            &joined.as_raw()[24 * stride..600 * stride],
            &source.as_raw()[24 * stride..600 * stride],
        );
    }

    /// Toolbars and status bars are pinned to the bottom just as often.
    #[test]
    fn writes_a_pinned_footer_once() {
        let source = page(600, 4);
        let footer = page(20, 77);
        let mut sliced = frames(&source, 200, &[100; 4]);
        pin(&mut sliced, None, Some(&footer));

        let joined = stitch_all(&sliced).unwrap();

        assert_eq!(joined.height(), 600, "a repeated footer would make it taller");
        let stride = 80 * 4;
        let tail = joined.as_raw().len() - 20 * stride;
        assert_eq!(&joined.as_raw()[tail..], footer.as_raw(), "footer at the end");
    }

    /// Capturing faster than the user scrolls is the normal case, and must cost
    /// nothing but a dropped frame.
    #[test]
    fn ignores_frames_where_nothing_moved() {
        let source = page(600, 5);
        let sliced = frames(&source, 200, &[100; 4]);

        let mut stitcher = Stitcher::new(&sliced[0]);
        assert_eq!(stitcher.push(&sliced[0]), Ok(Advance::None));
        assert_eq!(stitcher.push(&sliced[1]), Ok(Advance::Rows(100)));
        assert_eq!(stitcher.push(&sliced[1]), Ok(Advance::None));

        assert_eq!(stitcher.finish().unwrap().height(), 300);
    }

    /// Scrolling further than one view leaves nothing to join on. Saying so is
    /// the whole job - joining anyway would silently lose a screenful.
    #[test]
    fn refuses_frames_with_no_overlap() {
        let source = page(800, 6);
        let sliced = frames(&source, 200, &[250]);

        let mut stitcher = Stitcher::new(&sliced[0]);
        assert_eq!(stitcher.push(&sliced[1]), Err(Rejected::NoOverlap));
    }

    /// Scrolling back up is a different mistake and deserves a different answer.
    #[test]
    fn recognises_scrolling_the_other_way() {
        let source = page(600, 7);
        let sliced = frames(&source, 200, &[100]);

        let mut stitcher = Stitcher::new(&sliced[1]);
        assert_eq!(stitcher.push(&sliced[0]), Err(Rejected::Backwards));
    }

    #[test]
    fn refuses_a_frame_of_a_different_size() {
        let a = page(200, 8);
        let b = page(220, 8);

        let mut stitcher = Stitcher::new(&a);
        assert_eq!(stitcher.push(&b), Err(Rejected::SizeChanged));
    }

    /// One frame is a perfectly good scrolling capture of a short page.
    #[test]
    fn a_single_frame_comes_back_unchanged() {
        let only = page(200, 9);
        let joined = Stitcher::new(&only).finish().unwrap();

        assert_eq!(joined.as_raw(), only.as_raw());
    }

    /// Rows identical by coincidence - a blank strip at the top - must not be
    /// mistaken for a pinned header and then break the join.
    #[test]
    fn survives_a_blank_strip_that_only_looks_pinned() {
        let mut source = page(600, 10);
        for y in 0..40 {
            for x in 0..80 {
                source.put_pixel(x, y, image::Rgba([255, 255, 255, 255]));
            }
        }
        // Scrolling by less than the blank strip leaves its rows matching in
        // place, which looks exactly like pinning.
        let joined = stitch_all(&frames(&source, 200, &[30, 30, 30])).unwrap();

        let height = joined.height() as usize;
        assert!(height >= 290, "expected the page to grow, got {height}");
        assert_eq!(joined.as_raw()[..], source.as_raw()[..height * 80 * 4]);
    }
}
