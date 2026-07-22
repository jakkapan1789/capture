//! macOS text recognition, via the Vision framework.

use anyhow::{anyhow, Result};
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

use super::{RecognizedLine, TextRecognizer};

/// Languages to recognise, in priority order.
///
/// English only, deliberately. Vision does support more - Thai included, at the
/// `accurate` level - but every extra language costs accuracy on the others,
/// because the engine has to decide between them.
const LANGUAGES: [&str; 1] = ["en-US"];

pub struct VisionRecognizer;

impl TextRecognizer for VisionRecognizer {
    fn available(&self) -> bool {
        true
    }

    fn recognize(&self, image: &[u8]) -> Result<Vec<RecognizedLine>> {
        // Vision is thread-safe for this and the call blocks, so the caller is
        // expected to be off the main thread already.
        {
            let request = VNRecognizeTextRequest::new();

            // `accurate`, never `fast`: see MIN_CONFIDENCE. Language correction
            // is what turns "Setlings" into "Settings" on antialiased UI text.
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            request.setUsesLanguageCorrection(true);

            let languages: Vec<Retained<NSString>> =
                LANGUAGES.iter().map(|tag| NSString::from_str(tag)).collect();
            let refs: Vec<&NSString> = languages.iter().map(|s| s.as_ref()).collect();
            request.setRecognitionLanguages(&NSArray::from_slice(&refs));

            // `initWithData:` takes encoded image data and decodes it itself, so
            // a PNG goes straight in without being turned into a CGImage first.
            let data = NSData::with_bytes(image);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &objc2_foundation::NSDictionary::new(),
            );

            let requests = NSArray::from_slice(&[request.as_ref() as &VNRequest]);
            handler
                .performRequests_error(&requests)
                .map_err(|error| anyhow!("Vision could not read the image: {error}"))?;

            let Some(results) = request.results() else {
                return Ok(Vec::new());
            };

            let mut lines = Vec::new();
            for observation in results.iter() {
                // One candidate is enough: the alternatives exist for spelling
                // correction against a known vocabulary, which we do not have.
                let candidates = observation.topCandidates(1);
                let Some(best) = candidates.iter().next() else {
                    continue;
                };
                lines.push(RecognizedLine {
                    text: best.string().to_string(),
                    confidence: best.confidence(),
                });
            }

            Ok(lines)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vision reads text that is there, and stays quiet when it is not.
    ///
    /// Both halves matter. An engine that missed real text would make the tool
    /// useless; one that invented text on a blank image would quietly fill the
    /// clipboard with noise. The fixture is a rendered sample rather than a real
    /// screenshot so the expected strings are exact.
    ///
    /// Not `#[ignore]`d: unlike the capture tests this reads an image in memory,
    /// so it needs no Screen Recording permission and runs anywhere macOS does.
    #[test]
    fn reads_text_from_an_image_and_invents_none() {
        let recognizer = VisionRecognizer;

        let sample = include_bytes!("../../tests/fixtures/ocr-sample.png");
        let found = recognizer.recognize(sample).expect("recognize the sample");
        let text: Vec<&str> = found
            .iter()
            .filter(|line| line.confidence >= super::super::MIN_CONFIDENCE)
            .map(|line| line.text.as_str())
            .collect();

        for expected in ["Capture region", "Copy to clipboard", "Version 0.1.0"] {
            assert!(
                text.contains(&expected),
                "expected {expected:?} in {text:?}"
            );
        }

        // English alone is what makes those come back at full confidence -
        // adding a second language halves it on the same image.
        assert!(
            found.iter().all(|line| line.confidence >= super::super::MIN_CONFIDENCE),
            "every line of a clean sample should clear the threshold: {found:?}"
        );

        let blank = blank_png();
        let noise = recognizer.recognize(&blank).expect("recognize a blank image");
        let confident: Vec<_> = noise
            .iter()
            .filter(|line| line.confidence >= super::super::MIN_CONFIDENCE)
            .collect();
        assert!(
            confident.is_empty(),
            "a blank image should yield no confident text, got {confident:?}"
        );
    }

    fn blank_png() -> Vec<u8> {
        use image::{ImageEncoder, Rgb, RgbImage};

        let blank = RgbImage::from_pixel(460, 150, Rgb([255, 255, 255]));
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                blank.as_raw(),
                blank.width(),
                blank.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }
}
