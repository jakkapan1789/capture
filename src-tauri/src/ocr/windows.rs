//! Windows text recognition, via `Windows.Media.Ocr`.
//!
//! The engine ships with Windows 10+, so there is nothing to bundle, and en-US
//! is present on effectively every install, so no language pack is needed. It is
//! the same engine PowerToys Text Extractor uses.
//!
//! Unlike Vision, Windows OCR reports **no confidence** - `OcrWord` and
//! `OcrLine` carry only text and a bounding box. So there is nothing to threshold
//! against, and every line is returned with a confidence of 1.0, which keeps it
//! above [`MIN_CONFIDENCE`](super::MIN_CONFIDENCE) and is honest about the engine
//! not giving us a number. In practice this OCR emits far less of the junk that
//! Vision's low-confidence guesses do, so the threshold was doing less work
//! there than it looks.

use anyhow::{anyhow, Context, Result};
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;

use super::{RecognizedLine, TextRecognizer};

/// The language to recognise. English only, matching macOS, and for the same
/// reason: a second language costs accuracy on the first.
const LANGUAGE_TAG: &str = "en-US";

pub struct WindowsRecognizer;

impl WindowsRecognizer {
    /// The OCR engine for our language, if the system can provide one.
    ///
    /// Built fresh per call rather than cached: `OcrEngine` is not documented as
    /// thread-safe, recognition runs on a pool thread, and building it is cheap
    /// next to recognising an image.
    fn engine() -> Result<OcrEngine> {
        let language = Language::CreateLanguage(&HSTRING::from(LANGUAGE_TAG))
            .context("could not construct the en-US language")?;
        // Returns null - surfaced here as an error - when the OCR language pack
        // is not installed, which for en-US is rare but not impossible.
        OcrEngine::TryCreateFromLanguage(&language)
            .context("Windows has no OCR engine for en-US")
    }
}

impl TextRecognizer for WindowsRecognizer {
    fn available(&self) -> bool {
        Self::engine().is_ok()
    }

    fn recognize(&self, image: &[u8]) -> Result<Vec<RecognizedLine>> {
        let engine = Self::engine()?;

        // Decode with the `image` crate rather than WinRT's own decoder: the PNG
        // is already in hand, `image` is already a dependency, and this avoids a
        // stream and two more async calls for the same bytes.
        let rgba = image::load_from_memory(image)
            .context("could not decode the image for OCR")?
            .to_rgba8();
        let (width, height) = (rgba.width() as i32, rgba.height() as i32);

        // The OCR engine wants BGRA; `image` gives RGBA. One swap in place.
        let mut bgra = rgba.into_raw();
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        let buffer = CryptographicBuffer::CreateFromByteArray(&bgra)
            .context("could not wrap the pixels in a WinRT buffer")?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            width,
            height,
        )
        .context("could not build a bitmap from the pixels")?;

        // Straight alpha, because the pixels come from a PNG rather than a
        // pre-multiplied source; a mismatch here darkens the image the engine
        // sees. A screenshot is opaque, so this rarely matters, but it is free
        // to be correct.
        let bitmap =
            if bitmap.BitmapAlphaMode().unwrap_or(BitmapAlphaMode::Straight)
                == BitmapAlphaMode::Premultiplied
            {
                SoftwareBitmap::Convert(
                    &bitmap,
                    BitmapPixelFormat::Bgra8,
                )
                .context("could not normalise the bitmap")?
            } else {
                bitmap
            };

        let result = block_on(engine.RecognizeAsync(&bitmap)?)?;

        let mut lines = Vec::new();
        for line in result.Lines()? {
            let text = line.Text()?.to_string_lossy();
            if !text.trim().is_empty() {
                // No confidence from this engine; 1.0 keeps every line past the
                // shared threshold. See the module comment.
                lines.push(RecognizedLine {
                    text,
                    confidence: 1.0,
                });
            }
        }
        Ok(lines)
    }
}

/// Block on a WinRT async operation from a synchronous context.
///
/// `recognize` runs on a blocking pool thread and the trait method is sync, so
/// there is no executor to `.await` on. A completion handler signals a channel
/// and this waits on it - the operation settles in milliseconds for one image.
fn block_on<T>(
    operation: windows_future::IAsyncOperation<T>,
) -> Result<T>
where
    T: windows_core::RuntimeType + 'static,
{
    use windows_future::{AsyncOperationCompletedHandler, AsyncStatus};

    let (tx, rx) = std::sync::mpsc::channel();
    operation.SetCompleted(&AsyncOperationCompletedHandler::new(
        move |_op, _status: AsyncStatus| {
            // Ignore a send error: it only means the receiver gave up, and there
            // is nothing to report a failure to from inside the callback.
            let _ = tx.send(());
            Ok(())
        },
    ))?;

    rx.recv()
        .map_err(|_| anyhow!("the OCR operation never completed"))?;
    operation
        .GetResults()
        .context("the OCR operation reported a failure")
}
