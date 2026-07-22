//! A scrolling capture in progress.
//!
//! The user scrolls; we watch. Nothing is sent to the window being captured -
//! no synthetic scroll events, and so no Accessibility permission on macOS and
//! no fight with elevated windows on Windows. The cost is that the user has to
//! do the scrolling, which they were going to do anyway to find what they wanted
//! to capture.
//!
//! Frames are grabbed on a background thread and handed straight to the
//! [`Stitcher`], which joins and drops them. See `stitch.rs` for why that works.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use image::RgbaImage;

use crate::capture::{LogicalRegion, ScreenCapture};
use crate::stitch::{Advance, Stitcher};

/// How often to grab the region.
///
/// A 900x700 region takes ~20ms to grab on this machine and ~1.5ms to join, so
/// this is a deliberate throttle rather than a limit: at 20fps someone scrolling
/// a brisk 1000px/s still leaves 650px of overlap on a 700px view, which is far
/// more than the join needs. Grabbing as fast as possible would only spend
/// battery to make an easy problem easier.
const INTERVAL: Duration = Duration::from_millis(50);

/// What the UI needs to show while it runs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Height of the image joined so far, in physical pixels.
    pub height: u32,
    /// Set when the last frame could not be joined, in words for the user.
    pub problem: Option<String>,
}

/// A running session. Dropping it does not stop the thread; call [`Session::stop`].
pub struct Session {
    stop: Arc<AtomicBool>,
    height: Arc<AtomicUsize>,
    /// Set by the worker when it gives up, so `stop` can explain why.
    failure: Arc<Mutex<Option<String>>>,
    result: Arc<Mutex<Option<RgbaImage>>>,
    worker: Option<JoinHandle<()>>,
    pub region: LogicalRegion,
    pub scale_factor: f32,
    pub origin: (f64, f64),
}

