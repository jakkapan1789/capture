//! Text recognition.
//!
//! Behind a trait for the same reason capture is: the implementation is whatever
//! the OS provides, and that differs per platform.
//!
//! **macOS** uses Vision, **Windows** will use `Windows.Media.Ocr`. Both ship
//! with the operating system, which is the whole point - a bundled engine like
//! Tesseract would add 15-25MB and a model file to an app whose small size is
//! the reason it is a Tauri app at all. Neither sends anything over the network,
//! which matters more here than usual: screenshots are exactly the kind of thing
//! that should not leave the machine to be read.

use anyhow::Result;

#[cfg(target_os = "macos")]
mod vision;

/// One line of recognised text.
///
/// Lines rather than one blob: OCR finds text in visual order, and a caller that
/// wants a single string can join them, while one that wants to drop the
/// low-confidence ones cannot un-join.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedLine {
    pub text: String,
    /// 0.0 to 1.0, as reported by the engine.
    pub confidence: f32,
}

/// Lines below this are dropped.
///
/// Measured on real captures: with Vision's `accurate` level, genuine text comes
/// back at 0.90-1.00 while icons and window chrome misread as text land around
/// 0.30 ("WURe CK", "El T O O tt X"). 0.5 sits in the empty space between them.
///
/// This only works at `accurate`. The `fast` level never reports above 0.50, so
/// there is nothing to threshold against - which is why we do not use it, even
/// though it is 4x quicker.
pub const MIN_CONFIDENCE: f32 = 0.5;

pub trait TextRecognizer: Send + Sync {
    /// Whether this build can recognise text at all.
    fn available(&self) -> bool;

    /// Read text from an encoded image (PNG, as everything else here uses).
    ///
    /// Takes encoded bytes rather than an `RgbaImage` because both platform APIs
    /// decode image data themselves, and the caller already has a PNG in hand.
    fn recognize(&self, image: &[u8]) -> Result<Vec<RecognizedLine>>;
}

/// A recogniser that says so rather than pretending.
///
/// Used until the Windows implementation lands, so the command exists on every
/// platform and the UI can disable the tool instead of failing at the point of
/// use. Never constructed on macOS, which is why it reads as dead code there.
#[allow(dead_code)]
pub struct Unsupported;

impl TextRecognizer for Unsupported {
    fn available(&self) -> bool {
        false
    }

    fn recognize(&self, _image: &[u8]) -> Result<Vec<RecognizedLine>> {
        Err(anyhow::anyhow!(
            "text recognition is not available on this platform yet"
        ))
    }
}

pub fn create_recognizer() -> Box<dyn TextRecognizer> {
    #[cfg(target_os = "macos")]
    {
        Box::new(vision::VisionRecognizer)
    }

    // TODO(windows): replace with a `Windows.Media.Ocr` implementation. The
    // engine is part of Windows 10+, and en-US is present on effectively every
    // install, so it needs no language pack of its own.
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(Unsupported)
    }
}
