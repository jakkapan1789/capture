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
use crate::scroll_input::ScrollInput;
use crate::stitch::{Advance, Stitcher};

/// How often to grab the region.
///
/// A 900x700 region takes ~20ms to grab on this machine and ~1.5ms to join, so
/// this is a deliberate throttle rather than a limit: at 20fps someone scrolling
/// a brisk 1000px/s still leaves 650px of overlap on a 700px view, which is far
/// more than the join needs. Grabbing as fast as possible would only spend
/// battery to make an easy problem easier.
const INTERVAL: Duration = Duration::from_millis(50);

/// Wheel clicks per step when driving the scroll ourselves.
///
/// Small enough to leave most of the view overlapping even in a tall window, so
/// the join never has to work hard, and large enough that a long page does not
/// take all afternoon.
const STEP_LINES: i32 = 3;

/// How long to let the target redraw after being scrolled.
///
/// Applications scroll smoothly and lazily: capturing immediately catches the
/// animation half-finished, and the frame joins at a place the content is about
/// to leave.
const SETTLE: Duration = Duration::from_millis(120);

/// How many scrolls may do nothing before the page is deemed finished.
///
/// One is not enough - a page that is still loading, or momentum that has not
/// arrived yet, both look like the end for a moment.
const STILL_LIMIT: u32 = 4;

