//! Driving the scroll wheel of another application.
//!
//! This is what turns a scrolling capture into "press once and wait". It is also
//! the only part of the app that *sends* input rather than reading the screen,
//! and macOS treats that as a separate, more serious permission than screen
//! recording.
//!
//! **Refusal is silent.** An untrusted process may post events all day; they are
//! simply dropped. There is no error to check, so the permission must be tested
//! before starting rather than inferred from nothing happening - otherwise a
//! denied capture looks exactly like a broken one, which is a failure this app
//! has already made once.

/// Sentinel the frontend recognises, so it can offer the way out rather than
/// print an error nobody can act on.
pub const NOT_PERMITTED: &str = "scroll-input-permission-denied";

/// Posting scroll wheel events to whatever is under a point on screen.
pub trait ScrollInput: Send + Sync {
    /// Whether this build may send input to other applications. Never prompts.
    fn permitted(&self) -> bool;

    /// Scroll at a point on the virtual desktop, in logical pixels.
    ///
    /// Positive `lines` scrolls the content down - that is, further into the
    /// page - matching what a user means by "scroll down" rather than what the
    /// wheel delta happens to be called.
    fn scroll(&self, at: (f64, f64), lines: i32);
}

#[cfg(target_os = "macos")]
mod platform {
    use core::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;

        fn CGEventCreateScrollWheelEvent(
            source: *const c_void,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            ...
        ) -> *mut c_void;
        fn CGEventSetLocation(event: *mut c_void, location: CGPoint);
        fn CGEventPost(tap: u32, event: *mut c_void);
        fn CFRelease(cf: *mut c_void);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    /// `kCGScrollEventUnitLine` - wheel clicks rather than pixels, which is what
    /// applications interpret as a normal mouse and therefore handle sanely.
    const UNIT_LINE: u32 = 1;
    /// `kCGHIDEventTap` - the same place a real mouse posts to, so the event is
    /// routed to whatever is under the point like any other scroll.
    const HID_TAP: u32 = 0;

    pub struct MacScrollInput;

    impl super::ScrollInput for MacScrollInput {
        fn permitted(&self) -> bool {
            unsafe { AXIsProcessTrusted() }
        }

        fn scroll(&self, at: (f64, f64), lines: i32) {
            unsafe {
                // A negative wheel delta moves the content down the page, which
                // is the opposite of how it reads, so it is flipped here once.
                let event = CGEventCreateScrollWheelEvent(
                    std::ptr::null(),
                    UNIT_LINE,
                    1,
                    -lines,
                );
                if event.is_null() {
                    return;
                }
                // The event carries where it happened; the real pointer is left
                // where the user put it.
                CGEventSetLocation(event, CGPoint { x: at.0, y: at.1 });
                CGEventPost(HID_TAP, event);
                CFRelease(event);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub struct MacScrollInput;

    impl super::ScrollInput for MacScrollInput {
        // TODO(windows): `SendInput` with `MOUSEEVENTF_WHEEL`, which needs no
        // permission - though UIPI will refuse to deliver it to a window running
        // at a higher integrity level than us.
        fn permitted(&self) -> bool {
            false
        }

        fn scroll(&self, _at: (f64, f64), _lines: i32) {}
    }
}

pub fn create_scroll_input() -> Box<dyn ScrollInput> {
    Box::new(platform::MacScrollInput)
}