impl Session {
    /// Grab the first frame and start watching.
    ///
    /// The first grab happens here rather than on the thread so that a region
    /// that cannot be captured at all fails immediately, while there is still a
    /// caller to tell.
    pub fn start(
        capture: Arc<dyn ScreenCapture>,
        region: LogicalRegion,
        mut on_progress: impl FnMut(Progress) + Send + 'static,
    ) -> Result<Self> {
        let first = capture.capture_region(region)?;
        let scale_factor = first.scale_factor;
        let origin = first.origin;

        let stop = Arc::new(AtomicBool::new(false));
        let height = Arc::new(AtomicUsize::new(first.image.height() as usize));
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let result: Arc<Mutex<Option<RgbaImage>>> = Arc::new(Mutex::new(None));

        let worker = {
            let (stop, height, failure, result) =
                (stop.clone(), height.clone(), failure.clone(), result.clone());

            std::thread::spawn(move || {
                let view = first.image.height() as usize;
                let mut stitcher = Stitcher::new(&first.image);

                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(INTERVAL);
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }

                    let frame = match capture.capture_region(region) {
                        Ok(frame) => frame,
                        Err(error) => {
                            *failure.lock().expect("scroll failure lock") =
                                Some(format!("Capture stopped: {error}"));
                            break;
                        }
                    };

                    match stitcher.push(&frame.image) {
                        // Nothing moved: the common case, and not worth saying.
                        Ok(Advance::None) => continue,
                        Ok(Advance::Rows(_)) => {
                            height.store(stitcher.height() as usize, Ordering::Relaxed);
                            on_progress(Progress {
                                height: stitcher.height(),
                                problem: None,
                            });
                        }
                        // A frame that will not join is not the end of the
                        // capture. The user scrolled too far in one flick; the
                        // next frame usually joins onto the same place, so this
                        // says so and carries on rather than throwing away what
                        // has been collected.
                        Err(problem) => {
                            // Unless nothing has been collected yet, in which
                            // case the frame being held is itself the problem:
                            // it caught the selection overlay on its way off the
                            // screen, and nothing will ever match it. A failed
                            // join never advances the baseline, so without this
                            // the capture sits on that one bad frame forever and
                            // never grows.
                            if stitcher.height() as usize == view {
                                stitcher = Stitcher::new(&frame.image);
                                continue;
                            }
                            on_progress(Progress {
                                height: stitcher.height(),
                                problem: Some(problem.message().to_string()),
                            });
                        }
                    }
                }

                if let Ok(joined) = stitcher.finish() {
                    *result.lock().expect("scroll result lock") = Some(joined);
                }
            })
        };

        Ok(Self {
            stop,
            height,
            failure,
            result,
            worker: Some(worker),
            region,
            scale_factor,
            origin,
        })
    }

    pub fn height(&self) -> u32 {
        self.height.load(Ordering::Relaxed) as u32
    }

    /// Stop watching and take the joined image.
    pub fn stop(mut self) -> Result<RgbaImage> {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            // The thread only ever sleeps and grabs, so this returns promptly.
            worker.join().map_err(|_| anyhow!("the capture thread panicked"))?;
        }

        if let Some(failure) = self.failure.lock().expect("scroll failure lock").take() {
            return Err(anyhow!("{failure}"));
        }

        self.result
            .lock()
            .expect("scroll result lock")
            .take()
            .ok_or_else(|| anyhow!("nothing was captured"))
    }

    /// Stop watching and throw the result away.
    pub fn cancel(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{Capture, MonitorInfo};
    use std::sync::atomic::AtomicU32;

    /// A screen that scrolls by itself, so the whole session can be exercised
    /// without a display, a window manager or a person.
    struct FakeScreen {
        page: RgbaImage,
        view: u32,
        /// How far down the page the next grab will be taken from.
        at: AtomicU32,
        step: u32,
        /// Spoil the first frame, as a window still fading off screen does.
        spoil_first: bool,
        grabs: AtomicU32,
    }

    impl ScreenCapture for FakeScreen {
        fn list_monitors(&self) -> Result<Vec<MonitorInfo>> {
            Ok(Vec::new())
        }
        fn capture_monitor(&self, _id: u32) -> Result<Capture> {
            unimplemented!("not used by a scrolling capture")
        }
        fn capture_monitor_at(&self, _point: (f64, f64)) -> Result<Capture> {
            unimplemented!("not used by a scrolling capture")
        }
        fn capture_region(&self, _region: LogicalRegion) -> Result<Capture> {
            let n = self.grabs.fetch_add(1, Ordering::Relaxed);
            let y = self.at.fetch_add(self.step, Ordering::Relaxed);
            let y = y.min(self.page.height() - self.view);
            let mut image =
                image::imageops::crop_imm(&self.page, 0, y, self.page.width(), self.view)
                    .to_image();
            if self.spoil_first && n == 0 {
                // Darkened, the way the selection overlay leaves the screen for
                // a frame or two after it is told to close.
                for pixel in image.pixels_mut() {
                    pixel.0[0] /= 4;
                    pixel.0[1] /= 4;
                    pixel.0[2] /= 4;
                }
            }
            Ok(Capture {
                image,
                scale_factor: 2.0,
                origin: (10.0, 20.0),
            })
        }
    }

    fn page(height: u32) -> RgbaImage {
        RgbaImage::from_fn(120, height, |x, y| {
            let n = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503);
            image::Rgba([(n >> 3) as u8, (n >> 11) as u8, (n >> 19) as u8, 255])
        })
    }

    fn region() -> LogicalRegion {
        LogicalRegion { x: 0.0, y: 0.0, width: 120.0, height: 300.0 }
    }

    /// The whole session: it grabs while the user scrolls, reports as it grows,
    /// and hands back one tall image.
    #[test]
    fn collects_a_scrolling_page_and_reports_as_it_goes() {
        let source = page(1500);
        let screen = Arc::new(FakeScreen {
            page: source.clone(),
            view: 300,
            at: AtomicU32::new(0),
            step: 60,
            spoil_first: false,
            grabs: AtomicU32::new(0),
        });

        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let session = Session::start(screen, region(), move |progress| {
            recorder.lock().unwrap().push(progress.height);
        })
        .expect("start");

        // Long enough for several grabs at the session's own interval.
        std::thread::sleep(INTERVAL * 12);
        let joined = session.stop().expect("stop");

        let reported = seen.lock().unwrap().clone();
        assert!(!reported.is_empty(), "progress should have been reported");
        assert!(
            reported.windows(2).all(|w| w[1] > w[0]),
            "progress should only ever grow, got {reported:?}"
        );
        assert!(
            joined.height() > 300,
            "should have collected more than one view, got {}",
            joined.height()
        );
        assert_eq!(joined.width(), 120);

        // And it is the page, not just something the right size.
        let rows = joined.height() as usize;
        assert_eq!(
            joined.as_raw()[..],
            source.as_raw()[..rows * 120 * 4],
            "the collected image must be the page it was scrolled through"
        );
    }

    /// The first frame can catch the selection overlay on its way off screen.
    ///
    /// Nothing afterwards matches it, and a failed join never advances the
    /// baseline - so without recovering, the capture sits on that one bad frame
    /// forever and never grows. That is what "it does not work" looked like.
    #[test]
    fn recovers_when_the_first_frame_caught_the_overlay() {
        let source = page(1500);
        let screen = Arc::new(FakeScreen {
            page: source.clone(),
            view: 300,
            at: AtomicU32::new(0),
            step: 60,
            spoil_first: true,
            grabs: AtomicU32::new(0),
        });

        let session = Session::start(screen, region(), |_| {}).expect("start");
        std::thread::sleep(INTERVAL * 12);
        let joined = session.stop().expect("stop");

        assert!(
            joined.height() > 300,
            "the capture should have grown past its first frame, got {}",
            joined.height()
        );
        // And the darkened frame is nowhere in the result.
        let start = 60 * 120 * 4;
        let rows = joined.height() as usize;
        assert_eq!(
            joined.as_raw()[..],
            source.as_raw()[start..start + rows * 120 * 4],
            "the result must be the page, not the darkened frame"
        );
    }

    /// Stopping without scrolling is a legitimate short capture, not an error.
    #[test]
    fn a_still_screen_gives_back_the_one_view() {
        let screen = Arc::new(FakeScreen {
            page: page(300),
            view: 300,
            at: AtomicU32::new(0),
            step: 0,
            spoil_first: false,
            grabs: AtomicU32::new(0),
        });

        let session = Session::start(screen, region(), |_| {}).expect("start");
        std::thread::sleep(INTERVAL * 3);
        let joined = session.stop().expect("stop");

        assert_eq!(joined.height(), 300, "one view, captured once");
    }

    /// The scale factor and origin of the first grab describe the whole capture,
    /// and are what the saved file is filed under.
    #[test]
    fn carries_the_geometry_of_what_it_captured() {
        let screen = Arc::new(FakeScreen {
            page: page(600),
            view: 300,
            at: AtomicU32::new(0),
            step: 30,
            spoil_first: false,
            grabs: AtomicU32::new(0),
        });

        let session = Session::start(screen, region(), |_| {}).expect("start");
        assert_eq!(session.scale_factor, 2.0);
        assert_eq!(session.origin, (10.0, 20.0));
        session.cancel();
    }

    /// Cancelling must stop the thread and keep nothing.
    #[test]
    fn cancelling_stops_the_thread() {
        let screen = Arc::new(FakeScreen {
            page: page(900),
            view: 300,
            at: AtomicU32::new(0),
            step: 30,
            spoil_first: false,
            grabs: AtomicU32::new(0),
        });

        let session = Session::start(screen, region(), |_| {}).expect("start");
        std::thread::sleep(INTERVAL * 2);
        // Returning at all is the assertion: cancel joins the worker, so this
        // hangs if the thread ignores the stop flag.
        session.cancel();
    }
}