/// What the UI needs to show while it runs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Height of the image joined so far, in physical pixels.
    pub height: u32,
    /// Set when the last frame could not be joined, in words for the user.
    pub problem: Option<String>,
    /// True once an automatic capture has run out of page. The panel finishes
    /// on this rather than polling, so "press once and wait" really is once.
    pub done: bool,
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
    /// Set by an automatic capture when it runs out of page.
    finished: Arc<AtomicBool>,
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
                                done: false,
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
                                done: false,
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
            finished: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Scroll the target ourselves and stop at the end of the page.
    ///
    /// The difference from [`Session::start`] is only who scrolls. Reaching the
    /// bottom is what ends it: once several scrolls in a row add nothing, there
    /// is nothing left below.
    pub fn start_auto(
        capture: Arc<dyn ScreenCapture>,
        input: Arc<dyn ScrollInput>,
        region: LogicalRegion,
        mut on_progress: impl FnMut(Progress) + Send + 'static,
    ) -> Result<Self> {
        if !input.permitted() {
            return Err(anyhow!("{}", crate::scroll_input::NOT_PERMITTED));
        }

        let first = capture.capture_region(region)?;
        let scale_factor = first.scale_factor;
        let origin = first.origin;

        let stop = Arc::new(AtomicBool::new(false));
        let height = Arc::new(AtomicUsize::new(first.image.height() as usize));
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let result: Arc<Mutex<Option<RgbaImage>>> = Arc::new(Mutex::new(None));
        let finished = Arc::new(AtomicBool::new(false));

        let worker = {
            let (stop, height, failure, result, finished) = (
                stop.clone(),
                height.clone(),
                failure.clone(),
                result.clone(),
                finished.clone(),
            );
            // Scroll at the middle of the region: the edges of a window are
            // often something else - a scrollbar, a neighbouring pane - and the
            // event goes to whatever sits under the point.
            let at = (region.x + region.width / 2.0, region.y + region.height / 2.0);

            std::thread::spawn(move || {
                let view = first.image.height() as usize;
                let mut stitcher = Stitcher::new(&first.image);
                let mut still = 0u32;

                while !stop.load(Ordering::Relaxed) && still < STILL_LIMIT {
                    input.scroll(at, STEP_LINES);
                    std::thread::sleep(SETTLE);
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
                        Ok(Advance::Rows(_)) => {
                            still = 0;
                            height.store(stitcher.height() as usize, Ordering::Relaxed);
                            on_progress(Progress {
                                height: stitcher.height(),
                                problem: None,
                                done: false,
                            });
                        }
                        // Nothing moved. Either the page has ended or it has not
                        // caught up yet, and only trying again distinguishes the
                        // two.
                        Ok(Advance::None) => still += 1,
                        Err(problem) => {
                            if stitcher.height() as usize == view {
                                stitcher = Stitcher::new(&frame.image);
                                continue;
                            }
                            on_progress(Progress {
                                height: stitcher.height(),
                                problem: Some(problem.message().to_string()),
                                done: false,
                            });
                        }
                    }
                }

                finished.store(true, Ordering::Relaxed);
                if let Ok(joined) = stitcher.finish() {
                    *result.lock().expect("scroll result lock") = Some(joined);
                }
                // The one that ends it: the panel finishes on this.
                on_progress(Progress {
                    height: height.load(Ordering::Relaxed) as u32,
                    problem: None,
                    done: true,
                });
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
            finished,
        })
    }

    pub fn height(&self) -> u32 {
        self.height.load(Ordering::Relaxed) as u32
    }

    /// True once an automatic capture has reached the end of the page.
    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
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
    use crate::scroll_input::ScrollInput;
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

    /// A page that only moves when it is scrolled, and that runs out.
    struct DrivenPage {
        page: RgbaImage,
        view: u32,
        at: Arc<Mutex<u32>>,
        /// Lines the fake application moves per wheel click.
        rows_per_line: u32,
        permitted: bool,
        scrolls: Arc<AtomicU32>,
    }

    impl ScreenCapture for DrivenPage {
        fn list_monitors(&self) -> Result<Vec<MonitorInfo>> {
            Ok(Vec::new())
        }
        fn capture_monitor(&self, _id: u32) -> Result<Capture> {
            unimplemented!()
        }
        fn capture_monitor_at(&self, _p: (f64, f64)) -> Result<Capture> {
            unimplemented!()
        }
        fn capture_region(&self, _region: LogicalRegion) -> Result<Capture> {
            let y = *self.at.lock().unwrap();
            Ok(Capture {
                image: image::imageops::crop_imm(&self.page, 0, y, self.page.width(), self.view)
                    .to_image(),
                scale_factor: 1.0,
                origin: (0.0, 0.0),
            })
        }
    }

    impl ScrollInput for DrivenPage {
        fn permitted(&self) -> bool {
            self.permitted
        }
        fn scroll(&self, _at: (f64, f64), lines: i32) {
            self.scrolls.fetch_add(1, Ordering::Relaxed);
            let mut at = self.at.lock().unwrap();
            // Stops at the bottom, as any real page does.
            let bottom = self.page.height() - self.view;
            *at = (*at + lines.unsigned_abs() * self.rows_per_line).min(bottom);
        }
    }

    fn driven(page_height: u32, permitted: bool) -> Arc<DrivenPage> {
        Arc::new(DrivenPage {
            page: page(page_height),
            view: 300,
            at: Arc::new(Mutex::new(0)),
            rows_per_line: 20,
            permitted,
            scrolls: Arc::new(AtomicU32::new(0)),
        })
    }

    /// The point of the whole feature: press once, get the page.
    #[test]
    fn scrolls_the_page_itself_and_stops_at_the_bottom() {
        let screen = driven(1200, true);
        let session =
            Session::start_auto(screen.clone(), screen.clone(), region(), |_| {}).expect("start");

        // Long enough to reach the bottom and notice it has: 900 rows to cover
        // at 60 per step, plus the still-limit.
        for _ in 0..80 {
            if session.finished() {
                break;
            }
            std::thread::sleep(SETTLE / 2);
        }
        assert!(session.finished(), "should have detected the end of the page");

        let joined = session.stop().expect("stop");
        assert_eq!(
            joined.height(),
            1200,
            "the whole page, joined - got {}",
            joined.height()
        );
        assert_eq!(
            joined.as_raw(),
            screen.page.as_raw(),
            "and it must be the page itself"
        );
    }

    /// Without permission the events would vanish and the capture would sit
    /// there forever looking broken. It has to refuse up front instead.
    #[test]
    fn refuses_to_start_without_permission_to_send_input() {
        let screen = driven(1200, false);
        let error = match Session::start_auto(screen.clone(), screen, region(), |_| {}) {
            Err(error) => error,
            Ok(_) => panic!("should have refused without permission"),
        };

        assert!(
            error.to_string().contains(crate::scroll_input::NOT_PERMITTED),
            "the frontend matches on this to offer a way out, got {error}"
        );
    }

    /// A page shorter than the view has nothing to scroll, and that is a
    /// complete capture rather than a failure.
    #[test]
    fn a_page_that_fits_finishes_immediately() {
        let screen = driven(300, true);
        let session =
            Session::start_auto(screen.clone(), screen, region(), |_| {}).expect("start");

        for _ in 0..40 {
            if session.finished() {
                break;
            }
            std::thread::sleep(SETTLE / 2);
        }
        assert!(session.finished());
        assert_eq!(session.stop().expect("stop").height(), 300);
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
