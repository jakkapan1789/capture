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
                        Err(problem) => on_progress(Progress {
                            height: stitcher.height(),
                            problem: Some(problem.message().to_string()),
                        }),
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
